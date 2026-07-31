import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, type RunningServer } from './server.js';
import { loadConfig } from './config.js';

/**
 * Drives every registered tool through the MCP layer at least once, so each
 * registration closure is executed rather than merely declared. Assertions stay
 * light: the per-tool behaviour is covered in the tools suites. What matters
 * here is that the wiring between schema, handler, and result is intact.
 */

const running: RunningServer[] = [];
const clients: Client[] = [];

async function connect() {
  const config = loadConfig({
    DARAJA_MODE: 'simulator',
    DARAJA_SHORTCODE: '174379',
    DARAJA_PASSKEY: 'test-passkey',
    DARAJA_INITIATOR_NAME: 'testapi',
    DARAJA_SECURITY_CREDENTIAL: 'credential',
    DARAJA_CALLBACK_PORT: '0',
  } as NodeJS.ProcessEnv);

  const instance = await createServer({ config });
  running.push(instance);

  const client = new Client({ name: 'tool-coverage', version: '1.0.0' });
  clients.push(client);

  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), instance.server.connect(b)]);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
  await Promise.all(running.splice(0).map((r) => r.shutdown().catch(() => {})));
});

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content;
  return content?.[0]?.text ?? '';
}

/** Arguments that satisfy each tool's schema against the simulator. */
const CALLS: Array<[name: string, args: Record<string, unknown>]> = [
  ['stk_push', { phoneNumber: '0712345678', amount: 10, accountReference: 'REF' }],
  ['stk_query', { checkoutRequestId: 'ws_CO_test' }],
  [
    'ratiba_create',
    {
      standingOrderName: 'Coverage order',
      phoneNumber: '0712345678',
      amount: 100,
      startDate: '2026-08-01',
      endDate: '2027-08-01',
      frequency: 'weekly',
    },
  ],
  [
    'generate_qr',
    { merchantName: 'Shop', refNo: 'R1', amount: 10, trxCode: 'BG', cpi: '373132' },
  ],
  ['b2c_payment', { phoneNumber: '0712345678', amount: 10 }],
  [
    'b2b_payment',
    { target: 'paybill', receiverShortCode: '600000', amount: 10, accountReference: 'A' },
  ],
  ['tax_remittance', { amount: 10, paymentRegistrationNumber: 'PRN1' }],
  ['business_to_pochi', { phoneNumber: '0712345678', amount: 10 }],
  ['account_balance', {}],
  ['transaction_status', { transactionId: 'NEF61H8J60' }],
  ['reversal', { transactionId: 'NEF61H8J60', amount: 10 }],
  ['c2b_register_urls', {}],
  ['c2b_simulate', { phoneNumber: '0712345678', amount: 10 }],
  ['pull_register', { nominatedNumber: '0712345678' }],
  ['pull_transactions', { startDate: '2026-07-01 00:00:00', endDate: '2026-07-31 23:59:59' }],
  ['check_sim_swap', { phoneNumber: '0712345678' }],
  ['check_age_on_network', { phoneNumber: '0712345678' }],
  ['validate_identity', { phoneNumber: '0712345678', idNumber: '12345678' }],
  ['query_org_info', { shortCode: '600000' }],
  ['list_callbacks', {}],
  ['get_callback', { correlationId: 'unknown-id' }],
  ['server_health', {}],
];

describe('every tool executes through the MCP layer', () => {
  it.each(CALLS)('%s returns a result without erroring', async (name, args) => {
    const client = await connect();
    const result = await client.callTool({ name, arguments: args });

    expect(
      (result as { isError?: boolean }).isError,
      `${name} errored: ${textOf(result)}`,
    ).toBeFalsy();
    expect(textOf(result).length).toBeGreaterThan(0);
  });
});

describe('waiting tools reached through MCP', () => {
  it('b2c_payment_and_wait settles against the simulator', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'b2c_payment_and_wait',
      arguments: { phoneNumber: '0712345678', amount: 10, timeoutSeconds: 20 },
    });

    expect(textOf(result)).toContain('"status"');
  });

  it('reports a B2C failure scenario', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'b2c_payment_and_wait',
      // The simulator maps amount 1 to insufficient funds.
      arguments: { phoneNumber: '0712345678', amount: 1, timeoutSeconds: 20 },
    });

    expect(textOf(result)).toContain('"status": "failure"');
  });
});
