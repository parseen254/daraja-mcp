import { z } from 'zod';
import { DarajaError } from '../errors.js';
import { normaliseMsisdn } from '../crypto.js';
import { callbackUrl, requireConfig, type ToolContext } from './context.js';
import type { CallbackKind } from '../callbacks/store.js';

/**
 * C2B, the identity and security cluster, pull transactions, and the tools for
 * inspecting callbacks the server has received.
 *
 * The identity APIs are new in Daraja 3.0 and are genuinely useful for fraud
 * work: checking whether a SIM was swapped recently before disbursing to it is
 * a cheap control against SIM-swap fraud.
 */

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

// ---------------------------------------------------------------------------
// C2B
// ---------------------------------------------------------------------------

export const c2bRegisterInput = {
  shortCode: z.string().optional(),
  responseType: z
    .enum(['Completed', 'Cancelled'])
    .default('Completed')
    .describe(
      'What Daraja should do when your validation endpoint is unreachable. Completed accepts the payment anyway; Cancelled rejects it.',
    ),
  confirmationUrl: z.string().url().optional(),
  validationUrl: z.string().url().optional(),
};

export async function c2bRegisterUrls(
  ctx: ToolContext,
  args: {
    shortCode?: string;
    responseType?: 'Completed' | 'Cancelled';
    confirmationUrl?: string;
    validationUrl?: string;
  },
) {
  const shortCode = args.shortCode ?? requireConfig(ctx, 'shortCode', 'DARAJA_SHORTCODE');

  return ctx.client.post('/mpesa/c2b/v2/registerurl', {
    ShortCode: shortCode,
    ResponseType: args.responseType ?? 'Completed',
    ConfirmationURL: callbackUrl(ctx, 'c2b-confirmation', args.confirmationUrl),
    ValidationURL: callbackUrl(ctx, 'c2b-validation', args.validationUrl),
  });
}

export const c2bSimulateInput = {
  phoneNumber: z.string(),
  amount: z.number().int().positive(),
  billRefNumber: z.string().max(12).default('TEST'),
  commandId: z.enum(['CustomerPayBillOnline', 'CustomerBuyGoodsOnline']).default('CustomerPayBillOnline'),
  shortCode: z.string().optional(),
};

export async function c2bSimulate(
  ctx: ToolContext,
  args: {
    phoneNumber: string;
    amount: number;
    billRefNumber?: string;
    commandId?: 'CustomerPayBillOnline' | 'CustomerBuyGoodsOnline';
    shortCode?: string;
  },
) {
  if (ctx.client.mode === 'production') {
    throw new DarajaError({
      kind: 'validation',
      message: 'c2b_simulate is not available in production',
      hint: 'Simulation is a sandbox-only facility. In production, payments originate from real customers.',
    });
  }

  const shortCode = args.shortCode ?? requireConfig(ctx, 'shortCode', 'DARAJA_SHORTCODE');

  return ctx.client.post('/mpesa/c2b/v2/simulate', {
    ShortCode: shortCode,
    CommandID: args.commandId ?? 'CustomerPayBillOnline',
    Amount: String(args.amount),
    Msisdn: msisdnOrThrow(args.phoneNumber),
    BillRefNumber: args.billRefNumber ?? 'TEST',
  });
}

// ---------------------------------------------------------------------------
// Pull transactions
// ---------------------------------------------------------------------------

export const pullRegisterInput = {
  shortCode: z.string().optional(),
  nominatedNumber: z.string().describe('Phone number registered to receive pull notifications.'),
  callbackUrl: z.string().url().optional(),
};

export async function pullRegister(
  ctx: ToolContext,
  args: { shortCode?: string; nominatedNumber: string; callbackUrl?: string },
) {
  const shortCode = args.shortCode ?? requireConfig(ctx, 'shortCode', 'DARAJA_SHORTCODE');

  return ctx.client.post('/pulltransactions/v1/register', {
    ShortCode: shortCode,
    RequestType: 'Pull',
    NominatedNumber: msisdnOrThrow(args.nominatedNumber),
    CallBackURL: callbackUrl(ctx, 'pull', args.callbackUrl),
  });
}

export const pullQueryInput = {
  shortCode: z.string().optional(),
  startDate: z.string().describe('Start of the window, "yyyy-mm-dd hh:mm:ss".'),
  endDate: z.string().describe('End of the window, "yyyy-mm-dd hh:mm:ss".'),
  offsetValue: z.string().default('0').describe('Pagination offset.'),
};

export async function pullQuery(
  ctx: ToolContext,
  args: { shortCode?: string; startDate: string; endDate: string; offsetValue?: string },
) {
  const shortCode = args.shortCode ?? requireConfig(ctx, 'shortCode', 'DARAJA_SHORTCODE');

  return ctx.client.post(
    '/pulltransactions/v1/query',
    {
      ShortCode: shortCode,
      StartDate: args.startDate,
      EndDate: args.endDate,
      OffSetValue: args.offsetValue ?? '0',
    },
    { retryable: true },
  );
}

// ---------------------------------------------------------------------------
// Identity and security cluster
// ---------------------------------------------------------------------------

