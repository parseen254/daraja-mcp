import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeHarness, type Harness } from './harness.js';
import { CallbackReceiver } from '../callbacks/receiver.js';
import * as fx from '../simulator/fixtures.js';
import {
  accountBalance,
  b2bPayment,
  b2cPayment,
  b2cPaymentAndWait,
  businessToPochi,
  flattenResultParameters,
  reversal,
  taxRemittance,
  transactionStatus,
} from './disbursement.js';

describe('b2cPayment', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('uses InitiatorName, which is unique to B2C', async () => {
    await b2cPayment(h.ctx, { phoneNumber: '0712345678', amount: 500 });
    const body = h.lastBody();

    // Every other product in this family sends "Initiator" instead.
    expect(body.InitiatorName).toBe('testapi');
    expect(body.Initiator).toBeUndefined();
    expect(body.SecurityCredential).toBe('encrypted-credential');
  });

  it('spells the occasion field the way B2C expects', async () => {
    await b2cPayment(h.ctx, { phoneNumber: '0712345678', amount: 1, occasion: 'Refund' });
    const body = h.lastBody();

    // B2C documents "Occassion" with a double s. Transaction status uses one.
    expect(body.Occassion).toBe('Refund');
    expect(body.Occasion).toBeUndefined();
  });

  it('sends an empty occasion when none is given', async () => {
    await b2cPayment(h.ctx, { phoneNumber: '0712345678', amount: 1 });
    expect(h.lastBody().Occassion).toBe('');
  });

  it('defaults to a business payment', async () => {
    await b2cPayment(h.ctx, { phoneNumber: '0712345678', amount: 1 });
    expect(h.lastBody().CommandID).toBe('BusinessPayment');
  });

  it.each(['BusinessPayment', 'SalaryPayment', 'PromotionPayment'] as const)(
    'passes through the %s command',
    async (commandId) => {
      await b2cPayment(h.ctx, { phoneNumber: '0712345678', amount: 1, commandId });
      expect(h.lastBody().CommandID).toBe(commandId);
    },
  );

  it('sends both result and timeout URLs, which Daraja requires', async () => {
    await b2cPayment(h.ctx, { phoneNumber: '0712345678', amount: 1 });
    const body = h.lastBody();
    expect(body.ResultURL).toBeTruthy();
    expect(body.QueueTimeOutURL).toBeTruthy();
  });

  it('generates a tracking id and returns it', async () => {
    const result = await b2cPayment(h.ctx, { phoneNumber: '0712345678', amount: 1 });
    expect(result.originatorConversationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.lastBody().OriginatorConversationID).toBe(result.originatorConversationId);
  });

  it('normalises the recipient number', async () => {
    await b2cPayment(h.ctx, { phoneNumber: '0712 345 678', amount: 1 });
    expect(h.lastBody().PartyB).toBe('254712345678');
  });

  it('rejects an invalid recipient', async () => {
    await expect(
      b2cPayment(h.ctx, { phoneNumber: 'not-a-number', amount: 1 }),
    ).rejects.toMatchObject({ kind: 'validation' });
  });

  it('requires initiator credentials', async () => {
    const bare = makeHarness({ initiatorName: undefined });
    await expect(
      b2cPayment(bare.ctx, { phoneNumber: '0712345678', amount: 1 }),
    ).rejects.toMatchObject({ kind: 'config' });
  });

  it('requires a security credential', async () => {
    const bare = makeHarness({ securityCredential: undefined });
    await expect(
      b2cPayment(bare.ctx, { phoneNumber: '0712345678', amount: 1 }),
    ).rejects.toMatchObject({ kind: 'config' });
  });
});

