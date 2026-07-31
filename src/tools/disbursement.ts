import { z } from 'zod';
import { DarajaError } from '../errors.js';
import { normaliseMsisdn } from '../crypto.js';
import { callbackUrl, requireConfig, type ToolContext } from './context.js';

/**
 * Money-out and business-to-business products.
 *
 * These all share the same asynchronous envelope: an immediate acknowledgement,
 * then the real outcome on ResultURL. They also share the initiator credential
 * pair, which is separate from the OAuth consumer key and a frequent source of
 * "Invalid Initiator Information" errors.
 *
 * Note the field naming across this family is inconsistent in Daraja itself:
 * B2C uses "InitiatorName" while B2B and the treasury APIs use "Initiator",
 * and "RecieverIdentifierType" is misspelled in the published specification.
 * Both are reproduced verbatim because Daraja rejects the corrected spellings.
 */

const amount = z.number().int().positive().describe('Amount in KES, whole numbers only.');

function msisdnOrThrow(input: string): string {
  const normalised = normaliseMsisdn(input);
  if (!normalised) {
    throw new DarajaError({
      kind: 'validation',
      message: `"${input}" is not a valid Kenyan mobile number`,
    });
  }
  return normalised;
}

/** Initiator credentials, shared by every product in this file. */
function initiatorCreds(ctx: ToolContext): { initiator: string; credential: string } {
  return {
    initiator: requireConfig(ctx, 'initiatorName', 'DARAJA_INITIATOR_NAME'),
    credential: requireConfig(ctx, 'securityCredential', 'DARAJA_SECURITY_CREDENTIAL'),
  };
}

/** Both URLs are mandatory; Daraja rejects the request without them. */
function asyncUrls(ctx: ToolContext, kind: string, explicit?: string) {
  const url = callbackUrl(ctx, kind, explicit);
  return { ResultURL: url, QueueTimeOutURL: callbackUrl(ctx, 'timeout', explicit ? url : undefined) };
}

// ---------------------------------------------------------------------------
// B2C: business to customer
// ---------------------------------------------------------------------------

export const b2cInput = {
  phoneNumber: z.string().describe('Recipient phone number.'),
  amount,
  commandId: z
    .enum(['BusinessPayment', 'SalaryPayment', 'PromotionPayment'])
    .default('BusinessPayment')
    .describe(
      'BusinessPayment for general payouts, SalaryPayment for salaries (allows unregistered recipients), PromotionPayment for winnings.',
    ),
  remarks: z.string().max(100).default('Payment'),
  occasion: z.string().max(100).optional(),
  shortCode: z.string().optional(),
  resultUrl: z.string().url().optional(),
};

export async function b2cPayment(
  ctx: ToolContext,
  args: {
    phoneNumber: string;
    amount: number;
    commandId?: 'BusinessPayment' | 'SalaryPayment' | 'PromotionPayment';
    remarks?: string;
    occasion?: string;
    shortCode?: string;
    resultUrl?: string;
  },
) {
  const { initiator, credential } = initiatorCreds(ctx);
  const shortCode = args.shortCode ?? requireConfig(ctx, 'shortCode', 'DARAJA_SHORTCODE');
  const urls = asyncUrls(ctx, 'b2c', args.resultUrl);
  const originatorConversationId = crypto.randomUUID();

  const response = await ctx.client.post('/mpesa/b2c/v3/paymentrequest', {
    OriginatorConversationID: originatorConversationId,
    // B2C is the only product using "InitiatorName" rather than "Initiator".
    InitiatorName: initiator,
    SecurityCredential: credential,
    CommandID: args.commandId ?? 'BusinessPayment',
    Amount: String(args.amount),
    PartyA: shortCode,
    PartyB: msisdnOrThrow(args.phoneNumber),
    Remarks: args.remarks ?? 'Payment',
    ...urls,
    // Daraja spells this "Occassion" in the request specification.
    Occassion: args.occasion ?? '',
  });

  return { response, originatorConversationId };
}

export async function b2cPaymentAndWait(
  ctx: ToolContext,
  args: Parameters<typeof b2cPayment>[1] & { timeoutSeconds?: number },
) {
  if (!ctx.receiver) {
    throw new DarajaError({
      kind: 'config',
      message: 'b2c_payment_and_wait requires the built-in callback receiver',
    });
  }

  const timeoutMs = (args.timeoutSeconds ?? 120) * 1000;
  const sent = await b2cPayment(ctx, args);
  const conversationId = (sent.response as { ConversationID?: string }).ConversationID;

  // The result callback correlates on ConversationID, which Daraja assigns.
  const id = conversationId ?? sent.originatorConversationId;
  const record = await ctx.receiver.waitFor(id, timeoutMs);

  if (!record) {
    return {
      status: 'pending',
      conversationId: id,
      message: 'No result callback before the timeout. Query with transaction_status before resending.',
    };
  }

  return {
    status: record.outcome,
    conversationId: id,
    resultCode: record.resultCode,
    resultDesc: record.resultDesc,
    details: flattenResultParameters(record.payload),
  };
}

