import { describe, expect, it } from 'vitest';
import { makeHarness } from './harness.js';
import { environmentBanner, requirePayoutsAllowed, toolResult } from './context.js';
import { loadConfig } from '../config.js';
import {
  b2cPayment,
  b2cPaymentAndWait,
  b2bPayment,
  businessToPochi,
  reversal,
  taxRemittance,
  accountBalance,
  transactionStatus,
} from './disbursement.js';
import { ratibaCreate, ratibaCreateAndWait, stkPush, stkQuery } from './payments.js';
import { checkSimSwap } from './misc.js';

/**
 * The guard exists for a specific failure: someone demos against the simulator
 * for a week, swaps in production credentials, and keeps the same prompts. By
 * then an agent can pay out, reverse a stranger's transaction, or set up a
 * standing order that keeps debiting after the conversation ends.
 *
 * Collecting a payment is exempt because the customer has to approve the prompt
 * on their own phone.
 */

const prodEnv = {
  DARAJA_MODE: 'production',
  DARAJA_CONSUMER_KEY: 'k',
  DARAJA_CONSUMER_SECRET: 's',
  DARAJA_SHORTCODE: '174379',
  DARAJA_PASSKEY: 'pk',
  DARAJA_INITIATOR_NAME: 'api',
  DARAJA_SECURITY_CREDENTIAL: 'cred',
} as unknown as NodeJS.ProcessEnv;

function productionHarness(allowPayouts = false) {
  const config = loadConfig(
    allowPayouts
      ? ({ ...prodEnv, DARAJA_ALLOW_PAYOUTS: 'true' } as NodeJS.ProcessEnv)
      : prodEnv,
  );
  // Point at a stub rather than api.safaricom.co.ke: these tests must never
  // be one misconfiguration away from a real request.
  return makeHarness({ ...config, baseUrl: 'https://stub.invalid' });
}

const OUTBOUND = {
  b2c_payment: (ctx: any) => b2cPayment(ctx, { phoneNumber: '0712345678', amount: 100 }),
  b2c_payment_and_wait: (ctx: any) =>
    b2cPaymentAndWait(ctx, { phoneNumber: '0712345678', amount: 100 }),
  b2b_payment: (ctx: any) =>
    b2bPayment(ctx, { target: 'buygoods', receiverShortCode: '600000', amount: 100 }),
  tax_remittance: (ctx: any) =>
    taxRemittance(ctx, { amount: 100, paymentRegistrationNumber: 'PRN1' }),
  business_to_pochi: (ctx: any) =>
    businessToPochi(ctx, { phoneNumber: '0712345678', amount: 100 }),
  reversal: (ctx: any) => reversal(ctx, { transactionId: 'NEF61H8J60', amount: 100 }),
  ratiba_create: (ctx: any) =>
    ratibaCreate(ctx, {
      standingOrderName: 'Sub',
      phoneNumber: '0712345678',
      amount: 100,
      startDate: '2026-08-01',
      endDate: '2027-08-01',
      frequency: 'monthly',
    }),
  ratiba_create_and_wait: (ctx: any) =>
    ratibaCreateAndWait(ctx, {
      standingOrderName: 'Sub',
      phoneNumber: '0712345678',
      amount: 100,
      startDate: '2026-08-01',
      endDate: '2027-08-01',
      frequency: 'monthly',
    }),
};

describe('outbound tools in production', () => {
  it.each(Object.keys(OUTBOUND))('%s is blocked by default', async (name) => {
    const h = productionHarness(false);
    await expect(
      OUTBOUND[name as keyof typeof OUTBOUND](h.ctx),
    ).rejects.toMatchObject({ kind: 'config' });

    // Nothing may reach the network, not even a token request.
    expect(h.requests).toHaveLength(0);
  });

  it.each(Object.keys(OUTBOUND))('%s names itself in the refusal', async (name) => {
    const h = productionHarness(false);
    const err = await OUTBOUND[name as keyof typeof OUTBOUND](h.ctx).catch((e) => e);
    expect(err.message).toContain(name);
  });

  it('explains why, not just that it refused', async () => {
    const h = productionHarness(false);
    const err = await OUTBOUND.b2c_payment(h.ctx).catch((e) => e);

    expect(err.hint).toContain('DARAJA_ALLOW_PAYOUTS');
    // The reason matters more than the flag name: this is the class of tool an
    // agent can invoke with nobody approving anything.
    expect(err.hint).toContain('without a human');
  });

  it.each(Object.keys(OUTBOUND))('%s is permitted once opted in', async (name) => {
    const h = productionHarness(true);
    // The stub host means these fail on transport, not on the guard.
    const err = await OUTBOUND[name as keyof typeof OUTBOUND](h.ctx).catch((e) => e);
    if (err?.kind) expect(err.kind).not.toBe('config');
  });
});

