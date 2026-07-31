/**
 * Response fixtures modelled on the payloads published in the Daraja 3.0 docs.
 *
 * The point of these is fidelity to the *shapes*, including the inconsistencies:
 * ResultCode is numeric in STK callbacks but a string elsewhere, the sync
 * response uses ResponseCode while the callback uses ResultCode, and Ratiba
 * flips the casing of its envelope between the two. Code written against a
 * tidied-up mock breaks the first time it meets the real thing.
 */

let counter = 0;

/** Deterministic-ish unique id so tests can assert on shape, not value. */
function uid(prefix: string): string {
  counter += 1;
  const rand = Math.floor(Math.random() * 1e6).toString().padStart(6, '0');
  return `${prefix}${Date.now().toString().slice(-8)}${rand}${counter}`;
}

export function receiptNumber(): string {
  // Daraja receipts look like NLJ7RT61SV: 10 chars, uppercase alphanumeric.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < 10; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

export function checkoutRequestId(): string {
  return uid('ws_CO_');
}

export function merchantRequestId(): string {
  return `${Math.floor(Math.random() * 90000) + 10000}-${Math.floor(Math.random() * 90000000)}-1`;
}

export function conversationId(): string {
  return `AG_${Date.now().toString().slice(-8)}_${uid('')}`;
}

/** Daraja's transaction date format inside callback metadata: YYYYMMDDHHmmss as a number. */
export function transactionDate(date = new Date()): number {
  const eat = new Date(date.getTime() + 3 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return Number(
    `${eat.getUTCFullYear()}${pad(eat.getUTCMonth() + 1)}${pad(eat.getUTCDate())}` +
      `${pad(eat.getUTCHours())}${pad(eat.getUTCMinutes())}${pad(eat.getUTCSeconds())}`,
  );
}

export const auth = {
  success: () => ({
    access_token: `sim_${Math.random().toString(36).slice(2, 30)}`,
    expires_in: '3599',
  }),
  unauthorized: () => ({
    requestId: uid('req-'),
    errorCode: '400.008.01',
    errorMessage: 'Invalid Authentication passed',
  }),
};

export const stkPush = {
  accepted: (ids: { merchantRequestId: string; checkoutRequestId: string }) => ({
    MerchantRequestID: ids.merchantRequestId,
    CheckoutRequestID: ids.checkoutRequestId,
    ResponseCode: '0',
    ResponseDescription: 'Success. Request accepted for processing',
    CustomerMessage: 'Success. Request accepted for processing',
  }),

  /** Callback fired after the customer acts on the prompt. */
  callbackSuccess: (opts: {
    merchantRequestId: string;
    checkoutRequestId: string;
    amount: number;
    phone: string;
  }) => ({
    Body: {
      stkCallback: {
        MerchantRequestID: opts.merchantRequestId,
        CheckoutRequestID: opts.checkoutRequestId,
        // Numeric here. It is a string in several other products.
        ResultCode: 0,
        ResultDesc: 'The service request is processed successfully.',
        CallbackMetadata: {
          Item: [
            { Name: 'Amount', Value: opts.amount },
            { Name: 'MpesaReceiptNumber', Value: receiptNumber() },
            { Name: 'TransactionDate', Value: transactionDate() },
            { Name: 'PhoneNumber', Value: Number(opts.phone) },
          ],
        },
      },
    },
  }),

  callbackFailure: (opts: {
    merchantRequestId: string;
    checkoutRequestId: string;
    resultCode: number;
    resultDesc: string;
  }) => ({
    Body: {
      stkCallback: {
        MerchantRequestID: opts.merchantRequestId,
        CheckoutRequestID: opts.checkoutRequestId,
        ResultCode: opts.resultCode,
        ResultDesc: opts.resultDesc,
        // Note: no CallbackMetadata on failure. Code that reads it
        // unconditionally throws here, which is the point of testing against this.
      },
    },
  }),
};

export const stkQuery = {
  success: (ids: { merchantRequestId: string; checkoutRequestId: string }) => ({
    ResponseCode: '0',
    ResponseDescription: 'The service request has been accepted successsfully',
    MerchantRequestID: ids.merchantRequestId,
    CheckoutRequestID: ids.checkoutRequestId,
    ResultCode: '0',
    ResultDesc: 'The service request is processed successfully.',
  }),

  stillProcessing: (ids: { merchantRequestId: string; checkoutRequestId: string }) => ({
    ResponseCode: '0',
    ResponseDescription: 'The service request has been accepted successsfully',
    MerchantRequestID: ids.merchantRequestId,
    CheckoutRequestID: ids.checkoutRequestId,
    ResultCode: '1037',
    ResultDesc: 'DS timeout user cannot be reached',
  }),

  /**
   * Daraja returns HTTP 500 with this body when the checkout id is unknown or
   * the request is too old, which callers routinely mistake for an outage.
   */
  notFound: () => ({
    requestId: uid('req-'),
    errorCode: '500.001.1001',
    errorMessage: 'The transaction is being processed',
  }),
};

/** Shared shape for the async B2C / B2B / reversal / balance family. */
export const asyncAccepted = (originatorConversationId: string) => ({
  OriginatorConversationID: originatorConversationId,
  ConversationID: conversationId(),
  ResponseCode: '0',
  ResponseDescription: 'Accept the service request successfully.',
});

export const b2c = {
  resultSuccess: (opts: {
    originatorConversationId: string;
    conversationId: string;
    amount: number;
    phone: string;
  }) => ({
    Result: {
      ResultType: 0,
      ResultCode: 0,
      ResultDesc: 'The service request is processed successfully.',
      OriginatorConversationID: opts.originatorConversationId,
      ConversationID: opts.conversationId,
      TransactionID: receiptNumber(),
      ResultParameters: {
        ResultParameter: [
          { Key: 'TransactionAmount', Value: opts.amount },
          { Key: 'TransactionReceipt', Value: receiptNumber() },
          { Key: 'B2CRecipientIsRegisteredCustomer', Value: 'Y' },
          { Key: 'B2CChargesPaidAccountAvailableFunds', Value: 0 },
          { Key: 'ReceiverPartyPublicName', Value: `${opts.phone} - John Doe` },
          { Key: 'TransactionCompletedDateTime', Value: '19.12.2019 11:45:50' },
          { Key: 'B2CUtilityAccountAvailableFunds', Value: 10000 },
          { Key: 'B2CWorkingAccountAvailableFunds', Value: 900000 },
        ],
      },
      ReferenceData: {
        ReferenceItem: { Key: 'QueueTimeoutURL', Value: 'https://internalapi.safaricom.co.ke/mpesa/b2cresults/v1/submit' },
      },
    },
  }),

  resultFailure: (opts: {
    originatorConversationId: string;
    conversationId: string;
    resultCode: number;
    resultDesc: string;
  }) => ({
    Result: {
      ResultType: 0,
      ResultCode: opts.resultCode,
      ResultDesc: opts.resultDesc,
      OriginatorConversationID: opts.originatorConversationId,
      ConversationID: opts.conversationId,
      ReferenceData: {
        ReferenceItem: { Key: 'QueueTimeoutURL', Value: 'https://internalapi.safaricom.co.ke/mpesa/b2cresults/v1/submit' },
      },
    },
  }),
};

export const accountBalance = {
  resultSuccess: (opts: { originatorConversationId: string; conversationId: string }) => ({
    Result: {
      ResultType: 0,
      ResultCode: 0,
      ResultDesc: 'The service request is processed successfully.',
      OriginatorConversationID: opts.originatorConversationId,
      ConversationID: opts.conversationId,
      TransactionID: receiptNumber(),
      ResultParameters: {
        ResultParameter: [
          { Key: 'AccountBalance', Value: 'Working Account|KES|46713.00|46713.00|0.00|0.00' },
          { Key: 'BOCompletedTime', Value: 20260731120000 },
        ],
      },
    },
  }),
};

export const ratiba = {
  /**
   * Ratiba's synchronous acknowledgement.
   * Note the capitalised envelope; the callback below uses lowercase.
   */
  accepted: (responseRefId: string) => ({
    ResponseHeader: {
      responseRefID: responseRefId,
      responseCode: '200',
      responseDescription: 'Request accepted for processing',
      ResultDesc: 'The service request is processed successfully.',
    },
    ResponseBody: {
      responseDescription: 'Request accepted for processing',
      responseCode: '200',
    },
  }),

  /** Lowercase envelope, and responseCode "0" rather than "200". */
  callbackSuccess: (opts: {
    responseRefId: string;
    requestRefId: string;
    standingOrderName: string;
    amount: number;
    msisdn: string;
  }) => ({
    responseHeader: {
      responseRefID: opts.responseRefId,
      requestRefID: opts.requestRefId,
      responseCode: '0',
      responseDescription: 'Standing order created successfully',
    },
    responseBody: {
      responseData: [
        { name: 'standingOrderName', value: opts.standingOrderName },
        { name: 'amount', value: opts.amount.toFixed(2) },
        { name: 'issuePaymentReminderUntil', value: '20280407' },
        { name: 'reminderScheduleId', value: String(Math.floor(Math.random() * 9000000) + 1000000) },
        { name: 'firstPaymentReminderDate', value: '20260807' },
        { name: 'status', value: 'ACTIVE' },
        { name: 'TransactionID', value: String(Math.floor(Math.random() * 9000000) + 1000000) },
        { name: 'ResponseCode', value: '0' },
        { name: 'Status', value: 'OKAY' },
        // Safaricom masks the MSISDN in Ratiba callbacks.
        { name: 'Msisdn', value: `*********${opts.msisdn.slice(-3)}` },
      ],
    },
  }),

  callbackFailure: (opts: { responseRefId: string; requestRefId: string; reason: string }) => ({
    ResponseHeader: {
      responseRefID: opts.responseRefId,
      requestRefID: opts.requestRefId,
      responseCode: '1037',
      responseDescription: 'Error',
    },
    ResponseBody: {
      ResponseData: [
        { Name: 'ResponseCode', Value: '1037' },
        { Name: 'ResponseDescription', Value: opts.reason },
      ],
    },
  }),

  duplicateName: () => ({
    requestId: uid('req-'),
    errorCode: '400.002.02',
    errorMessage: 'Standing order name already exists for this customer',
  }),
};

export const c2b = {
  registerSuccess: () => ({
    OriginatorCoversationID: uid('reg-'), // Safaricom's own typo: "Coversation".
    ResponseCode: '0',
    ResponseDescription: 'Success',
  }),
  simulateSuccess: (originatorConversationId: string) => ({
    OriginatorCoversationID: originatorConversationId,
    ConversationID: conversationId(),
    ResponseDescription: 'Accept the service request successfully.',
  }),
};

export const qr = {
  success: () => ({
    ResponseCode: '00',
    RequestID: uid('QR-'),
    ResponseDescription: 'The service request is processed successfully.',
    QRCode: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  }),
};

export const identity = {
  /** Shared shape for Swap / AgeOnNetwork / IMSI style lookups. */
  checkAtiSuccess: (value: string) => ({
    header: { responseCode: 200, responseMessage: 'Success', customerMessage: 'Request processed successfully', timestamp: new Date().toISOString() },
    body: { transactionStatus: 'Success', value },
  }),
  validationSuccess: (matched: boolean) => ({
    header: { responseCode: 200, responseMessage: 'Success', timestamp: new Date().toISOString() },
    body: { transactionStatus: matched ? 'Success' : 'Failed', matched },
  }),
};
