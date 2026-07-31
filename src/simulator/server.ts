import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
import * as fx from './fixtures.js';

/**
 * A fake Daraja.
 *
 * This exists so that `npx daraja-mcp` does something useful on a laptop with no
 * Safaricom account, and so the test suite runs in CI without secrets. It speaks
 * the real endpoint paths and returns the real payload shapes, including the
 * asynchronous half: when you initiate a payment it POSTs a callback to your
 * callback URL a moment later, exactly as Safaricom would.
 *
 * Scenarios are driven by the amount, which is the one field every product has.
 * This keeps failure testing deterministic and requires no extra API surface:
 *
 *   amount ending in .00 or any normal value -> success
 *   1        -> insufficient funds  (ResultCode 1)
 *   1032     -> cancelled by user
 *   1037     -> timeout, user unreachable
 *   2001     -> wrong PIN
 *   9999     -> upstream 500, to exercise retry logic
 */

export interface SimulatorOptions {
  port?: number;
  /** Milliseconds before the async callback fires. Keep small in tests. */
  callbackDelayMs?: number;
  /** Injected for tests so callbacks can be asserted without a real socket. */
  fetchImpl?: typeof fetch;
  onLog?: (message: string) => void;
}

interface PendingCallback {
  url: string;
  payload: unknown;
  timer: NodeJS.Timeout;
}

const SCENARIO_BY_AMOUNT: Record<string, { code: number; desc: string }> = {
  '1': { code: 1, desc: 'The balance is insufficient for the transaction' },
  '1032': { code: 1032, desc: 'Request cancelled by user' },
  '1037': { code: 1037, desc: 'DS timeout user cannot be reached' },
  '2001': { code: 2001, desc: 'The initiator information is invalid' },
};

export class DarajaSimulator {
  private server: Server | null = null;
  private pending = new Set<PendingCallback>();
  private readonly callbackDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onLog: (message: string) => void;
  private requestedPort: number;