/** The Result envelope nests its data as Key/Value pairs. */
export function flattenResultParameters(payload: unknown): Record<string, unknown> | null {
  const params = (payload as any)?.Result?.ResultParameters?.ResultParameter;
  if (!Array.isArray(params)) return null;
  const out: Record<string, unknown> = {};
  for (const p of params) {
    if (p?.Key !== undefined) out[p.Key] = p.Value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// B2B: business pay bill, buy goods, account top up, tax remittance
// ---------------------------------------------------------------------------

const B2B_COMMANDS = {
  paybill: 'BusinessPayBill',
  buygoods: 'BusinessBuyGoods',
  topup: 'BusinessPayToBulk',
} as const;

export const b2bInput = {
  target: z
    .enum(['paybill', 'buygoods', 'topup'])
    .describe('paybill pays a PayBill, buygoods pays a till, topup funds a B2C working account.'),
  receiverShortCode: z.string().describe('Shortcode being paid.'),
  amount,
  accountReference: z
    .string()
    .max(12)
    .optional()
    .describe('Required for paybill. Ignored for buy goods.'),
  requester: z.string().optional().describe('Optional phone number of the person on whose behalf you are paying.'),
  remarks: z.string().max(100).default('Payment'),
  shortCode: z.string().optional(),
  resultUrl: z.string().url().optional(),
};

export async function b2bPayment(
  ctx: ToolContext,
  args: {
    target: 'paybill' | 'buygoods' | 'topup';
    receiverShortCode: string;
    amount: number;
    accountReference?: string;
    requester?: string;
    remarks?: string;
    shortCode?: string;
    resultUrl?: string;
  },
) {
  const { initiator, credential } = initiatorCreds(ctx);
  const shortCode = args.shortCode ?? requireConfig(ctx, 'shortCode', 'DARAJA_SHORTCODE');

  if (args.target === 'paybill' && !args.accountReference) {
    throw new DarajaError({
      kind: 'validation',
      message: 'accountReference is required when paying a PayBill',
      hint: 'This is the account number the receiving business uses to identify the payment.',
    });
  }

  // All three products share one endpoint and differ only by CommandID.
  return ctx.client.post('/mpesa/b2b/v1/paymentrequest', {
    Initiator: initiator,
    SecurityCredential: credential,
    CommandID: B2B_COMMANDS[args.target],
    SenderIdentifierType: '4',
    // Misspelled in the Daraja specification; the correct spelling is rejected.
    RecieverIdentifierType: '4',
    Amount: String(args.amount),
    PartyA: shortCode,
    PartyB: args.receiverShortCode,
    AccountReference: args.accountReference ?? '',
    ...(args.requester ? { Requester: msisdnOrThrow(args.requester) } : {}),
    Remarks: args.remarks ?? 'Payment',
    ...asyncUrls(ctx, 'b2b', args.resultUrl),
  });
}

export const taxRemittanceInput = {
  amount,
  paymentRegistrationNumber: z
    .string()
    .describe('KRA Payment Registration Number (PRN) for the tax being paid.'),
  remarks: z.string().max(100).default('Tax payment'),
  shortCode: z.string().optional(),
  resultUrl: z.string().url().optional(),
};

export async function taxRemittance(
  ctx: ToolContext,
  args: {
    amount: number;
    paymentRegistrationNumber: string;
    remarks?: string;
    shortCode?: string;
    resultUrl?: string;
  },
) {
  const { initiator, credential } = initiatorCreds(ctx);
  const shortCode = args.shortCode ?? requireConfig(ctx, 'shortCode', 'DARAJA_SHORTCODE');

  return ctx.client.post('/mpesa/b2b/v1/remittax', {
    Initiator: initiator,
    SecurityCredential: credential,
    CommandID: 'PayTaxToKRA',
    SenderIdentifierType: '4',
    RecieverIdentifierType: '4',
    Amount: String(args.amount),
    PartyA: shortCode,
    // KRA's collection shortcode is fixed.
    PartyB: '572572',
    AccountReference: args.paymentRegistrationNumber,
    Remarks: args.remarks ?? 'Tax payment',
    ...asyncUrls(ctx, 'b2b', args.resultUrl),
  });
}

export const pochiInput = {
  phoneNumber: z.string().describe('Pochi la Biashara number receiving the payment.'),
  amount,
  remarks: z.string().max(100).default('Payment'),
  shortCode: z.string().optional(),
  resultUrl: z.string().url().optional(),
};

export async function businessToPochi(
  ctx: ToolContext,
  args: {
    phoneNumber: string;
    amount: number;
    remarks?: string;
    shortCode?: string;
    resultUrl?: string;
  },
) {
  const { initiator, credential } = initiatorCreds(ctx);
  const shortCode = args.shortCode ?? requireConfig(ctx, 'shortCode', 'DARAJA_SHORTCODE');

  return ctx.client.post('/mpesa/b2pochi/v1/paymentrequest', {
    InitiatorName: initiator,
    SecurityCredential: credential,
    CommandID: 'BusinessPayment',
    Amount: String(args.amount),
    PartyA: shortCode,
    PartyB: msisdnOrThrow(args.phoneNumber),
    Remarks: args.remarks ?? 'Payment',
    ...asyncUrls(ctx, 'b2c', args.resultUrl),
  });
}

// ---------------------------------------------------------------------------
// Treasury: balance, status, reversal
// ---------------------------------------------------------------------------

export const accountBalanceInput = {
  shortCode: z.string().optional(),
  remarks: z.string().max(100).default('Balance query'),
  resultUrl: z.string().url().optional(),
};

export async function accountBalance(
  ctx: ToolContext,
  args: { shortCode?: string; remarks?: string; resultUrl?: string },
) {
  const { initiator, credential } = initiatorCreds(ctx);
  const shortCode = args.shortCode ?? requireConfig(ctx, 'shortCode', 'DARAJA_SHORTCODE');

  return ctx.client.post('/mpesa/accountbalance/v1/query', {
    Initiator: initiator,
    SecurityCredential: credential,
    CommandID: 'AccountBalance',
    PartyA: shortCode,
    IdentifierType: '4',
    Remarks: args.remarks ?? 'Balance query',
    ...asyncUrls(ctx, 'balance', args.resultUrl),
  });
}

export const transactionStatusInput = {
  transactionId: z
    .string()
    .optional()
    .describe('M-Pesa receipt number, for example NEF61H8J60.'),
  originalConversationId: z
    .string()
    .optional()
    .describe('Use when you never received a receipt number.'),
  shortCode: z.string().optional(),
  remarks: z.string().max(100).default('Status query'),
  resultUrl: z.string().url().optional(),
};

export async function transactionStatus(
  ctx: ToolContext,
  args: {
    transactionId?: string;
    originalConversationId?: string;
    shortCode?: string;
    remarks?: string;
    resultUrl?: string;
  },
) {
  if (!args.transactionId && !args.originalConversationId) {
    throw new DarajaError({
      kind: 'validation',
      message: 'Provide either transactionId or originalConversationId',
      hint: 'Use originalConversationId when the request timed out before returning a receipt.',
    });
  }

  const { initiator, credential } = initiatorCreds(ctx);
  const shortCode = args.shortCode ?? requireConfig(ctx, 'shortCode', 'DARAJA_SHORTCODE');

  return ctx.client.post('/mpesa/transactionstatus/v1/query', {
    Initiator: initiator,
    SecurityCredential: credential,
    CommandID: 'TransactionStatusQuery',
    TransactionID: args.transactionId ?? '',
    ...(args.originalConversationId
      ? { OriginalConversationID: args.originalConversationId }
      : {}),
    PartyA: shortCode,
    IdentifierType: '4',
    Remarks: args.remarks ?? 'Status query',
    Occasion: '',
    ...asyncUrls(ctx, 'status', args.resultUrl),
  });
}

export const reversalInput = {
  transactionId: z.string().describe('M-Pesa receipt number of the transaction to reverse.'),
  amount,
  receiverShortCode: z.string().optional().describe('Shortcode that received the money.'),
  remarks: z.string().max(100).default('Reversal'),
  resultUrl: z.string().url().optional(),
};

export async function reversal(
  ctx: ToolContext,
  args: {
    transactionId: string;
    amount: number;
    receiverShortCode?: string;
    remarks?: string;
    resultUrl?: string;
  },
) {
  const { initiator, credential } = initiatorCreds(ctx);
  const shortCode = args.receiverShortCode ?? requireConfig(ctx, 'shortCode', 'DARAJA_SHORTCODE');

  return ctx.client.post('/mpesa/reversal/v1/request', {
    Initiator: initiator,
    SecurityCredential: credential,
    CommandID: 'TransactionReversal',
    TransactionID: args.transactionId,
    Amount: String(args.amount),
    ReceiverParty: shortCode,
    // 11 identifies an organisation shortcode in the reversal API specifically.
    RecieverIdentifierType: '11',
    Remarks: args.remarks ?? 'Reversal',
    ...asyncUrls(ctx, 'reversal', args.resultUrl),
  });
}
