import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DarajaClient } from './client.js';
import { CallbackReceiver } from './callbacks/receiver.js';
import { DarajaSimulator } from './simulator/server.js';
import { loadConfig, type DarajaConfig } from './config.js';
import { toolResult, type ToolContext } from './tools/context.js';
import * as payments from './tools/payments.js';
import * as disbursement from './tools/disbursement.js';
import * as misc from './tools/misc.js';

export const SERVER_NAME = 'daraja-mcp';
export const SERVER_VERSION = '0.1.0';

export interface CreateServerOptions {
  config?: DarajaConfig;
  /** Skip the callback receiver. Some hosts forbid listening sockets. */
  disableReceiver?: boolean;
  onLog?: (message: string) => void;
}

export interface RunningServer {
  server: McpServer;
  context: ToolContext;
  shutdown: () => Promise<void>;
}

/**
 * Build the MCP server and all of its dependencies.
 *
 * In simulator mode this also starts a fake Daraja and points the client at it,
 * so `npx daraja-mcp` is immediately useful with no Safaricom account.
 */
export async function createServer(opts: CreateServerOptions = {}): Promise<RunningServer> {
  const config = opts.config ?? loadConfig();
  const log = opts.onLog ?? (() => {});

  let simulator: DarajaSimulator | null = null;
  let baseUrl = config.baseUrl;

  if (config.mode === 'simulator') {
    simulator = new DarajaSimulator({ onLog: log });
    baseUrl = await simulator.start();
    log(`Simulator mode. No Safaricom credentials required.`);
  }

  const effectiveConfig: DarajaConfig = { ...config, baseUrl };
  const client = new DarajaClient(effectiveConfig);

  let receiver: CallbackReceiver | null = null;
  if (!opts.disableReceiver && !process.env.DARAJA_DISABLE_RECEIVER) {
    receiver = new CallbackReceiver({
      config: effectiveConfig.callback,
      trustProxy: effectiveConfig.callback.trustProxy,
      onLog: log,
    });
    await receiver.start();
  }

  const context: ToolContext = { client, config: effectiveConfig, receiver };
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Tools for the Safaricom M-Pesa Daraja 3.0 API. Payments are asynchronous: ' +
        'initiating one returns an acknowledgement, and the real outcome arrives later ' +
        'on a callback. Prefer the *_and_wait tools when you need to know whether money ' +
        'actually moved. Amounts are whole Kenyan shillings.',
    },
  );

  registerTools(server, context);

  return {
    server,
    context,
    shutdown: async () => {
      await receiver?.stop();
      await simulator?.stop();
    },
  };
}

