import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CallbackReceiver, matchesExpectation } from './receiver.js';
import * as fx from '../simulator/fixtures.js';

/**
 * A callback's correlation id is read out of its own body, so on its own it
 * proves only that the sender knew the id. Binding a wait to the amount that
 * was requested stops a callback reporting a different sum from settling a
 * payment as though it were the real result.
 */

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'daraja-hijack-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('matchesExpectation', () => {
  const stk = (amount: number) =>
    fx.stkPush.callbackSuccess({
      merchantRequestId: 'm',
      checkoutRequestId: 'c',
      amount,
      phone: '254712345678',
    });

  it('accepts a callback reporting the amount that was requested', () => {
    expect(matchesExpectation(stk(100), { amount: 100 })).toBe(true);
  });

  it('rejects one reporting a different amount', () => {
    expect(matchesExpectation(stk(999999), { amount: 100 })).toBe(false);
  });

  it('accepts anything when no expectation was given', () => {
    expect(matchesExpectation(stk(999999), undefined)).toBe(true);
    expect(matchesExpectation(stk(999999), {})).toBe(true);
  });

  it('accepts a failure callback, which carries no amount', () => {
    // A declined payment reports no metadata. The caller still needs to hear
    // that it failed, so absence of an amount must not block settlement.
    const failure = fx.stkPush.callbackFailure({
      merchantRequestId: 'm',
      checkoutRequestId: 'c',
      resultCode: 1032,
      resultDesc: 'Request cancelled by user',
    });
    expect(matchesExpectation(failure, { amount: 100 })).toBe(true);
  });

  it('reads the amount from the B2C result envelope', () => {
    const result = fx.b2c.resultSuccess({
      originatorConversationId: 'oc',
      conversationId: 'c',
      amount: 250,
      phone: '254712345678',
    });
    expect(matchesExpectation(result, { amount: 250 })).toBe(true);
    expect(matchesExpectation(result, { amount: 1 })).toBe(false);
  });

  it('reads the amount from a Ratiba callback', () => {
    const ratiba = fx.ratiba.callbackSuccess({
      responseRefId: 'r',
      requestRefId: 'q',
      standingOrderName: 'Gym',
      amount: 500,
      msisdn: '254712345678',
    });
    // Ratiba reports "500.00" as a string.
    expect(matchesExpectation(ratiba, { amount: 500 })).toBe(true);
    expect(matchesExpectation(ratiba, { amount: 5 })).toBe(false);
  });

  it('reads the amount from a C2B confirmation', () => {
    expect(matchesExpectation({ TransID: 'X', TransAmount: '75' }, { amount: 75 })).toBe(true);
    expect(matchesExpectation({ TransID: 'X', TransAmount: '75' }, { amount: 76 })).toBe(false);
  });

  it('accepts a payload with no recognisable amount', () => {
    expect(matchesExpectation({ something: 'else' }, { amount: 100 })).toBe(true);
  });
});

describe('a mismatched callback cannot settle a payment', () => {
  let receiver: CallbackReceiver;

  beforeEach(async () => {
    receiver = new CallbackReceiver({
      config: { port: 0, allowedCidrs: [], storeDir: tempDir(), trustProxy: false },
      persist: false,
    });
    await receiver.start();
  });

  afterEach(async () => {
    await receiver.stop();
  });

  const send = (payload: unknown) =>
    fetch(`http://127.0.0.1:${receiver.port}/cb/stk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

  it('leaves the wait pending when the amount contradicts the request', async () => {
    const pending = receiver.waitFor('ws_CO_victim', 200, { amount: 100 });

    // The attack: a callback claiming a far larger sum against a real payment.
    await send(
      fx.stkPush.callbackSuccess({
        merchantRequestId: 'attacker',
        checkoutRequestId: 'ws_CO_victim',
        amount: 999999,
        phone: '254712345678',
      }),
    );

    expect(await pending).toBeNull();
    expect(receiver.stats.mismatched).toBe(1);
  });

  it('still stores the mismatched callback for inspection', async () => {
    const pending = receiver.waitFor('ws_CO_stored', 100, { amount: 100 });
    await send(
      fx.stkPush.callbackSuccess({
        merchantRequestId: 'm',
        checkoutRequestId: 'ws_CO_stored',
        amount: 5,
        phone: '254712345678',
      }),
    );
    await pending;

    // Discarding it would hide the discrepancy from anyone investigating.
    expect(receiver.store.findByCorrelationId('ws_CO_stored')).toBeTruthy();
  });

  it('settles when the amount agrees', async () => {
    const pending = receiver.waitFor('ws_CO_good', 2000, { amount: 100 });
    await send(
      fx.stkPush.callbackSuccess({
        merchantRequestId: 'm',
        checkoutRequestId: 'ws_CO_good',
        amount: 100,
        phone: '254712345678',
      }),
    );

    const record = await pending;
    expect(record?.outcome).toBe('success');
    expect(receiver.stats.mismatched).toBe(0);
  });

  it('settles a genuine failure even though it carries no amount', async () => {
    const pending = receiver.waitFor('ws_CO_declined', 2000, { amount: 100 });
    await send(
      fx.stkPush.callbackFailure({
        merchantRequestId: 'm',
        checkoutRequestId: 'ws_CO_declined',
        resultCode: 1032,
        resultDesc: 'Request cancelled by user',
      }),
    );

    const record = await pending;
    expect(record?.outcome).toBe('failure');
    expect(record?.resultCode).toBe('1032');
  });

  it('settles only the waiters a callback actually matches', async () => {
    // Two callers waiting on the same id for different sums; at most one is
    // the genuine counterpart.
    const hundred = receiver.waitFor('ws_CO_shared', 2000, { amount: 100 });
    const thousand = receiver.waitFor('ws_CO_shared', 200, { amount: 1000 });

    await send(
      fx.stkPush.callbackSuccess({
        merchantRequestId: 'm',
        checkoutRequestId: 'ws_CO_shared',
        amount: 100,
        phone: '254712345678',
      }),
    );

    expect((await hundred)?.outcome).toBe('success');
    expect(await thousand).toBeNull();
  });
});
