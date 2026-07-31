import { Buffer } from 'node:buffer';
import type { DarajaConfig } from './config.js';
import { DarajaError, normaliseError } from './errors.js';

/**
 * HTTP client for Daraja.
 *
 * Handles the three things every caller otherwise reimplements badly:
 *   1. OAuth token caching with expiry (Daraja tokens last ~3599s and the
 *      endpoint is rate limited, so re-authenticating per call gets you banned).
 *   2. Timeouts. Daraja can hang; an MCP tool that never returns is worse than
 *      one that errors.
 *   3. Retry with backoff on transient upstream failures only. Retrying a
 *      payment initiation blindly is how you double-charge someone.
 */

interface TokenCache {
  token: string;
  /** Epoch millis after which the token must be refreshed. */
  expiresAt: number;
}

export interface RequestOptions {
  /** Skip the Authorization header. Only the token endpoint needs this. */
  noAuth?: boolean;
  /** Milliseconds before the request is aborted. */
  timeoutMs?: number;
  /**
   * Whether this call is safe to retry automatically. Defaults to false.
   * Money-moving initiations must opt out; queries can opt in.
   */
  retryable?: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** Refresh slightly before true expiry to avoid a race on a long call. */
const TOKEN_SKEW_MS = 60_000;

/**
 * Synchronous success codes, which are not consistent across Daraja products.
 *
 * Most send "0". Dynamic QR sends "00". Pull Transactions sends "1000". A
 * client that only accepts "0" throws on a perfectly successful QR generation,
 * so all three are treated as success.
 *
 * Note this is the *synchronous* code space only. Callbacks use ResultCode,
 * where 0 means the money actually moved, and Ratiba's callback uses 0 while
 * its synchronous response uses 200.
 */
const SUCCESS_RESPONSE_CODES = new Set(['0', '00', '1000']);

function isSuccessResponseCode(code: unknown): boolean {
  return SUCCESS_RESPONSE_CODES.has(String(code));
}

export class DarajaClient {
  private tokenCache: TokenCache | null = null;

  constructor(
    private readonly config: DarajaConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get mode() {
    return this.config.mode;
  }

  get baseUrl() {
    return this.config.baseUrl;
  }

  /**
   * Fetch an OAuth access token, reusing the cached one while it is still valid.
   * Daraja authenticates with HTTP Basic over consumer key/secret.
   */
  async getAccessToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.tokenCache && this.now() < this.tokenCache.expiresAt) {
      return this.tokenCache.token;
    }

    const basic = Buffer.from(
      `${this.config.consumerKey}:${this.config.consumerSecret}`,
    ).toString('base64');

    const url = `${this.config.baseUrl}/oauth/v1/generate?grant_type=client_credentials`;
    const res = await this.rawFetch(url, {
      method: 'GET',
      headers: { Authorization: `Basic ${basic}` },
    }, DEFAULT_TIMEOUT_MS);

    const body = await this.parseBody(res);

    if (!res.ok) {
      throw normaliseError(res.status, body);
    }

    const b = body as { access_token?: string; expires_in?: string | number };
    if (!b.access_token) {
      throw new DarajaError({
        kind: 'auth',
        message: 'Token endpoint returned no access_token',
        httpStatus: res.status,
        raw: body,
        hint: 'Check DARAJA_CONSUMER_KEY and DARAJA_CONSUMER_SECRET match the environment in DARAJA_MODE.',
      });
    }

    // expires_in is documented as seconds and arrives as a string in practice.
    const ttlSeconds = Number(b.expires_in ?? 3599);
    this.tokenCache = {
      token: b.access_token,
      expiresAt: this.now() + Math.max(0, ttlSeconds * 1000 - TOKEN_SKEW_MS),
    };

    return b.access_token;
  }

  /** POST a JSON body to a Daraja path, with auth applied. */
  async post<T = unknown>(
    path: string,
    body: unknown,
    opts: RequestOptions = {},
  ): Promise<T> {
    return this.request<T>('POST', path, body, opts);
  }

  /** GET a Daraja path, with auth applied. */
  async get<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>('GET', path, undefined, opts);
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    opts: RequestOptions,
  ): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.config.baseUrl}${path}`;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (!opts.noAuth) {
      headers.Authorization = `Bearer ${await this.getAccessToken()}`;
    }

    const maxAttempts = opts.retryable ? 3 : 1;
    // A stale token is not a failure of the request, so the re-authentication
    // retry is tracked separately from the transient-error budget. Folding it
    // into `attempt` would consume the only attempt a non-retryable call has.
    let reauthUsed = false;
    let attempt = 0;

    while (attempt < maxAttempts) {
      attempt += 1;

      const res = await this.rawFetch(
        url,
        {
          method,
          headers,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        },
        timeoutMs,
      );

      const parsed = await this.parseBody(res);

      if (res.ok) {
        // Daraja returns HTTP 200 with a non-zero ResponseCode for some
        // failures, so a 200 alone is not success.
        const rc = (parsed as Record<string, unknown> | null)?.ResponseCode;
        if (rc !== undefined && !isSuccessResponseCode(rc)) {
          throw normaliseError(res.status, parsed);
        }
        return parsed as T;
      }

      // A 401 usually means the cached token went stale early. Refresh and
      // replay once, without spending an attempt.
      if (res.status === 401 && !opts.noAuth && !reauthUsed) {
        reauthUsed = true;
        attempt -= 1;
        await this.getAccessToken(true);
        headers.Authorization = `Bearer ${this.tokenCache?.token ?? ''}`;
        continue;
      }

      const error = normaliseError(res.status, parsed);

      const transient = error.kind === 'upstream' || error.kind === 'rate_limit';
      if (!transient || attempt >= maxAttempts) {
        throw error;
      }

      // Exponential backoff: 500ms, then 1000ms.
      await this.sleep(500 * 2 ** (attempt - 1));
    }

    // Unreachable: every path above either returns or throws.
    throw new DarajaError({
      kind: 'unknown',
      message: `Request to ${url} exhausted all attempts without a result`,
    });
  }

  private async rawFetch(
    url: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new DarajaError({
          kind: 'timeout',
          message: `Request to ${url} timed out after ${timeoutMs}ms`,
          hint: 'Daraja was slow to respond. For payment initiations, query the transaction status before retrying.',
        });
      }
      throw new DarajaError({
        kind: 'upstream',
        message: err instanceof Error ? err.message : String(err),
        raw: err,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Daraja occasionally returns HTML or an empty body on failure. */
  private async parseBody(res: Response): Promise<unknown> {
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
