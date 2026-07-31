import { z } from 'zod';
import { DarajaError } from '../errors.js';
import { normaliseMsisdn, stkCredentials } from '../crypto.js';
import { callbackUrl, requireConfig, type ToolContext } from './context.js';

/** Shared input pieces, so validation messages stay consistent across tools. */
const phone = z
  .string()
  .describe('Customer phone number. Accepts 07..., +2547..., or 2547... and is normalised.');

const amount = z
  .number()
  .int('M-Pesa only accepts whole shillings.')
  .positive()
  .describe('Amount in KES. Whole numbers only.');

function msisdnOrThrow(input: string): string {
  const normalised = normaliseMsisdn(input);
  if (!normalised) {
    throw new DarajaError({
      kind: 'validation',
      message: `"${input}" is not a valid Kenyan mobile number`,
      hint: 'Expected a Safaricom-format number such as 0712345678 or 254712345678.',
    });
  }
  return normalised;
}

/**
 * Daraja enforces these limits server-side but reports violations with an
 * opaque code, so check locally and say what is actually wrong.
 */
function checkFieldLengths(accountReference?: string, transactionDesc?: string): void {
  if (accountReference && accountReference.length > 12) {
    throw new DarajaError({
      kind: 'validation',
      message: `AccountReference is ${accountReference.length} characters; the maximum is 12`,
      hint: 'Daraja rejects longer values with a generic bad-request error.',
    });
  }
  if (transactionDesc && transactionDesc.length > 13) {
    throw new DarajaError({
      kind: 'validation',
      message: `TransactionDesc is ${transactionDesc.length} characters; the maximum is 13`,
    });
  }
}

// ---------------------------------------------------------------------------
// M-Pesa Express (STK push)
// ---------------------------------------------------------------------------

export const stkPushInput = {
  phoneNumber: phone,
  amount,
  accountReference: z
    .string()
    .max(12)
    .optional()
    .describe('Account identifier shown on the customer statement. Max 12 characters.'),
  transactionDesc: z.string().max(13).optional().describe('Short description. Max 13 characters.'),
  shortCode: z.string().optional().describe('Overrides DARAJA_SHORTCODE.'),
  callbackUrl: z.string().url().optional().describe('Overrides the built-in receiver URL.'),
  transactionType: z
    .enum(['CustomerPayBillOnline', 'CustomerBuyGoodsOnline'])
    .default('CustomerPayBillOnline')
    .describe('PayBill or Buy Goods. Must match the shortcode type.'),
};

export async function stkPush(
  ctx: ToolContext,
  args: {
    phoneNumber: string;
    amount: number;
    accountReference?: string;
    transactionDesc?: string;
    shortCode?: string;
    callbackUrl?: string;
    transactionType?: 'CustomerPayBillOnline' | 'CustomerBuyGoodsOnline';
  },
) {
  const msisdn = msisdnOrThrow(args.phoneNumber);
  const shortCode = args.shortCode ?? requireConfig(ctx, 'shortCode', 'DARAJA_SHORTCODE');
  const passkey = requireConfig(ctx, 'passkey', 'DARAJA_PASSKEY');
  checkFieldLengths(args.accountReference, args.transactionDesc);

  // Timestamp and password must be derived together or they can straddle a
  // second boundary and fail intermittently.
  const { timestamp, password } = stkCredentials(shortCode, passkey);

  const body = {
    BusinessShortCode: shortCode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: args.transactionType ?? 'CustomerPayBillOnline',
    Amount: String(args.amount),
    PartyA: msisdn,
    PartyB: shortCode,
    PhoneNumber: msisdn,
    CallBackURL: callbackUrl(ctx, 'stk', args.callbackUrl),
    AccountReference: args.accountReference ?? 'Payment',
    TransactionDesc: args.transactionDesc ?? 'Payment',
  };

  return ctx.client.post('/mpesa/stkpush/v1/processrequest', body);
}

/**
 * Initiate an STK push and wait for the customer to respond.
 *
 * This is the tool that makes Daraja usable from an agent. The plain push
 * returns "accepted", which tells you nothing about whether money moved; the
 * truth arrives on a callback up to a minute later. Here we block on the
 * callback and return the settled outcome.
 */