  constructor(opts: SimulatorOptions = {}) {
    this.requestedPort = opts.port ?? 0;
    this.callbackDelayMs = opts.callbackDelayMs ?? 1200;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.onLog = opts.onLog ?? (() => {});
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        this.json(res, 500, { errorCode: '500.001.1001', errorMessage: String(err) });
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.requestedPort, '127.0.0.1', resolve);
    });

    const addr = this.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : this.requestedPort;
    const url = `http://127.0.0.1:${port}`;
    this.onLog(`Daraja simulator listening on ${url}`);
    return url;
  }

  async stop(): Promise<void> {
    for (const p of this.pending) clearTimeout(p.timer);
    this.pending.clear();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
  }

  /** Test helper: fire every queued callback immediately. */
  async flushCallbacks(): Promise<void> {
    const queued = [...this.pending];
    this.pending.clear();
    for (const p of queued) {
      clearTimeout(p.timer);
      await this.deliver(p.url, p.payload);
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const body = await this.readBody(req);

    this.onLog(`${req.method} ${path}`);

    // --- Authorization -----------------------------------------------------
    if (path === '/oauth/v1/generate') {
      const auth = req.headers.authorization ?? '';
      if (!auth.startsWith('Basic ')) {
        return this.json(res, 401, fx.auth.unauthorized());
      }
      return this.json(res, 200, fx.auth.success());
    }

    // Everything past this point needs a bearer token.
    if (!(req.headers.authorization ?? '').startsWith('Bearer ')) {
      return this.json(res, 401, {
        requestId: 'sim-req',
        errorCode: '404.001.03',
        errorMessage: 'Invalid Access Token',
      });
    }

    // --- M-Pesa Express (STK push) ----------------------------------------
    if (path === '/mpesa/stkpush/v1/processrequest') {
      const amount = String(body.Amount ?? '');
      if (amount === '9999') {
        return this.json(res, 500, {
          requestId: 'sim-req',
          errorCode: '500.001.1001',
          errorMessage: 'Simulated upstream failure',
        });
      }

      const ids = {
        merchantRequestId: fx.merchantRequestId(),
        checkoutRequestId: fx.checkoutRequestId(),
      };
      const callbackUrl = String(body.CallBackURL ?? '');
      const scenario = SCENARIO_BY_AMOUNT[amount];

      if (callbackUrl) {
        const payload = scenario
          ? fx.stkPush.callbackFailure({ ...ids, resultCode: scenario.code, resultDesc: scenario.desc })
          : fx.stkPush.callbackSuccess({
              ...ids,
              amount: Number(amount) || 1,
              phone: String(body.PhoneNumber ?? '254708374149'),
            });
        this.queueCallback(callbackUrl, payload);
      }

      return this.json(res, 200, fx.stkPush.accepted(ids));
    }

    if (path === '/mpesa/stkpushquery/v1/query') {
      const ids = {
        merchantRequestId: fx.merchantRequestId(),
        checkoutRequestId: String(body.CheckoutRequestID ?? fx.checkoutRequestId()),
      };
      return this.json(res, 200, fx.stkQuery.success(ids));
    }

    // --- C2B ---------------------------------------------------------------
    if (path === '/mpesa/c2b/v2/registerurl' || path === '/mpesa/c2b/v1/registerurl') {
      return this.json(res, 200, fx.c2b.registerSuccess());
    }
    if (path === '/mpesa/c2b/v2/simulate' || path === '/mpesa/c2b/v1/simulate') {
      return this.json(res, 200, fx.c2b.simulateSuccess(fx.conversationId()));
    }

    // --- Async family: B2C, B2B, reversal, balance, status -----------------
    const asyncPaths = [
      '/mpesa/b2c/v3/paymentrequest',
      '/mpesa/b2c/v1/paymentrequest',
      '/mpesa/b2b/v1/paymentrequest',
      '/mpesa/b2b/v1/remittax',
      '/mpesa/b2pochi/v1/paymentrequest',
      '/mpesa/reversal/v1/request',
      '/mpesa/accountbalance/v1/query',
      '/mpesa/transactionstatus/v1/query',
    ];
    if (asyncPaths.includes(path)) {
      const originator = String(body.OriginatorConversationID ?? fx.conversationId());
      const ack = fx.asyncAccepted(originator);
      const resultUrl = String(body.ResultURL ?? body.QueueTimeOutURL ?? '');
      const amount = String(body.Amount ?? '');
      const scenario = SCENARIO_BY_AMOUNT[amount];

      if (resultUrl) {
        const payload = path.includes('accountbalance')
          ? fx.accountBalance.resultSuccess({
              originatorConversationId: originator,
              conversationId: ack.ConversationID,
            })
          : scenario
            ? fx.b2c.resultFailure({
                originatorConversationId: originator,
                conversationId: ack.ConversationID,
                resultCode: scenario.code,
                resultDesc: scenario.desc,
              })
            : fx.b2c.resultSuccess({
                originatorConversationId: originator,
                conversationId: ack.ConversationID,
                amount: Number(amount) || 1,
                phone: String(body.PartyB ?? body.PartyA ?? '254708374149'),
              });
        this.queueCallback(resultUrl, payload);
      }

      return this.json(res, 200, ack);
    }

    // --- Dynamic QR --------------------------------------------------------
    if (path === '/mpesa/qrcode/v1/generate') {
      return this.json(res, 200, fx.qr.success());
    }

    // --- M-Pesa Ratiba -----------------------------------------------------
    if (path === '/standingorder/v1/createStandingOrderExternal') {
      // Ratiba enforces a unique standing order name per customer.
      const name = String(body.StandingOrderName ?? body.StandingOrderNameName ?? '');
      if (name.toLowerCase().includes('duplicate')) {
        return this.json(res, 400, fx.ratiba.duplicateName());
      }

      const requestRefId = String(body.CustomStoId ?? body.CustomstdoId ?? fx.conversationId());
      const responseRefId = fx.conversationId();
      const callbackUrl = String(body.CallBackURL ?? '');
      const amount = String(body.Amount ?? '');
      const scenario = SCENARIO_BY_AMOUNT[amount];

      if (callbackUrl) {
        const payload = scenario
          ? fx.ratiba.callbackFailure({ responseRefId, requestRefId, reason: scenario.desc })
          : fx.ratiba.callbackSuccess({
              responseRefId,
              requestRefId,
              standingOrderName: name || 'Simulated standing order',
              amount: Number(amount) || 1,
              msisdn: String(body.PartyA ?? '254708374149'),
            });
        this.queueCallback(callbackUrl, payload);
      }

      return this.json(res, 200, fx.ratiba.accepted(responseRefId));
    }

    // --- Identity and security cluster -------------------------------------
    if (path === '/imsi/v2/checkATI') {
      return this.json(res, 200, fx.identity.checkAtiSuccess('20240115'));
    }
    if (path === '/registration/lookup/v1/checkATI') {
      return this.json(res, 200, fx.identity.checkAtiSuccess('20180302'));
    }
    if (path === '/v1/KYC-validation/validateID') {
      const id = String(body.IDNumber ?? body.idNumber ?? '');
      return this.json(res, 200, fx.identity.validationSuccess(!id.endsWith('0')));
    }
    if (path === '/sfcverify/v1/query/info') {
      return this.json(res, 200, {
        header: { responseCode: 200, responseMessage: 'Success' },
        body: { organizationName: 'SIMULATED MERCHANT LTD', tariff: 'Paybill Tariff' },
      });
    }

    // --- Pull transactions -------------------------------------------------
    if (path === '/pulltransactions/v1/register') {
      return this.json(res, 200, { ResponseRefID: fx.conversationId(), ResponseCode: '1000', ResponseMessage: 'Success' });
    }
    if (path === '/pulltransactions/v1/query') {
      return this.json(res, 200, {
        ResponseRefID: fx.conversationId(),
        ResponseCode: '1000',
        ResponseMessage: 'Success',
        Response: [
          {
            transactionId: fx.receiptNumber(),
            trxDate: new Date().toISOString(),
            msisdn: 254708374149,
            sender: 'JOHN DOE',
            transactiontype: 'Pay Bill',
            billreference: 'TEST',
            amount: 100,
            organizationname: 'SIMULATED MERCHANT LTD',
          },
        ],
      });
    }

    return this.json(res, 404, {
      requestId: 'sim-req',
      errorCode: '404.001.04',
      errorMessage: `Simulator has no handler for ${path}`,
    });
  }

  /** Schedule the asynchronous result push, mirroring Safaricom's behaviour. */
  private queueCallback(url: string, payload: unknown): void {
    const entry: PendingCallback = {
      url,
      payload,
      timer: setTimeout(() => {
        this.pending.delete(entry);
        void this.deliver(url, payload);
      }, this.callbackDelayMs),
    };
    this.pending.add(entry);
  }

  private async deliver(url: string, payload: unknown): Promise<void> {
    try {
      await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      this.onLog(`callback delivered to ${url}`);
    } catch (err) {
      this.onLog(`callback to ${url} failed: ${String(err)}`);
    }
  }

  private async readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (chunks.length === 0) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  }
}