describe('b2bPayment', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('uses Initiator rather than InitiatorName', async () => {
    await b2bPayment(h.ctx, {
      target: 'paybill',
      receiverShortCode: '600000',
      amount: 100,
      accountReference: 'ACC1',
    });
    const body = h.lastBody();
    expect(body.Initiator).toBe('testapi');
    expect(body.InitiatorName).toBeUndefined();
  });

  it('reproduces the misspelled receiver identifier field', async () => {
    await b2bPayment(h.ctx, {
      target: 'buygoods',
      receiverShortCode: '600000',
      amount: 100,
    });
    const body = h.lastBody();
    // Daraja's own specification misspells this. The correct spelling is rejected.
    expect(body.RecieverIdentifierType).toBe('4');
    expect(body.ReceiverIdentifierType).toBeUndefined();
  });

  it.each([
    ['paybill', 'BusinessPayBill'],
    ['buygoods', 'BusinessBuyGoods'],
    ['topup', 'BusinessPayToBulk'],
  ] as const)('maps target %s to command %s', async (target, commandId) => {
    await b2bPayment(h.ctx, {
      target,
      receiverShortCode: '600000',
      amount: 100,
      accountReference: 'ACC1',
    });
    expect(h.lastBody().CommandID).toBe(commandId);
  });

  it('requires an account reference for a paybill', async () => {
    await expect(
      b2bPayment(h.ctx, { target: 'paybill', receiverShortCode: '600000', amount: 100 }),
    ).rejects.toMatchObject({ kind: 'validation' });
  });

  it('does not require an account reference for buy goods', async () => {
    await expect(
      b2bPayment(h.ctx, { target: 'buygoods', receiverShortCode: '600000', amount: 100 }),
    ).resolves.toBeTruthy();
  });

  it('includes the requester when supplied, normalised', async () => {
    await b2bPayment(h.ctx, {
      target: 'buygoods',
      receiverShortCode: '600000',
      amount: 1,
      requester: '0712345678',
    });
    expect(h.lastBody().Requester).toBe('254712345678');
  });

  it('omits the requester when not supplied', async () => {
    await b2bPayment(h.ctx, { target: 'buygoods', receiverShortCode: '600000', amount: 1 });
    expect(h.lastBody().Requester).toBeUndefined();
  });

  it('rejects an invalid requester number', async () => {
    await expect(
      b2bPayment(h.ctx, {
        target: 'buygoods',
        receiverShortCode: '600000',
        amount: 1,
        requester: '999',
      }),
    ).rejects.toMatchObject({ kind: 'validation' });
  });
});

describe('taxRemittance', () => {
  it('pays the fixed KRA shortcode with the PRN as reference', async () => {
    const h = makeHarness();
    await taxRemittance(h.ctx, { amount: 5000, paymentRegistrationNumber: 'PRN123456' });
    const body = h.lastBody();

    expect(body.CommandID).toBe('PayTaxToKRA');
    // KRA's collection shortcode is fixed by Safaricom.
    expect(body.PartyB).toBe('572572');
    expect(body.AccountReference).toBe('PRN123456');
    expect(body.Amount).toBe('5000');
  });

  it('requires initiator credentials', async () => {
    const bare = makeHarness({ securityCredential: undefined });
    await expect(
      taxRemittance(bare.ctx, { amount: 1, paymentRegistrationNumber: 'P1' }),
    ).rejects.toMatchObject({ kind: 'config' });
  });
});

describe('businessToPochi', () => {
  it('sends a business payment to the Pochi number', async () => {
    const h = makeHarness();
    await businessToPochi(h.ctx, { phoneNumber: '0712345678', amount: 300 });
    const body = h.lastBody();

    expect(body.CommandID).toBe('BusinessPayment');
    expect(body.PartyB).toBe('254712345678');
    expect(body.InitiatorName).toBe('testapi');
  });

  it('rejects an invalid Pochi number', async () => {
    const h = makeHarness();
    await expect(
      businessToPochi(h.ctx, { phoneNumber: 'abc', amount: 1 }),
    ).rejects.toMatchObject({ kind: 'validation' });
  });
});

describe('accountBalance', () => {
  it('queries with the organisation identifier type', async () => {
    const h = makeHarness();
    await accountBalance(h.ctx, {});
    const body = h.lastBody();

    expect(body.CommandID).toBe('AccountBalance');
    expect(body.PartyA).toBe('174379');
    expect(body.IdentifierType).toBe('4');
    expect(body.Remarks).toBe('Balance query');
  });

  it('accepts a shortcode override', async () => {
    const h = makeHarness();
    await accountBalance(h.ctx, { shortCode: '600000' });
    expect(h.lastBody().PartyA).toBe('600000');
  });
});