export async function stkPushAndWait(
  ctx: ToolContext,
  args: Parameters<typeof stkPush>[1] & { timeoutSeconds?: number },
) {
  if (!ctx.receiver) {
    throw new DarajaError({
      kind: 'config',
      message: 'stk_push_and_wait requires the built-in callback receiver',
      hint: 'Remove DARAJA_DISABLE_RECEIVER, or use stk_push plus stk_query instead.',
    });
  }

  const timeoutMs = (args.timeoutSeconds ?? 90) * 1000;
  const accepted = (await stkPush(ctx, args)) as {
    CheckoutRequestID?: string;
    MerchantRequestID?: string;
  };

  const id = accepted.CheckoutRequestID;
  if (!id) {
    return { status: 'accepted_without_id', response: accepted };
  }

  const record = await ctx.receiver.waitFor(id, timeoutMs);

  if (!record) {
    return {
      status: 'pending',
      checkoutRequestId: id,
      message:
        'No callback arrived before the timeout. The payment may still complete. ' +
        'Query it with stk_query or check get_callback using this CheckoutRequestID.',
      response: accepted,
    };
  }

  return {
    status: record.outcome,
    checkoutRequestId: id,
    resultCode: record.resultCode,
    resultDesc: record.resultDesc,
    receivedAt: record.receivedAt,
    // The metadata is where the receipt number lives, and it is absent on failure.
    metadata: extractStkMetadata(record.payload),
  };
}

/** Flatten the STK metadata array into an object. Absent on failed payments. */
function extractStkMetadata(payload: unknown): Record<string, unknown> | null {
  const items = (payload as any)?.Body?.stkCallback?.CallbackMetadata?.Item;
  if (!Array.isArray(items)) return null;
  const out: Record<string, unknown> = {};
  for (const item of items) {
    if (item?.Name !== undefined) out[item.Name] = item.Value;
  }
  return out;
}

export const stkQueryInput = {
  checkoutRequestId: z.string().describe('The CheckoutRequestID returned by stk_push.'),
  shortCode: z.string().optional(),
};

export async function stkQuery(
  ctx: ToolContext,
  args: { checkoutRequestId: string; shortCode?: string },
) {
  const shortCode = args.shortCode ?? requireConfig(ctx, 'shortCode', 'DARAJA_SHORTCODE');
  const passkey = requireConfig(ctx, 'passkey', 'DARAJA_PASSKEY');
  const { timestamp, password } = stkCredentials(shortCode, passkey);

  return ctx.client.post(
    '/mpesa/stkpushquery/v1/query',
    {
      BusinessShortCode: shortCode,
      Password: password,
      Timestamp: timestamp,
      CheckoutRequestID: args.checkoutRequestId,
    },
    // A status query is read-only, so retrying it is safe.
    { retryable: true },
  );
}

// ---------------------------------------------------------------------------
// M-Pesa Ratiba (standing orders)
// ---------------------------------------------------------------------------

/** Frequency codes as published in the Ratiba documentation. */
export const RATIBA_FREQUENCIES = {
  'one-off': '1',
  daily: '2',
  weekly: '3',
  'bi-weekly': '4',
  monthly: '5',
  'bi-monthly': '6',
  quarterly: '7',
  'half-yearly': '8',
  yearly: '9',
} as const;

export type RatibaFrequency = keyof typeof RATIBA_FREQUENCIES;

/** Daraja wants yyyymmdd. Accept an ISO date too, since that is what models emit. */
function toDarajaDate(input: string, field: string): string {
  const compact = input.replace(/-/g, '');
  if (!/^\d{8}$/.test(compact)) {
    throw new DarajaError({
      kind: 'validation',
      message: `${field} must be a date in yyyymmdd or yyyy-mm-dd form, got "${input}"`,
    });
  }
  return compact;
}

export const ratibaCreateInput = {
  standingOrderName: z
    .string()
    .describe(
      'Name of the standing order. Must be unique for this customer; a repeat name is rejected.',
    ),
  phoneNumber: phone,
  amount,
  startDate: z.string().describe('First execution date, yyyymmdd or yyyy-mm-dd.'),
  endDate: z.string().describe('Final execution date, yyyymmdd or yyyy-mm-dd.'),
  frequency: z
    .enum([
      'one-off',
      'daily',
      'weekly',
      'bi-weekly',
      'monthly',
      'bi-monthly',
      'quarterly',
      'half-yearly',
      'yearly',
    ])
    .describe('How often the standing order executes.'),
  receiverType: z
    .enum(['paybill', 'till'])
    .default('paybill')
    .describe('Whether the shortcode is a PayBill or a Buy Goods till.'),
  accountReference: z.string().max(12).optional(),
  transactionDesc: z.string().max(13).optional(),
  shortCode: z.string().optional(),
  callbackUrl: z.string().url().optional(),
};