describe('collection and read-only tools', () => {
  it('stk_push is never gated: the customer approves it on their phone', async () => {
    const h = productionHarness(false);
    await expect(stkPush(h.ctx, { phoneNumber: '0712345678', amount: 100 })).resolves
      .toBeTruthy();
  });

  it.each([
    ['stk_query', (ctx: any) => stkQuery(ctx, { checkoutRequestId: 'ws_CO_1' })],
    ['account_balance', (ctx: any) => accountBalance(ctx, {})],
    ['transaction_status', (ctx: any) => transactionStatus(ctx, { transactionId: 'X' })],
    ['check_sim_swap', (ctx: any) => checkSimSwap(ctx, { phoneNumber: '0712345678' })],
  ])('%s is not gated', async (_name, fn) => {
    const h = productionHarness(false);
    await expect(fn(h.ctx)).resolves.toBeTruthy();
  });
});

describe('non-production modes', () => {
  it.each(['simulator', 'sandbox'])('allows payouts in %s', (mode) => {
    const config = loadConfig(
      mode === 'simulator'
        ? ({} as NodeJS.ProcessEnv)
        : ({
            DARAJA_MODE: 'sandbox',
            DARAJA_CONSUMER_KEY: 'k',
            DARAJA_CONSUMER_SECRET: 's',
          } as NodeJS.ProcessEnv),
    );
    // No real money exists in either, so the guard would only be friction.
    expect(config.allowPayouts).toBe(true);
  });

  it('ignores the opt-in flag outside production', () => {
    const config = loadConfig({ DARAJA_ALLOW_PAYOUTS: 'false' } as NodeJS.ProcessEnv);
    expect(config.allowPayouts).toBe(true);
  });

  it('requires the flag in production', () => {
    expect(loadConfig(prodEnv).allowPayouts).toBe(false);
    expect(
      loadConfig({ ...prodEnv, DARAJA_ALLOW_PAYOUTS: 'true' } as NodeJS.ProcessEnv)
        .allowPayouts,
    ).toBe(true);
  });
});

describe('requirePayoutsAllowed', () => {
  it('passes through when allowed', () => {
    const h = makeHarness({ allowPayouts: true });
    expect(() => requirePayoutsAllowed(h.ctx, 'anything')).not.toThrow();
  });

  it('throws when not allowed', () => {
    const h = makeHarness({ allowPayouts: false });
    expect(() => requirePayoutsAllowed(h.ctx, 'anything')).toThrowError(/moves money out/);
  });
});

describe('environment banner', () => {
  it.each([
    ['simulator', 'SIMULATOR'],
    ['sandbox', 'SANDBOX'],
    ['production', 'PRODUCTION'],
  ])('labels %s mode', (mode, expected) => {
    const h = makeHarness({ mode: mode as any });
    expect(environmentBanner(h.ctx)).toContain(expected);
  });

  it('says plainly that production is real money', () => {
    const h = makeHarness({ mode: 'production' });
    expect(environmentBanner(h.ctx)).toContain('real money');
  });

  it('reassures that the simulator is not', () => {
    const h = makeHarness({ mode: 'simulator' });
    expect(environmentBanner(h.ctx)).toContain('no real money');
  });

  it('prefixes every successful tool result', async () => {
    const h = makeHarness({ mode: 'production' });
    const result = await toolResult(h.ctx, async () => ({ receipt: 'NLJ7RT61SV' }));
    const text = result.content[0]!.text;

    expect(text.startsWith('PRODUCTION')).toBe(true);
    // Also machine-readable, so an agent does not have to parse the prose.
    expect(text).toContain('"environment": "production"');
  });

  it('prefixes error results too', async () => {
    const h = makeHarness({ mode: 'production' });
    const result = await toolResult(h.ctx, async () => {
      throw new Error('boom');
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text.startsWith('PRODUCTION')).toBe(true);
  });

  it('wraps a non-object result rather than losing it', async () => {
    const h = makeHarness({ mode: 'simulator' });
    const result = await toolResult(h.ctx, async () => 'plain string');
    expect(result.content[0]!.text).toContain('"result": "plain string"');
  });

  it('does not let a tool payload overwrite the environment field', async () => {
    const h = makeHarness({ mode: 'production' });
    // Daraja payloads carry attacker-influenceable text. One claiming to be the
    // simulator must not be able to convince an agent no real money is moving.
    const result = await toolResult(h.ctx, async () => ({ environment: 'simulator' }));
    const parsed = JSON.parse(result.content[0]!.text.split('\n\n')[1]!);

    expect(parsed.environment).toBe('production');
    expect(result.content[0]!.text.startsWith('PRODUCTION')).toBe(true);
  });
});
