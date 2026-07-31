import { describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { DarajaClient } from './client.js';
import { loadConfig, type DarajaConfig } from './config.js';
import { DarajaError } from './errors.js';

function config(overrides: Partial<DarajaConfig> = {}): DarajaConfig {
  return {
    ...loadConfig({
      DARAJA_MODE: 'sandbox',
      DARAJA_CONSUMER_KEY: 'key',
      DARAJA_CONSUMER_SECRET: 'secret',
      DARAJA_BASE_URL: 'https://sandbox.test',
    } as NodeJS.ProcessEnv),
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const token = () => jsonResponse({ access_token: 'tok', expires_in: '3599' });

describe('authentication', () => {
  it('sends HTTP Basic credentials to the token endpoint', async () => {
    const fetchImpl = vi.fn(async () => token());
    const client = new DarajaClient(config(), fetchImpl as unknown as typeof fetch);

    await client.getAccessToken();

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const header = (init.headers as Record<string, string>).Authorization;
    expect(header).toMatch(/^Basic /);
    expect(Buffer.from(header.slice(6), 'base64').toString()).toBe('key:secret');
  });

  it('reuses a cached token until it nears expiry', async () => {
    const fetchImpl = vi.fn(async () => token());
    const client = new DarajaClient(config(), fetchImpl as unknown as typeof fetch);

    await client.getAccessToken();
    await client.getAccessToken();
    // The token endpoint is rate limited, so this must not re-authenticate.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refreshes once the cached token has expired', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: 'tok', expires_in: '60' }));
    let now = 1_000_000;
    const client = new DarajaClient(
      config(),
      fetchImpl as unknown as typeof fetch,
      () => now,
    );

    await client.getAccessToken();
    // expires_in 60s minus the 60s safety skew means it is already stale.
    now += 1000;
    await client.getAccessToken();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('honours a forced refresh', async () => {
    const fetchImpl = vi.fn(async () => token());
    const client = new DarajaClient(config(), fetchImpl as unknown as typeof fetch);

    await client.getAccessToken();
    await client.getAccessToken(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('raises an auth error when the token endpoint rejects the credentials', async () => {
    const fetchImpl = async () =>
      jsonResponse({ errorCode: '400.008.01', errorMessage: 'Invalid Authentication passed' }, 400);
    const client = new DarajaClient(config(), fetchImpl as unknown as typeof fetch);

    await expect(client.getAccessToken()).rejects.toBeInstanceOf(DarajaError);
  });

  it('raises an auth error when the response carries no token', async () => {
    const fetchImpl = async () => jsonResponse({ unexpected: true });
    const client = new DarajaClient(config(), fetchImpl as unknown as typeof fetch);

    await expect(client.getAccessToken()).rejects.toMatchObject({ kind: 'auth' });
  });

  it('defaults the token lifetime when expires_in is absent', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: 'tok' }));
    const client = new DarajaClient(config(), fetchImpl as unknown as typeof fetch);

    await client.getAccessToken();
    await client.getAccessToken();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('requests', () => {
  it('attaches the bearer token to business calls', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes('/oauth/') ? token() : jsonResponse({ ResponseCode: '0' }),
    );
    const client = new DarajaClient(config(), fetchImpl as unknown as typeof fetch);

    await client.post('/mpesa/stkpush/v1/processrequest', { Amount: 1 });

    const [, init] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('supports GET without a body', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes('/oauth/') ? token() : jsonResponse({ ok: true }),
    );
    const client = new DarajaClient(config(), fetchImpl as unknown as typeof fetch);

    await client.get('/some/path');
    const [, init] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });

  it('accepts an absolute URL unchanged', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes('/oauth/') ? token() : jsonResponse({ ok: true }),
    );
    const client = new DarajaClient(config(), fetchImpl as unknown as typeof fetch);

    await client.get('https://elsewhere.test/thing');
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('https://elsewhere.test/thing');
  });

  it.each([
    ['0', 'most products'],
    ['00', 'dynamic QR'],
    ['1000', 'pull transactions'],
  ])('treats ResponseCode %s as success (%s)', async (code) => {
    const fetchImpl = async (url: string) =>
      url.includes('/oauth/') ? token() : jsonResponse({ ResponseCode: code, data: 'ok' });
    const client = new DarajaClient(config(), fetchImpl as unknown as typeof fetch);

    // Accepting only "0" makes a successful QR generation look like a failure.
    await expect(client.post('/mpesa/qrcode/v1/generate', {})).resolves.toMatchObject({
      data: 'ok',
    });
  });

  it('treats a genuinely failing ResponseCode as an error', async () => {
    const fetchImpl = async (url: string) =>
      url.includes('/oauth/')
        ? token()
        : jsonResponse({ ResponseCode: '1', ResponseDescription: 'Insufficient funds' });
    const client = new DarajaClient(config(), fetchImpl as unknown as typeof fetch);

    await expect(client.post('/x', {})).rejects.toMatchObject({ kind: 'insufficient_funds' });
  });

  it('passes through a response with no ResponseCode at all', async () => {
    const fetchImpl = async (url: string) =>
      url.includes('/oauth/') ? token() : jsonResponse({ header: { responseCode: 200 } });
    const client = new DarajaClient(config(), fetchImpl as unknown as typeof fetch);

    await expect(client.post('/x', {})).resolves.toBeTruthy();
  });

  it('re-authenticates once on a 401 and retries', async () => {
    let businessCalls = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/oauth/')) return token();
      businessCalls += 1;
      // First attempt sees an expired token, second succeeds.
      return businessCalls === 1
        ? jsonResponse({ errorCode: '404.001.03' }, 401)
        : jsonResponse({ ResponseCode: '0' });
    });
    const client = new DarajaClient(config(), fetchImpl as unknown as typeof fetch);

    await expect(client.post('/x', {})).resolves.toBeTruthy();
    expect(businessCalls).toBe(2);
  });

  it('gives up on a persistent 401', async () => {
    const fetchImpl = async (url: string) =>
      url.includes('/oauth/') ? token() : jsonResponse({ errorCode: '404.001.03' }, 401);
    const client = new DarajaClient(config(), fetchImpl as unknown as typeof fetch);

    await expect(client.post('/x', {})).rejects.toMatchObject({ kind: 'validation' });
  });

  it('does not retry a non-retryable call on a server error', async () => {
    let calls = 0;
    const fetchImpl = async (url: string) => {
      if (url.includes('/oauth/')) return token();
      calls += 1;
      return jsonResponse({ errorCode: '500.001.1001' }, 500);
    };
    const client = new DarajaClient(config(), fetchImpl as unknown as typeof fetch);

    // Retrying a payment initiation blindly is how you double-charge someone.
    await expect(client.post('/x', {})).rejects.toBeInstanceOf(DarajaError);
    expect(calls).toBe(1);
  });

  it('retries a retryable call on a server error', async () => {
    let calls = 0;
    const fetchImpl = async (url: string) => {
      if (url.includes('/oauth/')) return token();
      calls += 1;
      return calls < 3
        ? jsonResponse({ errorCode: '500.001.1001' }, 500)
        : jsonResponse({ ResponseCode: '0' });
    };
    const client = new DarajaClient(config(), fetchImpl as unknown as typeof fetch);

    await expect(client.get('/x', { retryable: true })).resolves.toBeTruthy();
    expect(calls).toBe(3);
  });

  it('stops retrying after the attempt budget is spent', async () => {
    let calls = 0;
    const fetchImpl = async (url: string) => {
      if (url.includes('/oauth/')) return token();
      calls += 1;
      return jsonResponse({ errorCode: '500.001.1001' }, 500);
    };
    const client = new DarajaClient(config(), fetchImpl as unknown as typeof fetch);

    // Real backoff between attempts is 500ms then 1000ms.
    await expect(client.get('/x', { retryable: true })).rejects.toBeInstanceOf(DarajaError);
    expect(calls).toBe(3);
  }, 10_000);

  it('does not retry a client error even when retryable', async () => {
    let calls = 0;
    const fetchImpl = async (url: string) => {
      if (url.includes('/oauth/')) return token();
      calls += 1;
      return jsonResponse({ errorCode: '400.002.02' }, 400);
    };
    const client = new DarajaClient(config(), fetchImpl as unknown as typeof fetch);

    await expect(client.get('/x', { retryable: true })).rejects.toBeInstanceOf(DarajaError);
    expect(calls).toBe(1);
  });
});

describe('transport failures', () => {
  it('reports a timeout as a typed error with guidance', async () => {
    // Never resolves, so only the client's own abort ends the request.
    const fetchImpl = async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    const client = new DarajaClient(config(), fetchImpl as unknown as typeof fetch);

    const error = await client
      .post('/x', {}, { timeoutMs: 50, noAuth: true })
      .catch((e: unknown) => e);

    expect(error).toMatchObject({ kind: 'timeout' });
    // A payment that timed out must be queried, not blindly resent.
    expect((error as DarajaError).hint).toContain('status');
  });

  it('wraps a network failure as an upstream error', async () => {
    const fetchImpl = async () => {
      throw new Error('ECONNREFUSED');
    };
    const client = new DarajaClient(config(), fetchImpl as unknown as typeof fetch);

    await expect(client.getAccessToken()).rejects.toMatchObject({ kind: 'upstream' });
  });

  it('wraps a non-Error throw', async () => {
    const fetchImpl = async () => {
      throw 'a string';
    };
    const client = new DarajaClient(config(), fetchImpl as unknown as typeof fetch);

    await expect(client.getAccessToken()).rejects.toMatchObject({ kind: 'upstream' });
  });

  it('surfaces a non-JSON body rather than crashing', async () => {
    const fetchImpl = async (url: string) =>
      url.includes('/oauth/')
        ? token()
        : new Response('<html>Gateway Timeout</html>', { status: 504 });
    const client = new DarajaClient(config(), fetchImpl as unknown as typeof fetch);

    // Daraja sometimes returns an HTML error page from its gateway.
    await expect(client.post('/x', {})).rejects.toMatchObject({ kind: 'upstream' });
  });

  it('handles an empty body', async () => {
    const fetchImpl = async (url: string) =>
      url.includes('/oauth/') ? token() : new Response('', { status: 200 });
    const client = new DarajaClient(config(), fetchImpl as unknown as typeof fetch);

    await expect(client.post('/x', {})).resolves.toBeNull();
  });
});

describe('accessors', () => {
  it('exposes the mode and base URL', () => {
    const client = new DarajaClient(config());
    expect(client.mode).toBe('sandbox');
    expect(client.baseUrl).toBe('https://sandbox.test');
  });
});
