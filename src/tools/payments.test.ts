import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeHarness, type Harness } from './harness.js';
import { CallbackReceiver } from '../callbacks/receiver.js';
import * as fx from '../simulator/fixtures.js';
import {
  generateQr,
  ratibaCreate,
  ratibaCreateAndWait,
  RATIBA_FREQUENCIES,
  stkPush,
  stkPushAndWait,
  stkQuery,
} from './payments.js';

describe('stkPush', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('sends the documented field set', async () => {
    await stkPush(h.ctx, { phoneNumber: '0712345678', amount: 100 });
    const body = h.lastBody();

    expect(body).toMatchObject({
      BusinessShortCode: '174379',
      TransactionType: 'CustomerPayBillOnline',
      Amount: '100',
      PartyA: '254712345678',
      PartyB: '174379',
      PhoneNumber: '254712345678',
    });
    expect(body.CallBackURL).toBe('https://callbacks.test/cb/stk');
  });

  it('derives a password that embeds the timestamp it sends', async () => {
    await stkPush(h.ctx, { phoneNumber: '0712345678', amount: 5 });
    const body = h.lastBody();

    // A mismatch here is the intermittent failure that appears when the
    // password and timestamp are generated in separate calls.
    const decoded = Buffer.from(body.Password, 'base64').toString('utf8');
    expect(decoded).toBe(`174379test-passkey${body.Timestamp}`);
    expect(body.Timestamp).toMatch(/^\d{14}$/);
  });

  it.each([
    ['0712345678', '254712345678'],
    ['+254712345678', '254712345678'],
    ['254712345678', '254712345678'],
    ['0112345678', '254112345678'],
  ])('normalises %s before sending', async (input, expected) => {
    await stkPush(h.ctx, { phoneNumber: input, amount: 1 });
    expect(h.lastBody().PartyA).toBe(expected);
  });

  it('rejects a number that cannot be a Kenyan MSISDN', async () => {
    await expect(stkPush(h.ctx, { phoneNumber: '0812345678', amount: 1 })).rejects.toMatchObject({
      kind: 'validation',
    });
  });

  it('sends buy-goods transaction type when asked', async () => {
    await stkPush(h.ctx, {
      phoneNumber: '0712345678',
      amount: 10,
      transactionType: 'CustomerBuyGoodsOnline',
    });
    expect(h.lastBody().TransactionType).toBe('CustomerBuyGoodsOnline');
  });

  it('honours an explicit shortcode and callback URL', async () => {
    await stkPush(h.ctx, {
      phoneNumber: '0712345678',
      amount: 10,
      shortCode: '999999',
      callbackUrl: 'https://custom.test/hook',
    });
    const body = h.lastBody();
    expect(body.BusinessShortCode).toBe('999999');
    expect(body.CallBackURL).toBe('https://custom.test/hook');
  });

  it('defaults the reference and description when omitted', async () => {
    await stkPush(h.ctx, { phoneNumber: '0712345678', amount: 10 });
    const body = h.lastBody();
    expect(body.AccountReference).toBe('Payment');
    expect(body.TransactionDesc).toBe('Payment');
  });

  it('rejects an over-long account reference before calling Daraja', async () => {
    await expect(
      stkPush(h.ctx, {
        phoneNumber: '0712345678',
        amount: 1,
        accountReference: 'THIRTEENCHARS',
      }),
    ).rejects.toMatchObject({ kind: 'validation' });
    // Nothing should have reached the network.
    expect(h.requests.filter((r) => !r.url.includes('/oauth/'))).toHaveLength(0);
  });

  it('rejects an over-long transaction description', async () => {
    await expect(
      stkPush(h.ctx, {
        phoneNumber: '0712345678',
        amount: 1,
        transactionDesc: 'this is far too long',
      }),
    ).rejects.toMatchObject({ kind: 'validation' });
  });

  it('reports a missing passkey as a configuration problem', async () => {
    const bare = makeHarness({ passkey: undefined });
    await expect(
      stkPush(bare.ctx, { phoneNumber: '0712345678', amount: 1 }),
    ).rejects.toMatchObject({ kind: 'config' });
  });

  it('reports a missing shortcode as a configuration problem', async () => {
    const bare = makeHarness({ shortCode: undefined });
    await expect(
      stkPush(bare.ctx, { phoneNumber: '0712345678', amount: 1 }),
    ).rejects.toMatchObject({ kind: 'config' });
  });

  it('errors when there is no receiver and no explicit callback URL', async () => {
    const noReceiver = makeHarness({}, { receiver: null });
    await expect(
      stkPush(noReceiver.ctx, { phoneNumber: '0712345678', amount: 1 }),
    ).rejects.toMatchObject({ kind: 'config' });
  });
});

