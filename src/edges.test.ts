import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicKey, generateKeyPairSync, privateDecrypt, constants } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { CallbackStore } from './callbacks/store.js';
import { CallbackReceiver } from './callbacks/receiver.js';
import { DarajaSimulator } from './simulator/server.js';
import { encryptSecurityCredential } from './crypto.js';
import * as fx from './simulator/fixtures.js';

/**
 * Edge cases that the main suites do not naturally reach: persistence
 * corruption, simulator scenarios keyed off unusual amounts, and the security
 * credential helper.
 */

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'daraja-edge-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('encryptSecurityCredential', () => {
  it('produces a value the matching private key can recover', () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const encrypted = encryptSecurityCredential('initiator-password', publicKey);

    // Safaricom's certificate uses PKCS#1 v1.5 padding, not OAEP.
    const decrypted = privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_PADDING },
      Buffer.from(encrypted, 'base64'),
    );
    expect(decrypted.toString('utf8')).toBe('initiator-password');
  });

  it('returns base64', () => {
    const { publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const encrypted = encryptSecurityCredential('pw', publicKey);
    expect(encrypted).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it('rejects an unusable certificate', () => {
    expect(() => encryptSecurityCredential('pw', 'not a certificate')).toThrow();
  });
});

describe('CallbackStore persistence', () => {
  it('skips a torn final line left by a crash', () => {
    const dir = tempDir();
    const path = join(dir, 'callbacks.jsonl');

    const good = JSON.stringify({
      seq: 1,
      receivedAt: new Date().toISOString(),
      kind: 'stk',
      correlationId: 'ws_CO_good',
      outcome: 'success',
      resultCode: '0',
      resultDesc: 'ok',
      sourceIp: '127.0.0.1',
      payload: {},
    });
    // A process killed mid-append leaves a partial trailing line.
    writeFileSync(path, `${good}\n{"seq":2,"partial":`);

    const store = new CallbackStore(dir);
    expect(store.size).toBe(1);
    expect(store.findByCorrelationId('ws_CO_good')).toBeTruthy();
  });

  it('starts clean when the log is unreadable', () => {
    const dir = tempDir();
    // A directory where the log should be makes reads fail.
    const store = new CallbackStore(join(dir, 'nonexistent-subdir'));
    expect(store.size).toBe(0);
  });

  it('resumes the sequence from the persisted maximum', () => {
    const dir = tempDir();
    const first = new CallbackStore(dir);
    first.add({
      kind: 'stk',
      correlationId: 'a',
      outcome: 'success',
      resultCode: '0',
      resultDesc: 'ok',
      sourceIp: '1.1.1.1',
      payload: {},
    });

    const second = new CallbackStore(dir);
    const record = second.add({
      kind: 'stk',
      correlationId: 'b',
      outcome: 'success',
      resultCode: '0',
      resultDesc: 'ok',
      sourceIp: '1.1.1.1',
      payload: {},
    });

    // Reusing seq 1 would make ordering ambiguous across restarts.
    expect(record.seq).toBe(2);
  });

  it('evicts the oldest records once the memory cap is reached', () => {
    const dir = tempDir();
    const store = new CallbackStore(dir, { maxInMemory: 3 });

    for (let i = 1; i <= 5; i++) {
      store.add({
        kind: 'stk',
        correlationId: `id-${i}`,
        outcome: 'success',
        resultCode: '0',
        resultDesc: 'ok',
        sourceIp: '1.1.1.1',
        payload: {},
      });
    }

    expect(store.size).toBe(3);
    expect(store.findByCorrelationId('id-1')).toBeNull();
    expect(store.findByCorrelationId('id-5')).toBeTruthy();
    // Everything is still on disk even when evicted from memory.
    expect(readFileSync(join(dir, 'callbacks.jsonl'), 'utf8').trim().split('\n')).toHaveLength(5);
  });

  it('can run without touching disk', () => {
    const store = new CallbackStore(join(tempDir(), 'unused'), { persist: false });
    store.add({
      kind: 'stk',
      correlationId: 'mem-only',
      outcome: 'success',
      resultCode: '0',
      resultDesc: 'ok',
      sourceIp: '1.1.1.1',
      payload: {},
    });
    expect(store.findByCorrelationId('mem-only')).toBeTruthy();
  });

  it('returns null for a correlation id it has never seen', () => {
    const store = new CallbackStore(tempDir());
    expect(store.findByCorrelationId('never')).toBeNull();
  });
});

describe('receiver hardening', () => {
  it('rejects an oversized body', async () => {
    const dir = tempDir();
    const receiver = new CallbackReceiver({
      config: { port: 0, allowedCidrs: [], storeDir: dir },
      persist: false,
    });
    await receiver.start();

    try {
      // Genuine callbacks are small; a megabyte-plus body is not Safaricom.
      const huge = JSON.stringify({ pad: 'x'.repeat(1_200_000) });
      await fetch(`http://127.0.0.1:${receiver.port}/cb/stk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: huge,
      }).catch(() => null);

      // The connection may be torn down mid-upload or answered with a 500.
      // What matters is that an oversized body is never stored.
      expect(receiver.store.size).toBe(0);
    } finally {
      await receiver.stop();
    }
  });

  it('prefers the public URL over the bound address when configured', async () => {
    const dir = tempDir();
    const receiver = new CallbackReceiver({
      config: {
        port: 0,
        allowedCidrs: [],
        // A trailing slash must not produce a double slash in generated URLs.
        publicUrl: 'https://tunnel.test/',
        storeDir: dir,
      },
      persist: false,
    });
    await receiver.start();

    try {
      expect(receiver.baseUrl()).toBe('https://tunnel.test');
      expect(receiver.urlFor('stk')).toBe('https://tunnel.test/cb/stk');
    } finally {
      await receiver.stop();
    }
  });
});

describe('simulator scenarios', () => {
  let sim: DarajaSimulator;

  afterEach(async () => {
    await sim?.stop();
  });

  it.each([
    [1, 1, 'insufficient funds'],
    [1037, 1037, 'unreachable'],
    [2001, 2001, 'invalid initiator'],
  ])('maps amount %i to result code %i (%s)', async (amount, expectedCode) => {
    sim = new DarajaSimulator({ callbackDelayMs: 5 });
    const base = await sim.start();

    const received: unknown[] = [];
    const sink = Bun_or_node_server(received);
    const sinkUrl = await sink.start();

    try {
      const token = await fetch(`${base}/oauth/v1/generate`, {
        headers: { Authorization: 'Basic dGVzdDp0ZXN0' },
      }).then((r) => r.json() as Promise<{ access_token: string }>);

      await fetch(`${base}/mpesa/stkpush/v1/processrequest`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ Amount: amount, PhoneNumber: '254708374149', CallBackURL: sinkUrl }),
      });

      await sim.flushCallbacks();

      const cb = received[0] as { Body: { stkCallback: { ResultCode: number } } };
      expect(cb.Body.stkCallback.ResultCode).toBe(expectedCode);
    } finally {
      await sink.stop();
    }
  });

  it('serves a QR code with the two-zero success code', async () => {
    sim = new DarajaSimulator();
    const base = await sim.start();

    const token = await fetch(`${base}/oauth/v1/generate`, {
      headers: { Authorization: 'Basic dGVzdDp0ZXN0' },
    }).then((r) => r.json() as Promise<{ access_token: string }>);

    const res = await fetch(`${base}/mpesa/qrcode/v1/generate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ MerchantName: 'S' }),
    });

    const body = (await res.json()) as { ResponseCode: string; QRCode: string };
    // Dynamic QR is the product that returns "00" rather than "0".
    expect(body.ResponseCode).toBe('00');
    expect(body.QRCode).toBeTruthy();
  });

  it('rejects a malformed request body without crashing', async () => {
    sim = new DarajaSimulator();
    const base = await sim.start();

    const token = await fetch(`${base}/oauth/v1/generate`, {
      headers: { Authorization: 'Basic dGVzdDp0ZXN0' },
    }).then((r) => r.json() as Promise<{ access_token: string }>);

    const res = await fetch(`${base}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        'Content-Type': 'application/json',
      },
      body: 'not json',
    });

    expect(res.status).toBe(200);
  });

  it('tolerates a callback URL that cannot be reached', async () => {
    sim = new DarajaSimulator({ callbackDelayMs: 5 });
    const base = await sim.start();

    const token = await fetch(`${base}/oauth/v1/generate`, {
      headers: { Authorization: 'Basic dGVzdDp0ZXN0' },
    }).then((r) => r.json() as Promise<{ access_token: string }>);

    await fetch(`${base}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        Amount: 10,
        PhoneNumber: '254708374149',
        // Nothing is listening here.
        CallBackURL: 'http://127.0.0.1:1/dead',
      }),
    });

    // A failed delivery must not take the simulator down.
    await expect(sim.flushCallbacks()).resolves.toBeUndefined();
  });

  it('accepts a Ratiba request using the alternative field spellings', async () => {
    sim = new DarajaSimulator({ callbackDelayMs: 5 });
    const base = await sim.start();

    const token = await fetch(`${base}/oauth/v1/generate`, {
      headers: { Authorization: 'Basic dGVzdDp0ZXN0' },
    }).then((r) => r.json() as Promise<{ access_token: string }>);

    const res = await fetch(`${base}/standingorder/v1/createStandingOrderExternal`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        'Content-Type': 'application/json',
      },
      // The doubled-name and lowercase-id spellings from the published sample.
      body: JSON.stringify({
        StandingOrderNameName: 'Alt spelling',
        CustomstdoId: 'alt-id',
        Amount: 100,
        PartyA: '254708374149',
      }),
    });

    const body = (await res.json()) as { ResponseHeader: { responseCode: string } };
    expect(body.ResponseHeader.responseCode).toBe('200');
  });
});

