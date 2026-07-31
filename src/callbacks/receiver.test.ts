import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CallbackReceiver } from './receiver.js';
import { correlationIdOf, kindOf, outcomeOf } from './store.js';
import * as fx from '../simulator/fixtures.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'daraja-cb-'));
}

describe('payload interpretation', () => {
  it('extracts the STK correlation id and success outcome', () => {
    const payload = fx.stkPush.callbackSuccess({
      merchantRequestId: 'mr-1',
      checkoutRequestId: 'ws_CO_123',
      amount: 100,
      phone: '254708374149',
    });
    expect(correlationIdOf(payload)).toBe('ws_CO_123');
    expect(kindOf(payload)).toBe('stk');
    expect(outcomeOf(payload)).toMatchObject({ outcome: 'success', resultCode: '0' });
  });

  it('reads a failure outcome from an STK callback with no metadata', () => {
    const payload = fx.stkPush.callbackFailure({
      merchantRequestId: 'mr-2',
      checkoutRequestId: 'ws_CO_456',
      resultCode: 1032,
      resultDesc: 'Request cancelled by user',
    });
    expect(outcomeOf(payload)).toMatchObject({
      outcome: 'failure',
      resultCode: '1032',
      resultDesc: 'Request cancelled by user',
    });
  });

  it('treats the Ratiba lowercase envelope with code 0 as success', () => {
    const payload = fx.ratiba.callbackSuccess({
      responseRefId: 'resp-1',
      requestRefId: 'req-1',
      standingOrderName: 'Gym',
      amount: 500,
      msisdn: '254708374149',
    });
    expect(kindOf(payload)).toBe('ratiba');
    // Correlates on the client-generated id, which is what the caller knows.
    expect(correlationIdOf(payload)).toBe('req-1');
    expect(outcomeOf(payload).outcome).toBe('success');
  });

  it('treats the Ratiba capitalised failure envelope as failure', () => {
    const payload = fx.ratiba.callbackFailure({
      responseRefId: 'resp-2',
      requestRefId: 'req-2',
      reason: 'Something went wrong',
    });
    expect(kindOf(payload)).toBe('ratiba');
    expect(outcomeOf(payload)).toMatchObject({ outcome: 'failure', resultCode: '1037' });
  });

  it('classifies a balance result by its parameters, not the path', () => {
    const payload = fx.accountBalance.resultSuccess({
      originatorConversationId: 'oc-1',
      conversationId: 'c-1',
    });
    expect(kindOf(payload)).toBe('balance');
    expect(correlationIdOf(payload)).toBe('c-1');
  });

  it('returns unknown for an unrecognised shape', () => {
    expect(kindOf({ hello: 'world' })).toBe('unknown');
    expect(correlationIdOf({ hello: 'world' })).toBeNull();
    expect(outcomeOf({ hello: 'world' }).outcome).toBe('unknown');
  });

  it('does not throw on null or primitive payloads', () => {
    expect(correlationIdOf(null)).toBeNull();
    expect(correlationIdOf('string')).toBeNull();
  });
});