describe('stkQuery', () => {
  it('sends the checkout id with a matching password', async () => {
    const h = makeHarness();
    await stkQuery(h.ctx, { checkoutRequestId: 'ws_CO_123' });
    const body = h.lastBody();

    expect(body.CheckoutRequestID).toBe('ws_CO_123');
    const decoded = Buffer.from(body.Password, 'base64').toString('utf8');
    expect(decoded).toBe(`174379test-passkey${body.Timestamp}`);
  });

  it('accepts a shortcode override', async () => {
    const h = makeHarness();
    await stkQuery(h.ctx, { checkoutRequestId: 'ws_CO_1', shortCode: '888888' });
    expect(h.lastBody().BusinessShortCode).toBe('888888');
  });

  it('requires a passkey', async () => {
    const h = makeHarness({ passkey: undefined });
    await expect(stkQuery(h.ctx, { checkoutRequestId: 'x' })).rejects.toMatchObject({
      kind: 'config',
    });
  });
});

describe('ratibaCreate', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  const base = {
    standingOrderName: 'Gym membership',
    phoneNumber: '0712345678',
    amount: 2000,
    startDate: '2026-08-01',
    endDate: '2027-08-01',
    frequency: 'monthly' as const,
  };

  it('sends the standing order name under both documented spellings', async () => {
    await ratibaCreate(h.ctx, base);
    const body = h.lastBody();

    // The published sample and the parameter table disagree, so both go.
    expect(body.StandingOrderName).toBe('Gym membership');
    expect(body.StandingOrderNameName).toBe('Gym membership');
  });

  it('sends the tracking id under both documented spellings, with one value', async () => {
    await ratibaCreate(h.ctx, base);
    const body = h.lastBody();

    expect(body.CustomStoId).toBeTruthy();
    expect(body.CustomstdoId).toBe(body.CustomStoId);
  });

  it('returns the correlation id that the callback will echo back', async () => {
    const result = await ratibaCreate(h.ctx, base);
    expect(result.correlationId).toBe(h.lastBody().CustomStoId);
    expect(result.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('converts ISO dates to the yyyymmdd form Daraja wants', async () => {
    await ratibaCreate(h.ctx, base);
    const body = h.lastBody();
    expect(body.StartDate).toBe('20260801');
    expect(body.EndDate).toBe('20270801');
  });

  it('accepts dates already in yyyymmdd form', async () => {
    await ratibaCreate(h.ctx, { ...base, startDate: '20260801', endDate: '20270801' });
    expect(h.lastBody().StartDate).toBe('20260801');
  });

  it.each([
    ['2026-8-1', 'single digit components'],
    ['01/08/2026', 'slashes'],
    ['next tuesday', 'natural language'],
    ['', 'empty'],
  ])('rejects an unparseable start date (%s)', async (startDate) => {
    await expect(ratibaCreate(h.ctx, { ...base, startDate })).rejects.toMatchObject({
      kind: 'validation',
    });
  });

  it('rejects an end date before the start date', async () => {
    await expect(
      ratibaCreate(h.ctx, { ...base, startDate: '2027-01-01', endDate: '2026-01-01' }),
    ).rejects.toMatchObject({ kind: 'validation' });
  });

  it.each(Object.entries(RATIBA_FREQUENCIES))(
    'maps frequency %s to code %s',
    async (frequency, code) => {
      await ratibaCreate(h.ctx, { ...base, frequency: frequency as keyof typeof RATIBA_FREQUENCIES });
      expect(h.lastBody().Frequency).toBe(code);
    },
  );

  it('uses paybill identifiers by default', async () => {
    await ratibaCreate(h.ctx, base);
    const body = h.lastBody();
    expect(body.ReceiverPartyIdentifierType).toBe('4');
    expect(body.TransactionType).toBe('Standing Order Pay Bill External Third Party');
  });

  it('switches identifiers and transaction type for a till', async () => {
    await ratibaCreate(h.ctx, { ...base, receiverType: 'till' });
    const body = h.lastBody();
    expect(body.ReceiverPartyIdentifierType).toBe('2');
    expect(body.TransactionType).toBe('Standing Order Pay Merchant External Third Party');
  });

  it('truncates a long standing order name for the account reference', async () => {
    await ratibaCreate(h.ctx, {
      ...base,
      standingOrderName: 'A very long standing order name',
    });
    // AccountReference is capped at 12 characters by Daraja.
    expect(h.lastBody().AccountReference).toHaveLength(12);
  });

  it('rejects an over-long explicit account reference', async () => {
    await expect(
      ratibaCreate(h.ctx, { ...base, accountReference: 'WAYTOOLONGREFERENCE' }),
    ).rejects.toMatchObject({ kind: 'validation' });
  });

  it('normalises the payer number', async () => {
    await ratibaCreate(h.ctx, { ...base, phoneNumber: '+254 712 345 678' });
    expect(h.lastBody().PartyA).toBe('254712345678');
  });

  it('rejects an invalid payer number', async () => {
    await expect(
      ratibaCreate(h.ctx, { ...base, phoneNumber: '12345' }),
    ).rejects.toMatchObject({ kind: 'validation' });
  });

  it('requires a shortcode', async () => {
    const bare = makeHarness({ shortCode: undefined });
    await expect(ratibaCreate(bare.ctx, base)).rejects.toMatchObject({ kind: 'config' });
  });
});

describe('waiting on callbacks', () => {
  let dir: string;
  let receiver: CallbackReceiver;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'daraja-tools-'));
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

  it('returns the settled outcome and receipt for a successful push', async () => {
    const h = makeHarness({}, { receiver });
    h.reply({
      MerchantRequestID: 'mr-1',
      CheckoutRequestID: 'ws_CO_settle',
      ResponseCode: '0',
    });

    const pending = stkPushAndWait(h.ctx, {
      phoneNumber: '0712345678',
      amount: 100,
      timeoutSeconds: 5,
    });

    // Let the request go out before the callback lands.
    await new Promise((r) => setTimeout(r, 30));
    await post(
      '/cb/stk',
      fx.stkPush.callbackSuccess({
        merchantRequestId: 'mr-1',
        checkoutRequestId: 'ws_CO_settle',
        amount: 100,
        phone: '254712345678',
      }),
    );

    const result = (await pending) as any;
    expect(result.status).toBe('success');
    expect(result.metadata.MpesaReceiptNumber).toBeTruthy();
    expect(result.metadata.Amount).toBe(100);
  });

  it('reports failure with no metadata when the customer cancels', async () => {
    const h = makeHarness({}, { receiver });
    h.reply({ MerchantRequestID: 'mr-2', CheckoutRequestID: 'ws_CO_cancel', ResponseCode: '0' });

    const pending = stkPushAndWait(h.ctx, {
      phoneNumber: '0712345678',
      amount: 100,
      timeoutSeconds: 5,
    });

    await new Promise((r) => setTimeout(r, 30));
    await post(
      '/cb/stk',
      fx.stkPush.callbackFailure({
        merchantRequestId: 'mr-2',
        checkoutRequestId: 'ws_CO_cancel',
        resultCode: 1032,
        resultDesc: 'Request cancelled by user',
      }),
    );

    const result = (await pending) as any;
    expect(result.status).toBe('failure');
    expect(result.resultCode).toBe('1032');
    // Daraja omits CallbackMetadata on failure; this must not throw.
    expect(result.metadata).toBeNull();
  });

  it('reports pending when no callback arrives in time', async () => {
    const h = makeHarness({}, { receiver });
    h.reply({ MerchantRequestID: 'mr-3', CheckoutRequestID: 'ws_CO_slow', ResponseCode: '0' });

    const result = (await stkPushAndWait(h.ctx, {
      phoneNumber: '0712345678',
      amount: 100,
      // Sub-second timeout: waitFor takes seconds, so this floors to a short wait.
      timeoutSeconds: 0.05 as number,
    })) as any;

    expect(result.status).toBe('pending');
    expect(result.checkoutRequestId).toBe('ws_CO_slow');
    expect(result.message).toContain('stk_query');
  });

  it('handles an acceptance that carries no checkout id', async () => {
    const h = makeHarness({}, { receiver });
    h.reply({ ResponseCode: '0', ResponseDescription: 'odd but accepted' });

    const result = (await stkPushAndWait(h.ctx, {
      phoneNumber: '0712345678',
      amount: 1,
      timeoutSeconds: 1,
    })) as any;

    expect(result.status).toBe('accepted_without_id');
  });

  it('refuses to wait when no receiver is running', async () => {
    const h = makeHarness({}, { receiver: null });
    await expect(
      stkPushAndWait(h.ctx, { phoneNumber: '0712345678', amount: 1 }),
    ).rejects.toMatchObject({ kind: 'config' });
  });

  it('flattens the Ratiba callback data on success', async () => {
    const h = makeHarness({}, { receiver });
    h.reply(fx.ratiba.accepted('resp-1'));

    const pending = ratibaCreateAndWait(h.ctx, {
      standingOrderName: 'Gym',
      phoneNumber: '0712345678',
      amount: 500,
      startDate: '2026-08-01',
      endDate: '2027-08-01',
      frequency: 'monthly',
      timeoutSeconds: 5,
    });

    await new Promise((r) => setTimeout(r, 30));
    const correlationId = h.lastBody().CustomStoId;
    await post(
      '/cb/ratiba',
      fx.ratiba.callbackSuccess({
        responseRefId: 'resp-1',
        requestRefId: correlationId,
        standingOrderName: 'Gym',
        amount: 500,
        msisdn: '254712345678',
      }),
    );

    const result = (await pending) as any;
    expect(result.status).toBe('success');
    expect(result.details.status).toBe('ACTIVE');
    expect(result.details.reminderScheduleId).toBeTruthy();
  });

  it('flattens the Ratiba failure envelope despite its different casing', async () => {
    const h = makeHarness({}, { receiver });
    h.reply(fx.ratiba.accepted('resp-2'));

    const pending = ratibaCreateAndWait(h.ctx, {
      standingOrderName: 'Gym',
      phoneNumber: '0712345678',
      amount: 500,
      startDate: '2026-08-01',
      endDate: '2027-08-01',
      frequency: 'monthly',
      timeoutSeconds: 5,
    });

    await new Promise((r) => setTimeout(r, 30));
    const correlationId = h.lastBody().CustomStoId;
    await post(
      '/cb/ratiba',
      fx.ratiba.callbackFailure({
        responseRefId: 'resp-2',
        requestRefId: correlationId,
        reason: 'Customer declined',
      }),
    );

    const result = (await pending) as any;
    expect(result.status).toBe('failure');
    // Failure uses ResponseBody/ResponseData; success uses responseBody/responseData.
    expect(result.details.ResponseCode).toBe('1037');
  });

  it('reports pending for a standing order that is never approved', async () => {
    const h = makeHarness({}, { receiver });
    h.reply(fx.ratiba.accepted('resp-3'));

    const result = (await ratibaCreateAndWait(h.ctx, {
      standingOrderName: 'Gym',
      phoneNumber: '0712345678',
      amount: 500,
      startDate: '2026-08-01',
      endDate: '2027-08-01',
      frequency: 'monthly',
      timeoutSeconds: 0.05 as number,
    })) as any;

    expect(result.status).toBe('pending');
  });

  it('refuses to wait on a standing order with no receiver', async () => {
    const h = makeHarness({}, { receiver: null });
    await expect(
      ratibaCreateAndWait(h.ctx, {
        standingOrderName: 'Gym',
        phoneNumber: '0712345678',
        amount: 500,
        startDate: '2026-08-01',
        endDate: '2027-08-01',
        frequency: 'monthly',
      }),
    ).rejects.toMatchObject({ kind: 'config' });
  });
});

describe('generateQr', () => {
  it('sends the documented QR fields', async () => {
    const h = makeHarness();
    await generateQr(h.ctx, {
      merchantName: 'Test Shop',
      refNo: 'INV-1',
      amount: 250,
      trxCode: 'BG',
      cpi: '373132',
    });

    expect(h.lastBody()).toMatchObject({
      MerchantName: 'Test Shop',
      RefNo: 'INV-1',
      Amount: 250,
      TrxCode: 'BG',
      CPI: '373132',
      Size: '300',
    });
  });

  it('honours an explicit size', async () => {
    const h = makeHarness();
    await generateQr(h.ctx, {
      merchantName: 'S',
      refNo: 'R',
      amount: 1,
      trxCode: 'PB',
      cpi: '1',
      size: '500',
    });
    expect(h.lastBody().Size).toBe('500');
  });
});
