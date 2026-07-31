/**
 * Daraja's error surface is notoriously inconsistent: numeric codes in some
 * responses, string codes in others, HTTP status in a third place, and the same
 * logical failure reported differently per product. This module normalises it
 * into one typed shape so tool callers get an actionable message instead of a
 * raw dump.
 */

export type DarajaErrorKind =
  | 'auth'
  | 'validation'
  | 'insufficient_funds'
  | 'duplicate'
  | 'not_found'
  | 'rate_limit'
  | 'timeout'
  | 'cancelled_by_user'
  | 'upstream'
  | 'config'
  | 'unknown';

export class DarajaError extends Error {
  readonly kind: DarajaErrorKind;
  readonly code: string | undefined;
  readonly httpStatus: number | undefined;
  readonly raw: unknown;
  /** Actionable next step, surfaced to the model calling the tool. */
  readonly hint: string | undefined;

  constructor(opts: {
    kind: DarajaErrorKind;
    message: string;
    code?: string;
    httpStatus?: number;
    raw?: unknown;
    hint?: string;
  }) {
    super(opts.message);
    this.name = 'DarajaError';
    this.kind = opts.kind;
    this.code = opts.code;
    this.httpStatus = opts.httpStatus;
    this.raw = opts.raw;
    this.hint = opts.hint;
  }

  toToolResult(): string {
    const lines = [`Daraja error (${this.kind}): ${this.message}`];
    if (this.code) lines.push(`Code: ${this.code}`);
    if (this.httpStatus) lines.push(`HTTP: ${this.httpStatus}`);
    if (this.hint) lines.push(`Hint: ${this.hint}`);
    return lines.join('\n');
  }
}

/**
 * Known Daraja result codes, mapped to a kind and a hint.
 *
 * These appear in both the synchronous ResponseCode/errorCode fields and in the
 * asynchronous callback ResultCode field, which do NOT share a code space --
 * a sync 200 is success while a callback 0 is success. Kept in one table
 * because the *meaning* per code is stable within each product family.
 */
const RESULT_CODES: Record<string, { kind: DarajaErrorKind; message: string; hint?: string }> = {
  '0': { kind: 'unknown', message: 'Success' },
  '1': {
    kind: 'insufficient_funds',
    message: 'The balance is insufficient for the transaction',
    hint: 'In sandbox this is expected for amounts above the test float. Lower the amount.',
  },
  '17': {
    kind: 'validation',
    message: 'M-Pesa internal rule validation failed',
    hint: 'Usually a malformed PartyA/PartyB or an amount outside the allowed range.',
  },
  '1001': {
    kind: 'duplicate',
    message: 'A transaction is already in process for the current subscriber',
    hint: 'The customer has an unresolved STK prompt. Wait for it to time out (about 60s) before retrying.',
  },
  '1019': { kind: 'timeout', message: 'Transaction has expired' },
  '1032': {
    kind: 'cancelled_by_user',
    message: 'Request cancelled by user',
    hint: 'The customer dismissed the STK prompt. This is a normal outcome, not a fault.',
  },
  '1037': {
    kind: 'timeout',
    message: 'No response from the user, or the phone was unreachable',
    hint: 'The prompt was not answered in time. Safe to retry.',
  },
  '2001': {
    kind: 'validation',
    message: 'Wrong M-Pesa PIN entered',
    hint: 'The customer mistyped their PIN. Safe to retry.',
  },
  '404.001.03': {
    kind: 'validation',
    message: 'Invalid access token',
    hint: 'The token expired or was issued for a different environment. Re-authenticate.',
  },
  '400.002.02': {
    kind: 'validation',
    message: 'Bad request - invalid parameter in the payload',
    hint: 'Check field lengths: AccountReference max 12 chars, TransactionDesc max 13 chars.',
  },
  '500.001.1001': {
    kind: 'upstream',
    message: 'A server error occurred on the Daraja side',
    hint: 'Transient. Retry with backoff; do not treat as a payment failure without querying status.',
  },
};

export function describeResultCode(code: string | number | undefined): {
  kind: DarajaErrorKind;
  message: string;
  hint?: string;
} | null {
  if (code === undefined || code === null) return null;
  return RESULT_CODES[String(code)] ?? null;
}

/** Map an HTTP status to a kind when the body gives us nothing better. */
function kindFromStatus(status: number): DarajaErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'upstream';
  if (status >= 400) return 'validation';
  return 'unknown';
}

/**
 * Normalise any Daraja error response into a DarajaError.
 * Handles the several different error envelopes the platform uses.
 */
export function normaliseError(httpStatus: number, body: unknown): DarajaError {
  const b = (body ?? {}) as Record<string, unknown>;

  // Envelope 1: { requestId, errorCode, errorMessage } -- most common.
  const errorCode = b.errorCode ?? b.ErrorCode;
  const errorMessage = b.errorMessage ?? b.ErrorMessage;

  // Envelope 2: { ResponseCode, ResponseDescription } on a non-zero code.
  const responseCode = b.ResponseCode ?? b.responseCode;
  const responseDesc = b.ResponseDescription ?? b.responseDescription;

  // Envelope 3: { ResultCode, ResultDesc } -- callbacks and some queries.
  const resultCode = b.ResultCode ?? b.resultCode;
  const resultDesc = b.ResultDesc ?? b.resultDesc;

  const code = (errorCode ?? responseCode ?? resultCode) as string | undefined;
  const known = describeResultCode(code);

  const message =
    (errorMessage as string) ??
    (responseDesc as string) ??
    (resultDesc as string) ??
    known?.message ??
    `Request failed with HTTP ${httpStatus}`;

  return new DarajaError({
    kind: known?.kind ?? kindFromStatus(httpStatus),
    message: String(message),
    code: code !== undefined ? String(code) : undefined,
    httpStatus,
    raw: body,
    hint: known?.hint,
  });
}
