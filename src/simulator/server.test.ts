import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { DarajaSimulator } from './server.js';
import { DarajaClient } from '../client.js';
import { loadConfig } from '../config.js';
import { DarajaError } from '../errors.js';

/** Minimal sink that records callbacks the simulator pushes to us. */
async function startCallbackSink(): Promise<{
  url: string;
  received: unknown[];
  close: () => Promise<void>;
}> {
  const received: unknown[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      try {
        received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        received.push(null);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ResultCode: 0, ResultDesc: 'Accepted' }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    url: `http://127.0.0.1:${port}/callback`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('DarajaSimulator', () => {
  let sim: DarajaSimulator;
  let baseUrl: string;
  let client: DarajaClient;

  beforeEach(async () => {
    sim = new DarajaSimulator({ callbackDelayMs: 5 });
    baseUrl = await sim.start();
    const config = loadConfig({
      DARAJA_MODE: 'sandbox',
      DARAJA_CONSUMER_KEY: 'test-key',
      DARAJA_CONSUMER_SECRET: 'test-secret',
      DARAJA_BASE_URL: baseUrl,
    } as NodeJS.ProcessEnv);
    client = new DarajaClient(config);
  });

  afterEach(async () => {
    await sim.stop();
  });

  describe('authorization', () => {
    it('issues an access token for valid Basic auth', async () => {
      const token = await client.getAccessToken();
      expect(token).toMatch(/^sim_/);
    });

    it('caches the token across calls', async () => {
      const first = await client.getAccessToken();
      const second = await client.getAccessToken();
      expect(second).toBe(first);
    });

    it('issues a new token when forced to refresh', async () => {
      const first = await client.getAccessToken();
      const second = await client.getAccessToken(true);
      expect(second).not.toBe(first);
    });

    it('rejects requests with no bearer token', async () => {
      const res = await fetch(`${baseUrl}/mpesa/stkpush/v1/processrequest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ Amount: 1 }),
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { errorCode: string };
      expect(body.errorCode).toBe('404.001.03');
    });
  });

  describe('STK push', () => {
    it('accepts a push and returns the documented shape', async () => {
      const res = await client.post<Record<string, string>>(
        '/mpesa/stkpush/v1/processrequest',
        { Amount: 100, PhoneNumber: '254708374149' },
      );
      expect(res.ResponseCode).toBe('0');
      expect(res.CheckoutRequestID).toMatch(/^ws_CO_/);
      expect(res.MerchantRequestID).toBeTruthy();
      expect(res.CustomerMessage).toContain('accepted for processing');
    });

    it('delivers a success callback with metadata', async () => {
      const sink = await startCallbackSink();
      try {
        await client.post('/mpesa/stkpush/v1/processrequest', {
          Amount: 100,
          PhoneNumber: '254708374149',
          CallBackURL: sink.url,
        });
        await sim.flushCallbacks();

        expect(sink.received).toHaveLength(1);
        const cb = sink.received[0] as {
          Body: { stkCallback: { ResultCode: number; CallbackMetadata: { Item: Array<{ Name: string; Value: unknown }> } } };
        };
        expect(cb.Body.stkCallback.ResultCode).toBe(0);

        const items = cb.Body.stkCallback.CallbackMetadata.Item;
        const names = items.map((i) => i.Name);
        expect(names).toContain('MpesaReceiptNumber');
        expect(names).toContain('Amount');
        expect(names).toContain('PhoneNumber');
        expect(names).toContain('TransactionDate');
      } finally {
        await sink.close();
      }
    });

    it('omits CallbackMetadata on a failure callback', async () => {
      const sink = await startCallbackSink();
      try {
        // Amount 1032 triggers the "cancelled by user" scenario.
        await client.post('/mpesa/stkpush/v1/processrequest', {
          Amount: 1032,
          PhoneNumber: '254708374149',
          CallBackURL: sink.url,
        });
        await sim.flushCallbacks();

        const cb = sink.received[0] as {
          Body: { stkCallback: { ResultCode: number; ResultDesc: string; CallbackMetadata?: unknown } };
        };
        expect(cb.Body.stkCallback.ResultCode).toBe(1032);
        expect(cb.Body.stkCallback.ResultDesc).toBe('Request cancelled by user');
        // Real Daraja omits this on failure. Code that reads it blindly breaks.
        expect(cb.Body.stkCallback.CallbackMetadata).toBeUndefined();
      } finally {
        await sink.close();
      }
    });

    it('surfaces a typed error for the simulated upstream failure', async () => {
      await expect(
        client.post('/mpesa/stkpush/v1/processrequest', { Amount: 9999 }),
      ).rejects.toBeInstanceOf(DarajaError);
    });
  });

  describe('M-Pesa Ratiba', () => {
    it('accepts a standing order with the capitalised envelope', async () => {
      const res = await client.post<{ ResponseHeader: { responseCode: string; responseRefID: string } }>(
        '/standingorder/v1/createStandingOrderExternal',
        {
          StandingOrderName: 'Gym membership',
          Amount: 500,
          PartyA: '254708374149',
          Frequency: '5',
          CustomStoId: 'test-uuid-1',
        },
      );
      // Sync response uses "200", not "0".
      expect(res.ResponseHeader.responseCode).toBe('200');
      expect(res.ResponseHeader.responseRefID).toBeTruthy();
    });

    it('delivers a lowercase-envelope callback with responseCode 0', async () => {
      const sink = await startCallbackSink();
      try {
        await client.post('/standingorder/v1/createStandingOrderExternal', {
          StandingOrderName: 'Gym membership',
          Amount: 500,
          PartyA: '254708374149',
          Frequency: '5',
          CustomStoId: 'test-uuid-2',
          CallBackURL: sink.url,
        });
        await sim.flushCallbacks();

        const cb = sink.received[0] as {
          responseHeader: { responseCode: string; requestRefID: string };
          responseBody: { responseData: Array<{ name: string; value: string }> };
        };
        // The casing flips between sync and callback, and so does the code space.
        expect(cb.responseHeader.responseCode).toBe('0');
        expect(cb.responseHeader.requestRefID).toBe('test-uuid-2');

        const byName = Object.fromEntries(cb.responseBody.responseData.map((d) => [d.name, d.value]));
        expect(byName.status).toBe('ACTIVE');
        expect(byName.reminderScheduleId).toBeTruthy();
        // Safaricom masks the MSISDN.
        expect(byName.Msisdn).toMatch(/^\*+\d{3}$/);
      } finally {
        await sink.close();
      }
    });

    it('rejects a duplicate standing order name', async () => {
      await expect(
        client.post('/standingorder/v1/createStandingOrderExternal', {
          StandingOrderName: 'duplicate order',
          Amount: 500,
          PartyA: '254708374149',
        }),
      ).rejects.toMatchObject({ kind: 'validation' });
    });
  });

  describe('async product family', () => {
    it('acknowledges B2C and pushes a result with a receipt', async () => {
      const sink = await startCallbackSink();
      try {
        const ack = await client.post<{ ResponseCode: string; ConversationID: string }>(
          '/mpesa/b2c/v3/paymentrequest',
          { Amount: 250, PartyB: '254708374149', ResultURL: sink.url },
        );
        expect(ack.ResponseCode).toBe('0');
        expect(ack.ConversationID).toBeTruthy();

        await sim.flushCallbacks();
        const cb = sink.received[0] as {
          Result: { ResultCode: number; ResultParameters: { ResultParameter: Array<{ Key: string }> } };
        };
        expect(cb.Result.ResultCode).toBe(0);
        expect(cb.Result.ResultParameters.ResultParameter.map((p) => p.Key)).toContain(
          'TransactionReceipt',
        );
      } finally {
        await sink.close();
      }
    });

    it('returns the pipe-delimited balance string for account balance', async () => {
      const sink = await startCallbackSink();
      try {
        await client.post('/mpesa/accountbalance/v1/query', { ResultURL: sink.url });
        await sim.flushCallbacks();

        const cb = sink.received[0] as {
          Result: { ResultParameters: { ResultParameter: Array<{ Key: string; Value: unknown }> } };
        };
        const balance = cb.Result.ResultParameters.ResultParameter.find(
          (p) => p.Key === 'AccountBalance',
        );
        // Daraja returns balances as a pipe-delimited string, not a number.
        expect(String(balance?.Value)).toContain('|KES|');
      } finally {
        await sink.close();
      }
    });
  });

  it('404s with a Daraja-shaped error for unknown paths', async () => {
    await expect(client.get('/mpesa/does-not-exist')).rejects.toMatchObject({
      kind: 'not_found',
    });
  });
});