function registerTools(server: McpServer, ctx: ToolContext): void {
  // --- M-Pesa Express ------------------------------------------------------

  server.tool(
    'stk_push',
    'Send an M-Pesa payment prompt (STK push) to a customer. Returns immediately with an ' +
      'acknowledgement; it does NOT confirm payment. Use stk_push_and_wait if you need the outcome.',
    payments.stkPushInput,
    (args) => toolResult(ctx, () => payments.stkPush(ctx, args)),
  );

  server.tool(
    'stk_push_and_wait',
    'Send an M-Pesa payment prompt and wait for the customer to accept or decline. ' +
      'Returns the settled outcome including the receipt number on success. Use this when ' +
      'you need to know whether the payment actually completed.',
    {
      ...payments.stkPushInput,
      timeoutSeconds: z
        .number()
        .int()
        .positive()
        .max(300)
        .default(90)
        .describe('How long to wait for the customer. Prompts expire after about 60 seconds.'),
    },
    (args) => toolResult(ctx, () => payments.stkPushAndWait(ctx, args)),
  );

  server.tool(
    'stk_query',
    'Query the status of a previous STK push using its CheckoutRequestID.',
    payments.stkQueryInput,
    (args) => toolResult(ctx, () => payments.stkQuery(ctx, args)),
  );

  // --- M-Pesa Ratiba ------------------------------------------------------

  server.tool(
    'ratiba_create',
    'Create an M-Pesa Ratiba standing order for recurring collection: subscriptions, loan ' +
      'repayments, insurance premiums, SACCO contributions. The customer approves via an ' +
      'M-Pesa prompt. The standing order name must be unique per customer.',
    payments.ratibaCreateInput,
    (args) => toolResult(ctx, () => payments.ratibaCreate(ctx, args)),
  );

  server.tool(
    'ratiba_create_and_wait',
    'Create an M-Pesa Ratiba standing order and wait for the customer to approve it. ' +
      'Returns the settled outcome including the reminder schedule id.',
    {
      ...payments.ratibaCreateInput,
      timeoutSeconds: z.number().int().positive().max(300).default(90),
    },
    (args) => toolResult(ctx, () => payments.ratibaCreateAndWait(ctx, args)),
  );

  // --- QR ------------------------------------------------------------------

  server.tool(
    'generate_qr',
    'Generate a dynamic M-Pesa QR code for a specific amount and till or paybill.',
    payments.qrInput,
    (args) => toolResult(ctx, () => payments.generateQr(ctx, args)),
  );

  // --- Disbursement --------------------------------------------------------

  server.tool(
    'b2c_payment',
    'Pay money out to a customer: refunds, withdrawals, salaries, promotional winnings. ' +
      'Asynchronous; the result arrives on a callback.',
    disbursement.b2cInput,
    (args) => toolResult(ctx, () => disbursement.b2cPayment(ctx, args)),
  );

  server.tool(
    'b2c_payment_and_wait',
    'Pay money out to a customer and wait for the result callback, returning the receipt ' +
      'number on success.',
    {
      ...disbursement.b2cInput,
      timeoutSeconds: z.number().int().positive().max(300).default(120),
    },
    (args) => toolResult(ctx, () => disbursement.b2cPaymentAndWait(ctx, args)),
  );

  server.tool(
    'b2b_payment',
    'Pay another business: a PayBill, a Buy Goods till, or a B2C working account top-up.',
    disbursement.b2bInput,
    (args) => toolResult(ctx, () => disbursement.b2bPayment(ctx, args)),
  );

  server.tool(
    'tax_remittance',
    'Remit tax to the Kenya Revenue Authority using a Payment Registration Number.',
    disbursement.taxRemittanceInput,
    (args) => toolResult(ctx, () => disbursement.taxRemittance(ctx, args)),
  );

  server.tool(
    'business_to_pochi',
    'Pay a Pochi la Biashara number.',
    disbursement.pochiInput,
    (args) => toolResult(ctx, () => disbursement.businessToPochi(ctx, args)),
  );

  // --- Treasury ------------------------------------------------------------

  server.tool(
    'account_balance',
    'Query the balance of your M-Pesa business account. Asynchronous; the balance arrives ' +
      'on a callback as a pipe-delimited string per account type.',
    disbursement.accountBalanceInput,
    (args) => toolResult(ctx, () => disbursement.accountBalance(ctx, args)),
  );

  server.tool(
    'transaction_status',
    'Check the status of any past transaction by receipt number, or by conversation id when ' +
      'the original request timed out. Use this before retrying a payment you are unsure about.',
    disbursement.transactionStatusInput,
    (args) => toolResult(ctx, () => disbursement.transactionStatus(ctx, args)),
  );

  server.tool(
    'reversal',
    'Reverse a transaction that was paid into your shortcode.',
    disbursement.reversalInput,
    (args) => toolResult(ctx, () => disbursement.reversal(ctx, args)),
  );

  // --- C2B -----------------------------------------------------------------

  server.tool(
    'c2b_register_urls',
    'Register the validation and confirmation URLs that Daraja calls when a customer pays ' +
      'your PayBill or till directly. Required once per shortcode before C2B notifications work.',
    misc.c2bRegisterInput,
    (args) => toolResult(ctx, () => misc.c2bRegisterUrls(ctx, args)),
  );

  server.tool(
    'c2b_simulate',
    'Simulate a customer paying your shortcode. Sandbox and simulator only.',
    misc.c2bSimulateInput,
    (args) => toolResult(ctx, () => misc.c2bSimulate(ctx, args)),
  );

  // --- Pull transactions ---------------------------------------------------

  server.tool(
    'pull_register',
    'Register a shortcode for the Pull Transactions API, which lets you fetch missed C2B ' +
      'transactions after an outage.',
    misc.pullRegisterInput,
    (args) => toolResult(ctx, () => misc.pullRegister(ctx, args)),
  );

  server.tool(
    'pull_transactions',
    'Fetch C2B transactions for a time window. Useful for reconciliation when callbacks ' +
      'were missed.',
    misc.pullQueryInput,
    (args) => toolResult(ctx, () => misc.pullQuery(ctx, args)),
  );

  // --- Identity and fraud controls ----------------------------------------

  server.tool(
    'check_sim_swap',
    'Return the date a number was last SIM-swapped. A recent swap is a strong fraud signal; ' +
      'check this before disbursing to an unfamiliar number.',
    misc.simSwapInput,
    (args) => toolResult(ctx, () => misc.checkSimSwap(ctx, args)),
  );

  server.tool(
    'check_age_on_network',
    'Return the date a number was first registered on the Safaricom network. Very new lines ' +
      'carry elevated fraud risk.',
    misc.ageOnNetworkInput,
    (args) => toolResult(ctx, () => misc.checkAgeOnNetwork(ctx, args)),
  );

  server.tool(
    'validate_identity',
    'Check whether a phone number is registered against a given national ID number.',
    misc.validateIdentityInput,
    (args) => toolResult(ctx, () => misc.validateIdentity(ctx, args)),
  );

  server.tool(
    'query_org_info',
    'Look up the registered name and tariff of a PayBill or till. Use this to confirm you ' +
      'are paying the business you intend to before sending money.',
    misc.orgInfoInput,
    (args) => toolResult(ctx, () => misc.queryOrgInfo(ctx, args)),
  );

  // --- Callback inspection -------------------------------------------------

  server.tool(
    'list_callbacks',
    'List callbacks this server has received, newest first.',
    misc.listCallbacksInput,
    (args) => toolResult(ctx, async () => misc.listCallbacks(ctx, args)),
  );

  server.tool(
    'get_callback',
    'Fetch the full callback payload for a correlation id.',
    misc.getCallbackInput,
    (args) => toolResult(ctx, async () => misc.getCallback(ctx, args)),
  );

  server.tool(
    'server_health',
    'Report the current mode, which credentials are configured, and callback receiver status. ' +
      'Start here when something is not working.',
    {},
    () => toolResult(ctx, async () => misc.serverHealth(ctx)),
  );
}
