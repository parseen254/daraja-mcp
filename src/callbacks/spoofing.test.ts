import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CallbackReceiver } from './receiver.js';
import { loadConfig, SAFARICOM_CIDRS } from '../config.js';
import * as fx from '../simulator/fixtures.js';

/**
 * Daraja callbacks are unsigned. The source address is the only thing that
 * distinguishes a real payment result from one an attacker made up, so these
 * tests exist to prove the allowlist cannot be talked around.
 */

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'daraja-spoof-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const forgedSuccess = (id: string) =>
  fx.stkPush.callbackSuccess({
    merchantRequestId: 'forged',
    checkoutRequestId: id,
    amount: 100000,
    phone: '254712345678',
  });

describe('X-Forwarded-For cannot be used to impersonate Safaricom', () => {
  let receiver: CallbackReceiver;

  beforeEach(async () => {
    receiver = new CallbackReceiver({
      config: {
        port: 0,
        allowedCidrs: SAFARICOM_CIDRS,
        storeDir: tempDir(),
        trustProxy: false,
      },
      // Default, stated explicitly: this is the configuration that matters.
      persist: false,
    });
    await receiver.start();
  });

  afterEach(async () => {
    await receiver.stop();
  });

  const post = (headers: Record<string, string>, id = 'ws_CO_forged') =>
    fetch(`http://127.0.0.1:${receiver.port}/cb/stk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(forgedSuccess(id)),
    });

  it('rejects a forged header claiming a Safaricom address', async () => {
    const res = await post({ 'X-Forwarded-For': '196.201.214.200' });

    expect(res.status).toBe(403);
    expect(receiver.stats.rejectedIp).toBe(1);
    // The decisive assertion: a payment that never happened must not be stored.
    expect(receiver.store.size).toBe(0);
    expect(receiver.store.findByCorrelationId('ws_CO_forged')).toBeNull();
  });

  it.each([
    ['196.201.214.200, 10.0.0.1', 'leading genuine address'],
    ['10.0.0.1, 196.201.214.200', 'trailing genuine address'],
    ['196.201.214.200,196.201.214.206', 'two genuine addresses'],
    ['::ffff:196.201.214.200', 'IPv4-mapped IPv6'],
    ['  196.201.214.200  ', 'padded with whitespace'],
  ])('rejects a forged chain (%s)', async (header) => {
    const res = await post({ 'X-Forwarded-For': header });
    expect(res.status).toBe(403);
    expect(receiver.store.size).toBe(0);
  });

  it('rejects other forwarding headers too', async () => {
    const res = await post({
      'X-Real-IP': '196.201.214.200',
      Forwarded: 'for=196.201.214.200',
      'CF-Connecting-IP': '196.201.214.200',
    });

    expect(res.status).toBe(403);
    expect(receiver.store.size).toBe(0);
  });

  it('does not resolve a pending waiter from a forged callback', async () => {
    // The dangerous version of this bug: a forged callback settling a real
    // stk_push_and_wait, so the caller believes an unpaid order was paid.
    const pending = receiver.waitFor('ws_CO_realpayment', 250);
    await post({ 'X-Forwarded-For': '196.201.214.200' }, 'ws_CO_realpayment');

    expect(await pending).toBeNull();
  });
});

describe('X-Forwarded-For is honoured only when a proxy is trusted', () => {
  let receiver: CallbackReceiver;

  beforeEach(async () => {
    receiver = new CallbackReceiver({
      config: {
        port: 0,
        allowedCidrs: SAFARICOM_CIDRS,
        storeDir: tempDir(),
        trustProxy: true,
      },
      trustProxy: true,
      persist: false,
    });
    await receiver.start();
  });

  afterEach(async () => {
    await receiver.stop();
  });

  it('accepts a forwarded genuine address when explicitly enabled', async () => {
    const res = await fetch(`http://127.0.0.1:${receiver.port}/cb/stk`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '196.201.214.200',
      },
      body: JSON.stringify(forgedSuccess('ws_CO_tunnelled')),
    });

    expect(res.status).toBe(200);
    expect(receiver.store.findByCorrelationId('ws_CO_tunnelled')).toBeTruthy();
  });

  it('still rejects a forwarded address outside the allowlist', async () => {
    const res = await fetch(`http://127.0.0.1:${receiver.port}/cb/stk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '8.8.8.8' },
      body: JSON.stringify(forgedSuccess('ws_CO_bad')),
    });

    expect(res.status).toBe(403);
  });
});

describe('trustProxy configuration', () => {
  it('is off unless the environment opts in', () => {
    expect(loadConfig({} as NodeJS.ProcessEnv).callback.trustProxy).toBe(false);
  });

  it.each(['1', 'true', 'yes'])('is enabled by DARAJA_TRUST_PROXY=%s', (value) => {
    const config = loadConfig({ DARAJA_TRUST_PROXY: value } as NodeJS.ProcessEnv);
    expect(config.callback.trustProxy).toBe(true);
  });

  it('stays off for other values', () => {
    const config = loadConfig({ DARAJA_TRUST_PROXY: 'maybe' } as NodeJS.ProcessEnv);
    expect(config.callback.trustProxy).toBe(false);
  });
});

describe('empty allowlist cannot be produced by accident', () => {
  it.each([
    ['', 'empty string'],
    ['   ', 'whitespace'],
    [',,,', 'commas only'],
    [' , , ', 'commas and spaces'],
  ])('rejects DARAJA_CALLBACK_CIDRS set to %s (%s)', (value) => {
    // Previously this parsed to [], which the receiver reads as "accept all".
    expect(() =>
      loadConfig({
        DARAJA_MODE: 'production',
        DARAJA_CONSUMER_KEY: 'k',
        DARAJA_CONSUMER_SECRET: 's',
        DARAJA_CALLBACK_CIDRS: value,
      } as NodeJS.ProcessEnv),
    ).toThrowError(/no usable ranges/);
  });

  it('falls back to the published ranges when unset', () => {
    const config = loadConfig({
      DARAJA_MODE: 'production',
      DARAJA_CONSUMER_KEY: 'k',
      DARAJA_CONSUMER_SECRET: 's',
    } as NodeJS.ProcessEnv);

    expect(config.callback.allowedCidrs).toEqual(SAFARICOM_CIDRS);
  });

  it('accepts a genuine override', () => {
    const config = loadConfig({
      DARAJA_MODE: 'production',
      DARAJA_CONSUMER_KEY: 'k',
      DARAJA_CONSUMER_SECRET: 's',
      DARAJA_CALLBACK_CIDRS: '196.201.214.200/32, 10.0.0.0/8',
    } as NodeJS.ProcessEnv);

    expect(config.callback.allowedCidrs).toEqual(['196.201.214.200/32', '10.0.0.0/8']);
  });
});

describe('shutdown settles pending waiters', () => {
  it('resolves rather than stranding a caller mid-payment', async () => {
    const receiver = new CallbackReceiver({
      config: { port: 0, allowedCidrs: [], storeDir: tempDir(), trustProxy: false },
      persist: false,
    });
    await receiver.start();

    // A long wait, as stk_push_and_wait uses.
    const pending = receiver.waitFor('ws_CO_inflight', 60_000);
    const started = Date.now();
    await receiver.stop();

    expect(await pending).toBeNull();
    // Must not sit until the original timeout expires.
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