export const simSwapInput = {
  phoneNumber: z.string().describe('Number to check.'),
};

export async function checkSimSwap(ctx: ToolContext, args: { phoneNumber: string }) {
  // Useful as a pre-disbursement control: a SIM swapped hours ago is a strong
  // fraud signal, and this is far cheaper than a chargeback.
  return ctx.client.post(
    '/imsi/v2/checkATI',
    { msisdn: msisdnOrThrow(args.phoneNumber) },
    { retryable: true },
  );
}

export const ageOnNetworkInput = {
  phoneNumber: z.string().describe('Number to check.'),
};

export async function checkAgeOnNetwork(ctx: ToolContext, args: { phoneNumber: string }) {
  return ctx.client.post(
    '/registration/lookup/v1/checkATI',
    { msisdn: msisdnOrThrow(args.phoneNumber) },
    { retryable: true },
  );
}

export const validateIdentityInput = {
  phoneNumber: z.string().describe('Number to validate.'),
  idNumber: z.string().describe('National ID number the line should be registered against.'),
};

export async function validateIdentity(
  ctx: ToolContext,
  args: { phoneNumber: string; idNumber: string },
) {
  return ctx.client.post(
    '/v1/KYC-validation/validateID',
    {
      msisdn: msisdnOrThrow(args.phoneNumber),
      IDNumber: args.idNumber,
    },
    { retryable: true },
  );
}

export const orgInfoInput = {
  shortCode: z.string().describe('PayBill or till number to look up.'),
  identifierType: z
    .enum(['4', '2'])
    .default('4')
    .describe('4 for PayBill, 2 for a Buy Goods till.'),
};

export async function queryOrgInfo(
  ctx: ToolContext,
  args: { shortCode: string; identifierType?: '4' | '2' },
) {
  // Confirms the receiving business name before paying, which catches
  // fat-fingered shortcodes before the money leaves.
  return ctx.client.post(
    '/sfcverify/v1/query/info',
    {
      IdentifierType: args.identifierType ?? '4',
      Identifier: args.shortCode,
    },
    { retryable: true },
  );
}

// ---------------------------------------------------------------------------
// Callback inspection
// ---------------------------------------------------------------------------

export const listCallbacksInput = {
  limit: z.number().int().positive().max(100).default(20),
  kind: z
    .enum([
      'stk',
      'b2c',
      'b2b',
      'balance',
      'status',
      'reversal',
      'ratiba',
      'c2b-validation',
      'c2b-confirmation',
      'timeout',
      'unknown',
    ])
    .optional()
    .describe('Filter to one product family.'),
};

export function listCallbacks(
  ctx: ToolContext,
  args: { limit?: number; kind?: CallbackKind },
) {
  if (!ctx.receiver) {
    throw new DarajaError({
      kind: 'config',
      message: 'The callback receiver is not running, so no callbacks have been recorded',
    });
  }

  const records = ctx.receiver.store.list({
    limit: args.limit ?? 20,
    ...(args.kind ? { kind: args.kind } : {}),
  });

  // Return a summary rather than full payloads; a listing of twenty raw
  // callbacks is mostly noise in a model's context.
  return {
    count: records.length,
    callbacks: records.map((r) => ({
      seq: r.seq,
      receivedAt: r.receivedAt,
      kind: r.kind,
      correlationId: r.correlationId,
      outcome: r.outcome,
      resultCode: r.resultCode,
      resultDesc: r.resultDesc,
    })),
  };
}

export const getCallbackInput = {
  correlationId: z
    .string()
    .describe('CheckoutRequestID, ConversationID, or the Ratiba correlationId.'),
};

export function getCallback(ctx: ToolContext, args: { correlationId: string }) {
  if (!ctx.receiver) {
    throw new DarajaError({
      kind: 'config',
      message: 'The callback receiver is not running',
    });
  }

  const record = ctx.receiver.store.findByCorrelationId(args.correlationId);
  if (!record) {
    return {
      found: false,
      correlationId: args.correlationId,
      message: 'No callback recorded for this id yet. It may still be in flight.',
    };
  }

  return { found: true, ...record };
}

export function serverHealth(ctx: ToolContext) {
  return {
    mode: ctx.client.mode,
    baseUrl: ctx.client.baseUrl,
    shortCodeConfigured: Boolean(ctx.config.shortCode),
    passkeyConfigured: Boolean(ctx.config.passkey),
    initiatorConfigured: Boolean(
      ctx.config.initiatorName && ctx.config.securityCredential,
    ),
    callbackReceiver: ctx.receiver
      ? {
          running: true,
          publicBaseUrl: ctx.receiver.baseUrl(),
          sourceVerification:
            ctx.config.callback.allowedCidrs.length > 0
              ? `${ctx.config.callback.allowedCidrs.length} allowed ranges`
              : 'disabled (all sources accepted)',
          pathSecret: ctx.config.callback.pathSecret ? 'set' : 'not set',
          stored: ctx.receiver.store.size,
          stats: ctx.receiver.stats,
        }
      : { running: false },
  };
}