describe('CallbackReceiver', () => {
  let dir: string;
  let receiver: CallbackReceiver;
  let base: string;

  beforeEach(async () => {
    dir = tempDir();
    receiver = new CallbackReceiver({
      config: {
        port: 0,
        allowedCidrs: [],
        storeDir: dir,
      },
      persist: true,
    });
    base = await receiver.start();
  });

  afterEach(async () => {
    await receiver.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${receiver.port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  it('serves a health endpoint', async () => {
    const res = await fetch(`http://127.0.0.1:${receiver.port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok' });
  });

  it('accepts a callback and acknowledges in the shape Daraja expects', async () => {
    const payload = fx.stkPush.callbackSuccess({
      merchantRequestId: 'mr-1',
      checkoutRequestId: 'ws_CO_accept',
      amount: 50,
      phone: '254708374149',
    });

    const res = await post('/cb/stk', payload);
    expect(res.status).toBe(200);
    // Anything other than this and Safaricom retries the delivery.
    expect(await res.json()).toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });

    const stored = receiver.store.findByCorrelationId('ws_CO_accept');
    expect(stored?.outcome).toBe('success');
  });

  it('rejects unknown paths', async () => {
    const res = await post('/not-a-callback', {});
    expect(res.status).toBe(404);
    expect(receiver.stats.rejectedPath).toBe(1);
  });

  it('rejects GET', async () => {
    const res = await fetch(`http://127.0.0.1:${receiver.port}/cb/stk`);
    expect(res.status).toBe(405);
  });

  it('acknowledges malformed JSON rather than triggering a retry storm', async () => {
    const res = await fetch(`http://127.0.0.1:${receiver.port}/cb/stk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json at all',
    });
    expect(res.status).toBe(200);
    expect(receiver.stats.malformed).toBe(1);
  });

  it('resolves a waiter when the matching callback arrives', async () => {
    const pending = receiver.waitFor('ws_CO_wait', 5000);

    await post(
      '/cb/stk',
      fx.stkPush.callbackSuccess({
        merchantRequestId: 'mr-2',
        checkoutRequestId: 'ws_CO_wait',
        amount: 75,
        phone: '254708374149',
      }),
    );

    const record = await pending;
    expect(record?.correlationId).toBe('ws_CO_wait');
    expect(record?.outcome).toBe('success');
  });

  it('resolves immediately when the callback already arrived', async () => {
    await post(
      '/cb/stk',
      fx.stkPush.callbackSuccess({
        merchantRequestId: 'mr-3',
        checkoutRequestId: 'ws_CO_early',
        amount: 20,
        phone: '254708374149',
      }),
    );

    // The race Daraja actually exhibits: callback lands before we start waiting.
    const record = await receiver.waitFor('ws_CO_early', 100);
    expect(record?.correlationId).toBe('ws_CO_early');
  });

  it('resolves to null when the wait times out', async () => {
    const record = await receiver.waitFor('ws_CO_never', 40);
    expect(record).toBeNull();
  });

  it('lists callbacks newest first and filters by kind', async () => {
    await post('/cb/stk', fx.stkPush.callbackSuccess({
      merchantRequestId: 'a', checkoutRequestId: 'ws_CO_a', amount: 1, phone: '254708374149',
    }));
    await post('/cb/ratiba', fx.ratiba.callbackSuccess({
      responseRefId: 'r', requestRefId: 'req-list', standingOrderName: 'X', amount: 2, msisdn: '254708374149',
    }));

    const all = receiver.store.list();
    expect(all[0]?.kind).toBe('ratiba');
    expect(receiver.store.list({ kind: 'stk' })).toHaveLength(1);
  });

  it('persists callbacks across a restart', async () => {
    await post('/cb/stk', fx.stkPush.callbackSuccess({
      merchantRequestId: 'p', checkoutRequestId: 'ws_CO_persist', amount: 9, phone: '254708374149',
    }));
    await receiver.stop();

    // A restart must not lose the record of money that already moved.
    const revived = new CallbackReceiver({
      config: { port: 0, allowedCidrs: [], storeDir: dir },
      persist: true,
    });
    expect(revived.store.findByCorrelationId('ws_CO_persist')?.outcome).toBe('success');
  });
});

describe('CallbackReceiver source verification', () => {
  let dir: string;
  let receiver: CallbackReceiver;

  beforeEach(async () => {
    dir = tempDir();
    receiver = new CallbackReceiver({
      config: {
        port: 0,
        // Only Safaricom may post here.
        allowedCidrs: ['196.201.214.200/32'],
        storeDir: dir,
      },
      trustProxy: true,
      persist: false,
    });
    await receiver.start();
  });

  afterEach(async () => {
    await receiver.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a callback from an unauthorised source', async () => {
    // Loopback is not in the allowlist, and no forwarded header is set.
    const res = await fetch(`http://127.0.0.1:${receiver.port}/cb/stk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Body: { stkCallback: { ResultCode: 0 } } }),
    });

    expect(res.status).toBe(403);
    expect(receiver.stats.rejectedIp).toBe(1);
    expect(receiver.store.size).toBe(0);
  });

  it('accepts a callback forwarded from an allowed source', async () => {
    const res = await fetch(`http://127.0.0.1:${receiver.port}/cb/stk`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '196.201.214.200',
      },
      body: JSON.stringify(
        fx.stkPush.callbackSuccess({
          merchantRequestId: 'mr-ok',
          checkoutRequestId: 'ws_CO_ok',
          amount: 10,
          phone: '254708374149',
        }),
      ),
    });

    expect(res.status).toBe(200);
    expect(receiver.store.findByCorrelationId('ws_CO_ok')).toBeTruthy();
  });
});

describe('CallbackReceiver path secret', () => {
  let dir: string;
  let receiver: CallbackReceiver;

  beforeEach(async () => {
    dir = tempDir();
    receiver = new CallbackReceiver({
      config: {
        port: 0,
        allowedCidrs: [],
        pathSecret: 's3cr3t-path-token',
        storeDir: dir,
      },
      persist: false,
    });
    await receiver.start();
  });

  afterEach(async () => {
    await receiver.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('includes the secret in generated URLs', () => {
    expect(receiver.urlFor('stk')).toContain('/cb/s3cr3t-path-token/stk');
  });

  it('accepts a callback carrying the correct secret', async () => {
    const res = await fetch(
      `http://127.0.0.1:${receiver.port}/cb/s3cr3t-path-token/stk`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          fx.stkPush.callbackSuccess({
            merchantRequestId: 'm', checkoutRequestId: 'ws_CO_secret', amount: 5, phone: '254708374149',
          }),
        ),
      },
    );
    expect(res.status).toBe(200);
    expect(receiver.store.findByCorrelationId('ws_CO_secret')).toBeTruthy();
  });

  it.each([['wrong-secret'], [''], ['s3cr3t-path-toke']])(
    'rejects the wrong secret (%s)',
    async (secret) => {
      const res = await fetch(`http://127.0.0.1:${receiver.port}/cb/${secret}/stk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ Body: { stkCallback: { ResultCode: 0 } } }),
      });
      expect(res.status).not.toBe(200);
      expect(receiver.store.size).toBe(0);
    },
  );
});
