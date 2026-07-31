import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import type { CallbackConfig } from '../config.js';
import { isAllowedSource, resolveClientIp } from './ip.js';
import { CallbackStore, correlationIdOf, kindOf, outcomeOf, type CallbackRecord } from './store.js';

/**
 * Inbound callback receiver.
 *
 * Solves the problem that makes Daraja awkward for an agent: the API returns
 * "accepted" immediately, but whether money actually moved arrives minutes
 * later on a webhook. A tool that returns the acknowledgement has told the
 * model almost nothing.
 *
 * So alongside storing callbacks, this registers *waiters*: a tool can await
 * the settled result of the request it just made, with a timeout, and return
 * the real outcome instead of a promise to look it up later.
 */

interface Waiter {
  correlationId: string;
  resolve: (record: CallbackRecord) => void;
  timer: NodeJS.Timeout;
}

export interface ReceiverOptions {
  config: CallbackConfig;
  /** Trust X-Forwarded-For. Required behind ngrok or a load balancer. */
  trustProxy?: boolean;
  onLog?: (message: string) => void;
  /** Disable disk persistence. Used by tests. */
  persist?: boolean;
}

export class CallbackReceiver {
  readonly store: CallbackStore;
  private server: Server | null = null;
  private waiters = new Map<string, Waiter[]>();
  private boundPort = 0;
  private readonly config: CallbackConfig;
  private readonly trustProxy: boolean;
  private readonly onLog: (message: string) => void;

  /** Counters surfaced by the health tool, useful when debugging a silent integration. */
  readonly stats = { received: 0, rejectedIp: 0, rejectedPath: 0, malformed: 0 };

  constructor(opts: ReceiverOptions) {
    this.config = opts.config;
    this.trustProxy = opts.trustProxy ?? true;
    this.onLog = opts.onLog ?? (() => {});
    this.store = new CallbackStore(this.config.storeDir, { persist: opts.persist });
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch(() => {
        this.respond(res, 500, { ResultCode: 1, ResultDesc: 'Internal error' });
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.config.port, resolve);
    });