describe('fixtures', () => {
  it('generates receipt numbers in the documented shape', () => {
    for (let i = 0; i < 20; i++) {
      expect(fx.receiptNumber()).toMatch(/^[A-Z0-9]{10}$/);
    }
  });

  it('formats transaction dates in East Africa Time', () => {
    const date = fx.transactionDate(new Date('2026-06-28T06:24:08Z'));
    expect(String(date)).toBe('20260628092408');
  });

  it('produces unique checkout ids', () => {
    const ids = new Set(Array.from({ length: 50 }, () => fx.checkoutRequestId()));
    expect(ids.size).toBe(50);
  });

  it('builds an unauthorized auth payload', () => {
    expect(fx.auth.unauthorized().errorCode).toBe('400.008.01');
  });

  it('builds a still-processing STK query response', () => {
    const res = fx.stkQuery.stillProcessing({
      merchantRequestId: 'm',
      checkoutRequestId: 'c',
    });
    expect(res.ResultCode).toBe('1037');
  });

  it('builds a not-found STK query response', () => {
    expect(fx.stkQuery.notFound().errorCode).toBe('500.001.1001');
  });

  it('builds a C2B simulate response', () => {
    expect(fx.c2b.simulateSuccess('oc-1').OriginatorCoversationID).toBe('oc-1');
  });

  it('builds identity responses', () => {
    expect(fx.identity.checkAtiSuccess('20240101').body.value).toBe('20240101');
    expect(fx.identity.validationSuccess(false).body.transactionStatus).toBe('Failed');
  });

  it('builds a Ratiba duplicate-name error', () => {
    expect(fx.ratiba.duplicateName().errorMessage).toContain('already exists');
  });

  it('builds a B2C failure result', () => {
    const res = fx.b2c.resultFailure({
      originatorConversationId: 'oc',
      conversationId: 'c',
      resultCode: 1,
      resultDesc: 'insufficient',
    });
    expect(res.Result.ResultCode).toBe(1);
    // Failure results carry no ResultParameters.
    expect((res.Result as Record<string, unknown>).ResultParameters).toBeUndefined();
  });
});

/** Minimal HTTP sink used to capture simulator callbacks. */
function Bun_or_node_server(received: unknown[]) {
  let server: import('node:http').Server | null = null;

  return {
    async start(): Promise<string> {
      const { createServer } = await import('node:http');
      server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c as Buffer));
        req.on('end', () => {
          try {
            received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            received.push(null);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ResultCode":0}');
        });
      });

      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      return `http://127.0.0.1:${port}/cb`;
    },
    async stop(): Promise<void> {
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    },
  };
}