describe('transactionStatus', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('queries by receipt number', async () => {
    await transactionStatus(h.ctx, { transactionId: 'NEF61H8J60' });
    const body = h.lastBody();
    expect(body.CommandID).toBe('TransactionStatusQuery');
    expect(body.TransactionID).toBe('NEF61H8J60');
  });

  it('spells the occasion field with one s here', async () => {
    await transactionStatus(h.ctx, { transactionId: 'X' });
    const body = h.lastBody();
    // B2C uses "Occassion"; this endpoint uses "Occasion".
    expect(body.Occasion).toBe('');
    expect(body.Occassion).toBeUndefined();
  });

  it('falls back to the conversation id when there is no receipt', async () => {
    await transactionStatus(h.ctx, { originalConversationId: 'AG_123' });
    const body = h.lastBody();
    expect(body.OriginalConversationID).toBe('AG_123');
    expect(body.TransactionID).toBe('');
  });

  it('omits the conversation id when querying by receipt', async () => {
    await transactionStatus(h.ctx, { transactionId: 'NEF61H8J60' });
    expect(h.lastBody().OriginalConversationID).toBeUndefined();
  });

  it('requires at least one identifier', async () => {
    await expect(transactionStatus(h.ctx, {})).rejects.toMatchObject({ kind: 'validation' });
  });
});

describe('reversal', () => {
  it('uses identifier type 11, which is specific to reversals', async () => {
    const h = makeHarness();
    await reversal(h.ctx, { transactionId: 'PDU91HIVIT', amount: 200 });
    const body = h.lastBody();

    expect(body.CommandID).toBe('TransactionReversal');
    expect(body.TransactionID).toBe('PDU91HIVIT');
    // Other products send 4 here; the reversal API wants 11.
    expect(body.RecieverIdentifierType).toBe('11');
    expect(body.ReceiverParty).toBe('174379');
  });

  it('accepts a receiver shortcode override', async () => {
    const h = makeHarness();
    await reversal(h.ctx, {
      transactionId: 'X',
      amount: 1,
      receiverShortCode: '603021',
    });
    expect(h.lastBody().ReceiverParty).toBe('603021');
  });
});

describe('flattenResultParameters', () => {
  it('turns the Key/Value array into an object', () => {
    const payload = fx.b2c.resultSuccess({
      originatorConversationId: 'oc-1',
      conversationId: 'c-1',
      amount: 250,
      phone: '254712345678',
    });
    const flat = flattenResultParameters(payload);
    expect(flat?.TransactionAmount).toBe(250);
    expect(flat?.TransactionReceipt).toBeTruthy();
  });

  it('returns null when there are no result parameters', () => {
    expect(flattenResultParameters({ Result: { ResultCode: 1 } })).toBeNull();
    expect(flattenResultParameters({})).toBeNull();
    expect(flattenResultParameters(null)).toBeNull();
  });
});

describe('b2cPaymentAndWait', () => {
  let dir: string;
  let receiver: CallbackReceiver;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'daraja-b2c-'));
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

  it('returns the settled result correlated on ConversationID', async () => {
    const h = makeHarness({}, { receiver });
    h.reply({
      OriginatorConversationID: 'oc-1',
      ConversationID: 'AG_settle',
      ResponseCode: '0',
    });

    const pending = b2cPaymentAndWait(h.ctx, {
      phoneNumber: '0712345678',
      amount: 250,
      timeoutSeconds: 5,
    });

    await new Promise((r) => setTimeout(r, 30));
    await fetch(`http://127.0.0.1:${receiver.port}/cb/b2c`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        fx.b2c.resultSuccess({
          originatorConversationId: 'oc-1',
          conversationId: 'AG_settle',
          amount: 250,
          phone: '254712345678',
        }),
      ),
    });

    const result = (await pending) as any;
    expect(result.status).toBe('success');
    expect(result.details.TransactionReceipt).toBeTruthy();
  });

  it('reports pending when no result callback arrives', async () => {
    const h = makeHarness({}, { receiver });
    h.reply({ OriginatorConversationID: 'oc-2', ConversationID: 'AG_slow', ResponseCode: '0' });

    const result = (await b2cPaymentAndWait(h.ctx, {
      phoneNumber: '0712345678',
      amount: 1,
      timeoutSeconds: 0.05 as number,
    })) as any;

    expect(result.status).toBe('pending');
    expect(result.message).toContain('transaction_status');
  });

  it('falls back to the originator id when Daraja returns no conversation id', async () => {
    const h = makeHarness({}, { receiver });
    h.reply({ ResponseCode: '0' });

    const result = (await b2cPaymentAndWait(h.ctx, {
      phoneNumber: '0712345678',
      amount: 1,
      timeoutSeconds: 0.05 as number,
    })) as any;

    expect(result.conversationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses to wait with no receiver', async () => {
    const h = makeHarness({}, { receiver: null });
    await expect(
      b2cPaymentAndWait(h.ctx, { phoneNumber: '0712345678', amount: 1 }),
    ).rejects.toMatchObject({ kind: 'config' });
  });
});