export async function ratibaCreate(
  ctx: ToolContext,
  args: {
    standingOrderName: string;
    phoneNumber: string;
    amount: number;
    startDate: string;
    endDate: string;
    frequency: RatibaFrequency;
    receiverType?: 'paybill' | 'till';
    accountReference?: string;
    transactionDesc?: string;
    shortCode?: string;
    callbackUrl?: string;
  },
) {
  const msisdn = msisdnOrThrow(args.phoneNumber);
  const shortCode = args.shortCode ?? requireConfig(ctx, 'shortCode', 'DARAJA_SHORTCODE');
  checkFieldLengths(args.accountReference, args.transactionDesc);

  const start = toDarajaDate(args.startDate, 'startDate');
  const end = toDarajaDate(args.endDate, 'endDate');
  if (end < start) {
    throw new DarajaError({
      kind: 'validation',
      message: `endDate (${end}) is before startDate (${start})`,
    });
  }

  const isTill = (args.receiverType ?? 'paybill') === 'till';

  // Client-generated UUID, echoed back in the callback as both requestRefID and
  // responseRefID. It is how we correlate the async result.
  const customStoId = crypto.randomUUID();

  const body = {
    // The published sample spells this "StandingOrderNameName" while the
    // parameter table says "StandingOrderName". Send both; Daraja ignores the
    // one it does not recognise, and this survives whichever they fix.
    StandingOrderName: args.standingOrderName,
    StandingOrderNameName: args.standingOrderName,
    StartDate: start,
    EndDate: end,
    BusinessShortCode: shortCode,
    TransactionType: isTill
      ? 'Standing Order Pay Merchant External Third Party'
      : 'Standing Order Pay Bill External Third Party',
    ReceiverPartyIdentifierType: isTill ? '2' : '4',
    Amount: String(args.amount),
    PartyA: msisdn,
    CallBackURL: callbackUrl(ctx, 'ratiba', args.callbackUrl),
    AccountReference: args.accountReference ?? args.standingOrderName.slice(0, 12),
    TransactionDesc: args.transactionDesc ?? 'Standing order',
    Frequency: RATIBA_FREQUENCIES[args.frequency],
    // Same doubled-spelling situation as the name field.
    CustomStoId: customStoId,
    CustomstdoId: customStoId,
  };

  const response = await ctx.client.post('/standingorder/v1/createStandingOrderExternal', body);

  return {
    response,
    correlationId: customStoId,
    note:
      'The customer must approve the M-Pesa prompt before the standing order becomes active. ' +
      'The result arrives on the callback; look it up with get_callback using this correlationId.',
  };
}

export async function ratibaCreateAndWait(
  ctx: ToolContext,
  args: Parameters<typeof ratibaCreate>[1] & { timeoutSeconds?: number },
) {
  if (!ctx.receiver) {
    throw new DarajaError({
      kind: 'config',
      message: 'ratiba_create_and_wait requires the built-in callback receiver',
    });
  }

  const timeoutMs = (args.timeoutSeconds ?? 90) * 1000;
  const created = await ratibaCreate(ctx, args);
  const record = await ctx.receiver.waitFor(created.correlationId, timeoutMs);

  if (!record) {
    return {
      status: 'pending',
      correlationId: created.correlationId,
      message: 'No callback arrived before the timeout. The standing order may still be created.',
    };
  }

  return {
    status: record.outcome,
    correlationId: created.correlationId,
    resultCode: record.resultCode,
    resultDesc: record.resultDesc,
    details: flattenRatibaData(record.payload),
  };
}

/** Ratiba returns its data as name/value pairs, with the casing varying by outcome. */
function flattenRatibaData(payload: unknown): Record<string, unknown> | null {
  const p = payload as any;
  const data = p?.responseBody?.responseData ?? p?.ResponseBody?.ResponseData;
  if (!Array.isArray(data)) return null;
  const out: Record<string, unknown> = {};
  for (const item of data) {
    const key = item?.name ?? item?.Name;
    const value = item?.value ?? item?.Value;
    if (key !== undefined) out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dynamic QR
// ---------------------------------------------------------------------------

export const qrInput = {
  merchantName: z.string().describe('Name shown to the customer scanning the code.'),
  refNo: z.string().describe('Your reference for the transaction.'),
  amount,
  trxCode: z
    .enum(['BG', 'WA', 'PB', 'SM', 'SB'])
    .describe('BG buy goods, WA withdraw agent, PB paybill, SM send money, SB send to business.'),
  cpi: z.string().describe('Till, paybill, or phone number the payment goes to.'),
  size: z.string().default('300').describe('QR image size in pixels.'),
};

export async function generateQr(
  ctx: ToolContext,
  args: {
    merchantName: string;
    refNo: string;
    amount: number;
    trxCode: 'BG' | 'WA' | 'PB' | 'SM' | 'SB';
    cpi: string;
    size?: string;
  },
) {
  return ctx.client.post('/mpesa/qrcode/v1/generate', {
    MerchantName: args.merchantName,
    RefNo: args.refNo,
    Amount: args.amount,
    TrxCode: args.trxCode,
    CPI: args.cpi,
    Size: args.size ?? '300',
  });
}
