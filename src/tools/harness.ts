import { DarajaClient } from '../client.js';
import { CallbackReceiver } from '../callbacks/receiver.js';
import { loadConfig, type DarajaConfig } from '../config.js';
import type { ToolContext } from './context.js';

/**
 * Test harness shared by the tool test suites.
 *
 * Lives in src/ rather than a test file so every suite builds its context the
 * same way, and so the captured-request assertions all read alike.
 */

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, any> | null;
}

export interface Harness {
  ctx: ToolContext;
  /** Every request the client made, in order. */
  requests: CapturedRequest[];
  /** The most recent request body, which is what most assertions care about. */
  lastBody: () => Record<string, any>;
  /** Queue a response for the next non-auth call. */
  reply: (body: unknown, status?: number) => void;
}

/**
 * Build a ToolContext backed by a stub fetch, so tool handlers can be tested
 * for exactly what they put on the wire without a server involved.
 */
export function makeHarness(
  overrides: Partial<DarajaConfig> = {},
  opts: { receiver?: CallbackReceiver | null } = {},
): Harness {
  const requests: CapturedRequest[] = [];
  const queued: Array<{ body: unknown; status: number }> = [];

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const rawBody = init?.body;

    requests.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof rawBody === 'string' ? JSON.parse(rawBody) : null,
    });

    // The token endpoint is called transparently by the client; always satisfy it.
    if (url.includes('/oauth/v1/generate')) {
      return new Response(JSON.stringify({ access_token: 'test-token', expires_in: '3599' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const next = queued.shift() ?? { body: { ResponseCode: '0', ok: true }, status: 200 };
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const config: DarajaConfig = {
    ...loadConfig({
      DARAJA_MODE: 'sandbox',
      DARAJA_CONSUMER_KEY: 'key',
      DARAJA_CONSUMER_SECRET: 'secret',
      DARAJA_BASE_URL: 'https://sandbox.test',
      DARAJA_SHORTCODE: '174379',
      DARAJA_PASSKEY: 'test-passkey',
      DARAJA_INITIATOR_NAME: 'testapi',
      DARAJA_SECURITY_CREDENTIAL: 'encrypted-credential',
    } as NodeJS.ProcessEnv),
    ...overrides,
  };

  const client = new DarajaClient(config, fetchImpl);

  // A stand-in receiver: enough surface for URL generation and health
  // reporting, without binding a socket. Suites that exercise waiting on a
  // callback pass a real receiver instead.
  const receiver =
    opts.receiver === undefined
      ? ({
          urlFor: (kind: string) => `https://callbacks.test/cb/${kind}`,
          baseUrl: () => 'https://callbacks.test',
          store: { size: 0 },
          stats: { received: 0, rejectedIp: 0, rejectedPath: 0, malformed: 0 },
        } as unknown as CallbackReceiver)
      : opts.receiver;

  return {
    ctx: { client, config, receiver },
    requests,
    lastBody: () => {
      const business = requests.filter((r) => !r.url.includes('/oauth/'));
      const last = business[business.length - 1];
      if (!last?.body) throw new Error('No request body captured');
      return last.body;
    },
    reply: (body: unknown, status = 200) => queued.push({ body, status }),
  };
}
