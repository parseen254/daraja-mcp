import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeHarness, type Harness } from './harness.js';
import { CallbackReceiver } from '../callbacks/receiver.js';
import * as fx from '../simulator/fixtures.js';
import {
  c2bRegisterUrls,
  c2bSimulate,
  checkAgeOnNetwork,
  checkSimSwap,
  getCallback,
  listCallbacks,
  pullQuery,
  pullRegister,
  queryOrgInfo,
  serverHealth,
  validateIdentity,
} from './misc.js';

describe('c2bRegisterUrls', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('registers both URLs against the shortcode', async () => {
    await c2bRegisterUrls(h.ctx, {});
    const body = h.lastBody();

    expect(body.ShortCode).toBe('174379');
    expect(body.ConfirmationURL).toBe('https://callbacks.test/cb/c2b-confirmation');
    expect(body.ValidationURL).toBe('https://callbacks.test/cb/c2b-validation');
  });

  it('defaults ResponseType to Completed', async () => {
    await c2bRegisterUrls(h.ctx, {});
    // Completed means Daraja accepts the payment if validation is unreachable.
    expect(h.lastBody().ResponseType).toBe('Completed');
  });

  it('passes Cancelled through when chosen', async () => {
    await c2bRegisterUrls(h.ctx, { responseType: 'Cancelled' });
    expect(h.lastBody().ResponseType).toBe('Cancelled');
  });

  it('accepts explicit URLs', async () => {
    await c2bRegisterUrls(h.ctx, {
      confirmationUrl: 'https://mine.test/confirm',
      validationUrl: 'https://mine.test/validate',
    });
    const body = h.lastBody();
    expect(body.ConfirmationURL).toBe('https://mine.test/confirm');
    expect(body.ValidationURL).toBe('https://mine.test/validate');
  });

  it('requires a shortcode', async () => {
    const bare = makeHarness({ shortCode: undefined });
    await expect(c2bRegisterUrls(bare.ctx, {})).rejects.toMatchObject({ kind: 'config' });
  });
});

describe('c2bSimulate', () => {
  it('sends a simulated customer payment', async () => {
    const h = makeHarness();
    await c2bSimulate(h.ctx, { phoneNumber: '0712345678', amount: 100 });
    const body = h.lastBody();

    expect(body.Msisdn).toBe('254712345678');
    expect(body.Amount).toBe('100');
    expect(body.CommandID).toBe('CustomerPayBillOnline');
    expect(body.BillRefNumber).toBe('TEST');
  });

  it('accepts a buy goods command and bill reference', async () => {
    const h = makeHarness();
    await c2bSimulate(h.ctx, {
      phoneNumber: '0712345678',
      amount: 1,
      commandId: 'CustomerBuyGoodsOnline',
      billRefNumber: 'ORDER1',
    });
    const body = h.lastBody();
    expect(body.CommandID).toBe('CustomerBuyGoodsOnline');
    expect(body.BillRefNumber).toBe('ORDER1');
  });

  it('refuses to run in production', async () => {
    const prod = makeHarness({ mode: 'production' });
    await expect(
      c2bSimulate(prod.ctx, { phoneNumber: '0712345678', amount: 1 }),
    ).rejects.toMatchObject({ kind: 'validation' });
  });

  it('rejects an invalid number', async () => {
    const h = makeHarness();
    await expect(
      c2bSimulate(h.ctx, { phoneNumber: '123', amount: 1 }),
    ).rejects.toMatchObject({ kind: 'validation' });
  });
});

describe('pull transactions', () => {
  it('registers a nominated number', async () => {
    const h = makeHarness();
    await pullRegister(h.ctx, { nominatedNumber: '0712345678' });
    const body = h.lastBody();

    expect(body.RequestType).toBe('Pull');
    expect(body.NominatedNumber).toBe('254712345678');
    expect(body.CallBackURL).toBe('https://callbacks.test/cb/pull');
  });

  it('rejects an invalid nominated number', async () => {
    const h = makeHarness();
    await expect(
      pullRegister(h.ctx, { nominatedNumber: 'nope' }),
    ).rejects.toMatchObject({ kind: 'validation' });
  });

  it('queries a date window with a default offset', async () => {
    const h = makeHarness();
    await pullQuery(h.ctx, {
      startDate: '2026-07-01 00:00:00',
      endDate: '2026-07-31 23:59:59',
    });
    const body = h.lastBody();

    expect(body.StartDate).toBe('2026-07-01 00:00:00');
    expect(body.OffSetValue).toBe('0');
  });

  it('passes an explicit offset for pagination', async () => {
    const h = makeHarness();
    await pullQuery(h.ctx, { startDate: 'a', endDate: 'b', offsetValue: '100' });
    expect(h.lastBody().OffSetValue).toBe('100');
  });
});