    const addr = this.server.address();
    this.boundPort = typeof addr === 'object' && addr ? addr.port : this.config.port;
    this.onLog(`Callback receiver listening on port ${this.boundPort}`);
    return this.baseUrl();
  }

  async stop(): Promise<void> {
    for (const list of this.waiters.values()) {
      for (const w of list) clearTimeout(w.timer);
    }
    this.waiters.clear();

    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
  }

  get port(): number {
    return this.boundPort;
  }

  /** Public base URL Safaricom should call, falling back to localhost. */
  baseUrl(): string {
    const base = this.config.publicUrl?.replace(/\/+$/, '');
    return base ?? `http://127.0.0.1:${this.boundPort}`;
  }

  /**
   * URL for a given callback type, including the path secret when configured.
   * An unguessable path is cheap defence in depth alongside the IP allowlist.
   */
  urlFor(kind: string): string {
    const secret = this.config.pathSecret;
    return secret
      ? `${this.baseUrl()}/cb/${secret}/${kind}`
      : `${this.baseUrl()}/cb/${kind}`;
  }

  /**
   * Wait for the callback matching `correlationId`.
   *
   * Resolves immediately if it already arrived, which matters because Daraja
   * sometimes delivers the callback before the synchronous response finishes
   * being parsed.
   */
  waitFor(correlationId: string, timeoutMs: number): Promise<CallbackRecord | null> {
    const existing = this.store.findByCorrelationId(correlationId);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.removeWaiter(correlationId, waiter);
        resolve(null);
      }, timeoutMs);

      // Do not hold the event loop open purely for a pending waiter.
      timer.unref?.();

      const waiter: Waiter = { correlationId, resolve, timer };
      const list = this.waiters.get(correlationId) ?? [];
      list.push(waiter);
      this.waiters.set(correlationId, list);
    });
  }

  private removeWaiter(correlationId: string, waiter: Waiter): void {
    const list = this.waiters.get(correlationId);
    if (!list) return;
    const idx = list.indexOf(waiter);
    if (idx >= 0) list.splice(idx, 1);
    if (list.length === 0) this.waiters.delete(correlationId);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    // Health endpoint, deliberately unauthenticated and side-effect free.
    if (url.pathname === '/health') {
      return this.respond(res, 200, { status: 'ok', stored: this.store.size, ...this.stats });
    }

    if (req.method !== 'POST') {
      return this.respond(res, 405, { ResultCode: 1, ResultDesc: 'Method not allowed' });
    }

    const clientIp = resolveClientIp(
      req.socket.remoteAddress,
      req.headers['x-forwarded-for'] as string | undefined,
      this.trustProxy,
    );

    if (!isAllowedSource(clientIp, this.config.allowedCidrs)) {
      this.stats.rejectedIp += 1;
      this.onLog(`Rejected callback from unauthorised source ${clientIp}`);
      // Deliberately terse: do not tell an attacker why they were refused.
      return this.respond(res, 403, { ResultCode: 1, ResultDesc: 'Forbidden' });
    }

    const segments = url.pathname.split('/').filter(Boolean);
    if (segments[0] !== 'cb') {
      this.stats.rejectedPath += 1;
      return this.respond(res, 404, { ResultCode: 1, ResultDesc: 'Not found' });
    }

    let kindHint: string;
    if (this.config.pathSecret) {
      const provided = segments[1] ?? '';
      if (!this.secretMatches(provided)) {
        this.stats.rejectedPath += 1;
        this.onLog('Rejected callback with an invalid path secret');
        return this.respond(res, 403, { ResultCode: 1, ResultDesc: 'Forbidden' });
      }
      kindHint = segments[2] ?? 'unknown';
    } else {
      kindHint = segments[1] ?? 'unknown';
    }

    let raw: string;
    try {
      raw = await this.readBody(req);
    } catch {
      // Oversized body. Reply and close rather than leaving the socket open:
      // the client is still uploading, so without an explicit close the
      // response is never flushed and the request hangs until it times out.
      this.stats.malformed += 1;
      this.onLog('Rejected an oversized callback body');

      const payload = JSON.stringify({ ResultCode: 1, ResultDesc: 'Payload too large' });
      res.writeHead(413, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Connection: 'close',
      });
      res.end(payload);
      req.destroy();
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      this.stats.malformed += 1;
      this.onLog(`Malformed callback body on /${segments.join('/')}`);
      // Still acknowledge: Safaricom retries on non-2xx, and replaying a body
      // we cannot parse achieves nothing.
      return this.respond(res, 200, { ResultCode: 0, ResultDesc: 'Accepted' });
    }

    const { outcome, resultCode, resultDesc } = outcomeOf(payload);
    const record = this.store.add({
      kind: kindOf(payload, kindHint),
      correlationId: correlationIdOf(payload),
      outcome,
      resultCode,
      resultDesc,
      sourceIp: clientIp,
      payload,
    });

    this.stats.received += 1;
    this.onLog(
      `Callback ${record.kind} ${record.outcome} ${record.correlationId ?? '(no id)'}`,
    );

    if (record.correlationId) {
      const list = this.waiters.get(record.correlationId);
      if (list) {
        this.waiters.delete(record.correlationId);
        for (const w of list) {
          clearTimeout(w.timer);
          w.resolve(record);
        }
      }
    }

    // Daraja expects this acknowledgement shape. Anything else and it retries.
    this.respond(res, 200, { ResultCode: 0, ResultDesc: 'Accepted' });
  }

  /** Constant-time comparison so the secret cannot be recovered by timing. */
  private secretMatches(provided: string): boolean {
    const expected = this.config.pathSecret ?? '';
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  private async readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      // Callbacks are small; anything large is not from Safaricom.
      if (size > 1_000_000) throw new Error('Callback body too large');
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  private respond(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  }
}
