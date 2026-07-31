import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Durable callback storage.
 *
 * Every other MCP server in this space keeps callbacks in a Map, which means a
 * restart loses the result of a payment that already moved real money. This is
 * an append-only JSON Lines log: crash-safe, greppable, and replayable.
 */

export type CallbackKind =
  | 'stk'
  | 'b2c'
  | 'b2b'
  | 'balance'
  | 'status'
  | 'reversal'
  | 'ratiba'
  | 'c2b-validation'
  | 'c2b-confirmation'
  | 'timeout'
  | 'unknown';

export interface CallbackRecord {
  /** Monotonic id within this process, for stable ordering in listings. */
  seq: number;
  receivedAt: string;
  kind: CallbackKind;
  /**
   * The correlation id extracted from the payload. Which field this comes from
   * differs per product, so extraction is centralised in `correlationIdOf`.
   */
  correlationId: string | null;
  /** Whether the callback reports success, derived from the product's own code space. */
  outcome: 'success' | 'failure' | 'unknown';
  resultCode: string | null;
  resultDesc: string | null;
  sourceIp: string;
  payload: unknown;
}

/**
 * Pull the correlation id out of a callback, whichever product it came from.
 *
 * Daraja uses a different field per product, and Ratiba even changes the casing
 * of its envelope between the sync response and the callback.
 */
export function correlationIdOf(payload: unknown): string | null {
  const p = payload as Record<string, any>;
  if (!p || typeof p !== 'object') return null;

  // STK push
  const stk = p.Body?.stkCallback;
  if (stk) return stk.CheckoutRequestID ?? stk.MerchantRequestID ?? null;

  // B2C / B2B / balance / status / reversal all share the Result envelope.
  const result = p.Result;
  if (result) return result.ConversationID ?? result.OriginatorConversationID ?? null;

  // Ratiba, either casing.
  const header = p.responseHeader ?? p.ResponseHeader;
  if (header) return header.requestRefID ?? header.responseRefID ?? null;

  // C2B confirmation/validation
  if (p.TransID) return String(p.TransID);

  return null;
}

/** Classify a callback by shape, since the URL path alone can be spoofed. */
export function kindOf(payload: unknown, pathHint?: string): CallbackKind {
  const p = payload as Record<string, any>;
  if (p?.Body?.stkCallback) return 'stk';
  if (p?.responseHeader || p?.ResponseHeader) return 'ratiba';
  if (p?.TransactionType || p?.TransID) {
    return pathHint?.includes('validation') ? 'c2b-validation' : 'c2b-confirmation';
  }
  if (p?.Result) {
    const params: Array<{ Key?: string }> =
      p.Result.ResultParameters?.ResultParameter ?? [];
    if (params.some((x) => x?.Key === 'AccountBalance')) return 'balance';
    if (pathHint?.includes('b2c')) return 'b2c';
    if (pathHint?.includes('b2b')) return 'b2b';
    if (pathHint?.includes('reversal')) return 'reversal';
    if (pathHint?.includes('status')) return 'status';
    return 'unknown';
  }
  if (pathHint?.includes('timeout')) return 'timeout';
  return 'unknown';
}

/**
 * Extract the result code and decide success.
 *
 * The code spaces genuinely differ: STK and the Result envelope treat 0 as
 * success, while Ratiba's synchronous ack uses 200 and its callback uses 0.
 */
export function outcomeOf(payload: unknown): {
  outcome: CallbackRecord['outcome'];
  resultCode: string | null;
  resultDesc: string | null;
} {
  const p = payload as Record<string, any>;

  const stk = p?.Body?.stkCallback;
  if (stk) {
    const code = String(stk.ResultCode ?? '');
    return {
      outcome: code === '0' ? 'success' : 'failure',
      resultCode: code || null,
      resultDesc: stk.ResultDesc ?? null,
    };
  }

  if (p?.Result) {
    const code = String(p.Result.ResultCode ?? '');
    return {
      outcome: code === '0' ? 'success' : 'failure',
      resultCode: code || null,
      resultDesc: p.Result.ResultDesc ?? null,
    };
  }

  const header = p?.responseHeader ?? p?.ResponseHeader;
  if (header) {
    const code = String(header.responseCode ?? '');
    // Ratiba: "0" in the callback, "200" in the sync ack. Accept both as success.
    return {
      outcome: code === '0' || code === '200' ? 'success' : 'failure',
      resultCode: code || null,
      resultDesc: header.responseDescription ?? null,
    };
  }

  return { outcome: 'unknown', resultCode: null, resultDesc: null };
}

export class CallbackStore {
  private records: CallbackRecord[] = [];
  private seq = 0;
  private readonly logPath: string;
  private readonly maxInMemory: number;

  constructor(dir: string, opts: { maxInMemory?: number; persist?: boolean } = {}) {
    this.maxInMemory = opts.maxInMemory ?? 1000;
    this.logPath = join(dir, 'callbacks.jsonl');

    if (opts.persist !== false) {
      mkdirSync(dir, { recursive: true });
      this.hydrate();
    }
  }

  /** Reload prior callbacks so a restart does not lose settled payments. */
  private hydrate(): void {
    if (!existsSync(this.logPath)) return;
    try {
      const lines = readFileSync(this.logPath, 'utf8').split('\n').filter(Boolean);
      for (const line of lines.slice(-this.maxInMemory)) {
        try {
          const rec = JSON.parse(line) as CallbackRecord;
          this.records.push(rec);
          this.seq = Math.max(this.seq, rec.seq);
        } catch {
          // A torn final line after a crash is expected; skip it.
        }
      }
    } catch {
      // An unreadable log must not stop the server from accepting new callbacks.
    }
  }

  add(input: Omit<CallbackRecord, 'seq' | 'receivedAt'>): CallbackRecord {
    this.seq += 1;
    const record: CallbackRecord = {
      ...input,
      seq: this.seq,
      receivedAt: new Date().toISOString(),
    };

    this.records.push(record);
    if (this.records.length > this.maxInMemory) {
      this.records.splice(0, this.records.length - this.maxInMemory);
    }

    try {
      appendFileSync(this.logPath, `${JSON.stringify(record)}\n`);
    } catch {
      // Losing durability is bad but dropping the callback entirely is worse.
    }

    return record;
  }

  /** Most recent first. */
  list(opts: { limit?: number; kind?: CallbackKind } = {}): CallbackRecord[] {
    const limit = opts.limit ?? 20;
    let out = [...this.records].reverse();
    if (opts.kind) out = out.filter((r) => r.kind === opts.kind);
    return out.slice(0, limit);
  }

  findByCorrelationId(id: string): CallbackRecord | null {
    for (let i = this.records.length - 1; i >= 0; i--) {
      const rec = this.records[i];
      if (rec && rec.correlationId === id) return rec;
    }
    return null;
  }

  get size(): number {
    return this.records.length;
  }
}