describe('identity and fraud tools', () => {
  it('checks a SIM swap using the customerNumber field', async () => {
    const h = makeHarness();
    await checkSimSwap(h.ctx, { phoneNumber: '0712345678' });
    const body = h.lastBody();

    // The identity APIs take "customerNumber". Sending "msisdn", which is what
    // the payment products use, is silently wrong.
    expect(body.customerNumber).toBe('254712345678');
    expect(body.msisdn).toBeUndefined();
    expect(h.requests.at(-1)?.url).toContain('/imsi/v2/checkATI');
  });

  it('checks age on network using the customerNumber field', async () => {
    const h = makeHarness();
    await checkAgeOnNetwork(h.ctx, { phoneNumber: '0712345678' });
    const body = h.lastBody();

    expect(body.customerNumber).toBe('254712345678');
    expect(body.msisdn).toBeUndefined();
    expect(h.requests.at(-1)?.url).toContain('/registration/lookup/v1/checkATI');
  });

  it('validates a number against an ID with every required field', async () => {
    const h = makeHarness();
    await validateIdentity(h.ctx, { phoneNumber: '0712345678', idNumber: '12345678' });
    const body = h.lastBody();

    expect(body.msisdn).toBe('254712345678');
    expect(body.idNumber).toBe('12345678');
    // The spec requires all of these; omitting them gets the request rejected.
    // Pin the real layout: [0-9a-f-]{36} also matches 36 dashes.
    expect(body.requestRefID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(body.shortCode).toBe('174379');
    expect(body.idType).toBe('01');
    // The capitalised spelling is not what the API accepts.
    expect(body.IDNumber).toBeUndefined();
  });

  it.each([
    ['national', '01'],
    ['military', '02'],
    ['passport', '05'],
  ] as const)('maps idType %s to code %s', async (idType, code) => {
    const h = makeHarness();
    await validateIdentity(h.ctx, {
      phoneNumber: '0712345678',
      idNumber: '1',
      idType,
    });
    expect(h.lastBody().idType).toBe(code);
  });

  it('generates a fresh requestRefID per call', async () => {
    const h = makeHarness();
    await validateIdentity(h.ctx, { phoneNumber: '0712345678', idNumber: '1' });
    const first = h.lastBody().requestRefID;
    await validateIdentity(h.ctx, { phoneNumber: '0712345678', idNumber: '1' });

    // The spec calls for a unique string per request.
    expect(h.lastBody().requestRefID).not.toBe(first);
  });

  it('looks up organisation info with the paybill identifier by default', async () => {
    const h = makeHarness();
    await queryOrgInfo(h.ctx, { shortCode: '600000' });
    const body = h.lastBody();
    expect(body.Identifier).toBe('600000');
    expect(body.IdentifierType).toBe('4');
  });

  it('accepts the till identifier type', async () => {
    const h = makeHarness();
    await queryOrgInfo(h.ctx, { shortCode: '373132', identifierType: '2' });
    expect(h.lastBody().IdentifierType).toBe('2');
  });

  it.each([
    ['checkSimSwap', checkSimSwap],
    ['checkAgeOnNetwork', checkAgeOnNetwork],
  ])('%s rejects an invalid number', async (_name, fn) => {
    const h = makeHarness();
    await expect(fn(h.ctx, { phoneNumber: '000' })).rejects.toMatchObject({
      kind: 'validation',
    });
  });

  it('validateIdentity rejects an invalid number', async () => {
    const h = makeHarness();
    await expect(
      validateIdentity(h.ctx, { phoneNumber: '000', idNumber: '1' }),
    ).rejects.toMatchObject({ kind: 'validation' });
  });
});

describe('callback inspection', () => {
  let dir: string;
  let receiver: CallbackReceiver;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'daraja-misc-'));
    receiver = new CallbackReceiver({
      config: { port: 0, allowedCidrs: [], storeDir: dir },
      persist: false,
    });
    await receiver.start();
  });

  afterEach(async () => {
    await receiver.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (path: string, payload: unknown) =>
    fetch(`http://127.0.0.1:${receiver.port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

  const seed = () =>
    post(
      '/cb/stk',
      fx.stkPush.callbackSuccess({
        merchantRequestId: 'mr-1',
        checkoutRequestId: 'ws_CO_seed',
        amount: 10,
        phone: '254712345678',
      }),
    );

  it('lists a summary rather than full payloads', async () => {
    const h = makeHarness({}, { receiver });
    await seed();

    const result = listCallbacks(h.ctx, {}) as any;
    expect(result.count).toBe(1);
    expect(result.callbacks[0]).toMatchObject({
      kind: 'stk',
      correlationId: 'ws_CO_seed',
      outcome: 'success',
    });
    // The full payload would swamp a model's context.
    expect(result.callbacks[0].payload).toBeUndefined();
  });

  it('filters by kind', async () => {
    const h = makeHarness({}, { receiver });
    await seed();
    await post(
      '/cb/ratiba',
      fx.ratiba.callbackSuccess({
        responseRefId: 'r',
        requestRefId: 'req-1',
        standingOrderName: 'X',
        amount: 1,
        msisdn: '254712345678',
      }),
    );

    expect((listCallbacks(h.ctx, { kind: 'stk' }) as any).count).toBe(1);
    expect((listCallbacks(h.ctx, { kind: 'ratiba' }) as any).count).toBe(1);
    expect((listCallbacks(h.ctx, { kind: 'b2c' }) as any).count).toBe(0);
  });

  it('honours the limit', async () => {
    const h = makeHarness({}, { receiver });
    await seed();
    await seed();
    expect((listCallbacks(h.ctx, { limit: 1 }) as any).count).toBe(1);
  });

  it('returns the full payload for a known correlation id', async () => {
    const h = makeHarness({}, { receiver });
    await seed();

    const result = getCallback(h.ctx, { correlationId: 'ws_CO_seed' }) as any;
    expect(result.found).toBe(true);
    expect(result.payload.Body.stkCallback.ResultCode).toBe(0);
  });

  it('reports not found without throwing for an unknown id', async () => {
    const h = makeHarness({}, { receiver });
    const result = getCallback(h.ctx, { correlationId: 'nope' }) as any;
    expect(result.found).toBe(false);
    expect(result.message).toContain('in flight');
  });

  it('errors when the receiver is not running', () => {
    const h = makeHarness({}, { receiver: null });
    expect(() => listCallbacks(h.ctx, {})).toThrowError(/not running/);
    expect(() => getCallback(h.ctx, { correlationId: 'x' })).toThrowError(/not running/);
  });
});

describe('serverHealth', () => {
  it('reports configured credentials without leaking their values', () => {
    const h = makeHarness();
    const health = serverHealth(h.ctx) as any;

    expect(health.mode).toBe('sandbox');
    expect(health.shortCodeConfigured).toBe(true);
    expect(health.passkeyConfigured).toBe(true);
    expect(health.initiatorConfigured).toBe(true);
    // Secrets must never appear in tool output.
    expect(JSON.stringify(health)).not.toContain('test-passkey');
    expect(JSON.stringify(health)).not.toContain('encrypted-credential');
  });

  it('reports missing credentials as false', () => {
    const bare = makeHarness({
      passkey: undefined,
      initiatorName: undefined,
      securityCredential: undefined,
    });
    const health = serverHealth(bare.ctx) as any;
    expect(health.passkeyConfigured).toBe(false);
    expect(health.initiatorConfigured).toBe(false);
  });

  it('reports the receiver as not running when absent', () => {
    const h = makeHarness({}, { receiver: null });
    expect((serverHealth(h.ctx) as any).callbackReceiver).toEqual({ running: false });
  });

  it('summarises source verification and path secret state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daraja-health-'));
    const receiver = new CallbackReceiver({
      config: {
        port: 0,
        allowedCidrs: ['196.201.214.200/32'],
        pathSecret: 'secret',
        storeDir: dir,
      },
      persist: false,
    });
    await receiver.start();

    try {
      const h = makeHarness(
        {
          callback: {
            port: 0,
            allowedCidrs: ['196.201.214.200/32'],
            pathSecret: 'secret',
            storeDir: dir,
          },
        },
        { receiver },
      );
      const health = serverHealth(h.ctx) as any;

      expect(health.callbackReceiver.running).toBe(true);
      expect(health.callbackReceiver.sourceVerification).toContain('1 allowed');
      expect(health.callbackReceiver.pathSecret).toBe('set');
      // The secret itself must not be disclosed.
      expect(JSON.stringify(health)).not.toContain('"secret"');
    } finally {
      await receiver.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports verification as disabled when no ranges are set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daraja-health2-'));
    const receiver = new CallbackReceiver({
      config: { port: 0, allowedCidrs: [], storeDir: dir },
      persist: false,
    });
    await receiver.start();

    try {
      // Simulator mode is the case where verification is deliberately off.
      const h = makeHarness(
        { callback: { port: 0, allowedCidrs: [], storeDir: dir } },
        { receiver },
      );
      const health = serverHealth(h.ctx) as any;
      expect(health.callbackReceiver.sourceVerification).toContain('disabled');
      expect(health.callbackReceiver.pathSecret).toBe('not set');
    } finally {
      await receiver.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
