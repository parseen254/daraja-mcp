import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, SERVER_NAME, SERVER_VERSION, type RunningServer } from './server.js';
import { loadConfig } from './config.js';

/**
 * Exercises the MCP layer through a real client over an in-memory transport,
 * so tool registration, schema validation, and error surfacing are all covered
 * the way a host application would drive them.
 */

const running: RunningServer[] = [];
const clients: Client[] = [];

async function connect(env: Record<string, string> = {}) {
  const config = loadConfig({
    DARAJA_MODE: 'simulator',
    DARAJA_SHORTCODE: '174379',
    DARAJA_PASSKEY: 'test-passkey',
    DARAJA_INITIATOR_NAME: 'testapi',
    DARAJA_SECURITY_CREDENTIAL: 'credential',
    // Port 0 avoids collisions when suites run in parallel.
    DARAJA_CALLBACK_PORT: '0',
    ...env,
  } as NodeJS.ProcessEnv);

  const instance = await createServer({ config });
  running.push(instance);

  const client = new Client({ name: 'test-client', version: '1.0.0' });
  clients.push(client);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    instance.server.connect(serverTransport),
  ]);

  return { client, instance };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
  await Promise.all(running.splice(0).map((r) => r.shutdown().catch(() => {})));
});

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content;
  return content?.[0]?.text ?? '';
}

describe('createServer', () => {
  it('starts a simulator and points the client at it', async () => {
    const { instance } = await connect();
    expect(instance.context.client.mode).toBe('simulator');
    // The simulator binds a loopback port and the client is rewired to it.
    expect(instance.context.client.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('starts a callback receiver by default', async () => {
    const { instance } = await connect();
    expect(instance.context.receiver).not.toBeNull();
  });

  it('can run without a receiver', async () => {
    const config = loadConfig({
      DARAJA_MODE: 'simulator',
      DARAJA_CALLBACK_PORT: '0',
    } as NodeJS.ProcessEnv);
    const instance = await createServer({ config, disableReceiver: true });
    running.push(instance);
    expect(instance.context.receiver).toBeNull();
  });

  it('emits log lines through the provided callback', async () => {
    const logs: string[] = [];
    const config = loadConfig({
      DARAJA_MODE: 'simulator',
      DARAJA_CALLBACK_PORT: '0',
    } as NodeJS.ProcessEnv);
    const instance = await createServer({ config, onLog: (m) => logs.push(m) });
    running.push(instance);

    expect(logs.some((l) => l.includes('Simulator mode'))).toBe(true);
  });

  it('shuts down cleanly and releases its ports', async () => {
    const config = loadConfig({
      DARAJA_MODE: 'simulator',
      DARAJA_CALLBACK_PORT: '0',
    } as NodeJS.ProcessEnv);
    const instance = await createServer({ config });
    const port = instance.context.receiver?.port;
    await instance.shutdown();

    // A second shutdown must not throw.
    await expect(instance.shutdown()).resolves.toBeUndefined();
    expect(port).toBeGreaterThan(0);
  });
});

describe('tool registration', () => {
  it('advertises the server name and version', async () => {
    const { client } = await connect();
    const info = client.getServerVersion();
    expect(info?.name).toBe(SERVER_NAME);
    expect(info?.version).toBe(SERVER_VERSION);
  });

  it('registers every documented tool', async () => {
    const { client } = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();

    expect(names).toEqual(
      [
        'account_balance',
        'b2b_payment',
        'b2c_payment',
        'b2c_payment_and_wait',
        'business_to_pochi',
        'c2b_register_urls',
        'c2b_simulate',
        'check_age_on_network',
        'check_sim_swap',
        'generate_qr',
        'get_callback',
        'list_callbacks',
        'pull_register',
        'pull_transactions',
        'query_org_info',
        'ratiba_create',
        'ratiba_create_and_wait',
        'reversal',
        'server_health',
        'stk_push',
        'stk_push_and_wait',
        'stk_query',
        'tax_remittance',
        'transaction_status',
        'validate_identity',
      ].sort(),
    );
  });

  it('gives every tool a description', async () => {
    const { client } = await connect();
    for (const tool of (await client.listTools()).tools) {
      expect(tool.description, `${tool.name} has no description`).toBeTruthy();
      expect(tool.description!.length).toBeGreaterThan(20);
    }
  });

  it('warns in the description that stk_push does not confirm payment', async () => {
    const { client } = await connect();
    const tools = (await client.listTools()).tools;
    const push = tools.find((t) => t.name === 'stk_push');

    // The distinction between acknowledgement and settlement is the single
    // easiest thing for a model to get wrong here.
    expect(push?.description).toMatch(/does NOT confirm|acknowledgement/i);
  });

  it('exposes input schemas with the expected required fields', async () => {
    const { client } = await connect();
    const tools = (await client.listTools()).tools;
    const push = tools.find((t) => t.name === 'stk_push');

    const schema = push?.inputSchema as { properties?: Record<string, unknown> };
    expect(schema.properties).toHaveProperty('phoneNumber');
    expect(schema.properties).toHaveProperty('amount');
  });
});

describe('calling tools', () => {
  it('runs a payment end to end and returns the receipt', async () => {
    const { client } = await connect();
    const result = await client.callTool({
      name: 'stk_push_and_wait',
      arguments: { phoneNumber: '0712345678', amount: 100, timeoutSeconds: 20 },
    });

    const text = textOf(result);
    expect(text).toContain('"status": "success"');
    expect(text).toContain('MpesaReceiptNumber');
  });

  it('surfaces a cancelled payment as a failure with its code', async () => {
    const { client } = await connect();
    const result = await client.callTool({
      name: 'stk_push_and_wait',
      // The simulator maps this amount to "cancelled by user".
      arguments: { phoneNumber: '0712345678', amount: 1032, timeoutSeconds: 20 },
    });

    const text = textOf(result);
    expect(text).toContain('"status": "failure"');
    expect(text).toContain('1032');
  });

  it('creates a standing order and reports it active', async () => {
    const { client } = await connect();
    const result = await client.callTool({
      name: 'ratiba_create_and_wait',
      arguments: {
        standingOrderName: 'Gym membership',
        phoneNumber: '0712345678',
        amount: 2000,
        startDate: '2026-08-01',
        endDate: '2027-08-01',
        frequency: 'monthly',
        timeoutSeconds: 20,
      },
    });

    const text = textOf(result);
    expect(text).toContain('"status": "success"');
    expect(text).toContain('ACTIVE');
    expect(text).toContain('reminderScheduleId');
  });

  it('reports server health', async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: 'server_health', arguments: {} });
    expect(textOf(result)).toContain('simulator');
  });

  it('returns a readable error rather than throwing on bad input', async () => {
    const { client } = await connect();
    const result = await client.callTool({
      name: 'stk_push',
      arguments: { phoneNumber: '0812345678', amount: 10 },
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain('not a valid Kenyan mobile number');
  });

  it('rejects arguments that violate the schema', async () => {
    const { client } = await connect();
    // The SDK reports validation failures as an error result rather than
    // throwing, so the model sees the reason and can correct itself.
    const result = await client.callTool({
      name: 'stk_push',
      arguments: { phoneNumber: '0712345678', amount: -5 },
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result).toLowerCase()).toContain('amount');
  });

  it('reports an unknown tool as an error result', async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: 'no_such_tool', arguments: {} });
    expect((result as { isError?: boolean }).isError).toBe(true);
  });

  it('lists callbacks accumulated during the session', async () => {
    const { client } = await connect();
    await client.callTool({
      name: 'stk_push_and_wait',
      arguments: { phoneNumber: '0712345678', amount: 50, timeoutSeconds: 20 },
    });

    const result = await client.callTool({ name: 'list_callbacks', arguments: {} });
    expect(textOf(result)).toContain('"kind": "stk"');
  });

  it('runs an identity check', async () => {
    const { client } = await connect();
    const result = await client.callTool({
      name: 'check_sim_swap',
      arguments: { phoneNumber: '0712345678' },
    });
    expect((result as { isError?: boolean }).isError).toBeFalsy();
  });

  it('generates a QR code', async () => {
    const { client } = await connect();
    const result = await client.callTool({
      name: 'generate_qr',
      arguments: {
        merchantName: 'Test Shop',
        refNo: 'INV-1',
        amount: 100,
        trxCode: 'BG',
        cpi: '373132',
      },
    });
    expect(textOf(result)).toContain('QRCode');
  });

  it('acknowledges a B2C payout', async () => {
    const { client } = await connect();
    const result = await client.callTool({
      name: 'b2c_payment',
      arguments: { phoneNumber: '0712345678', amount: 250 },
    });
    expect(textOf(result)).toContain('ConversationID');
  });

  it('queries an account balance', async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: 'account_balance', arguments: {} });
    expect((result as { isError?: boolean }).isError).toBeFalsy();
  });

  it('registers C2B URLs', async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: 'c2b_register_urls', arguments: {} });
    expect((result as { isError?: boolean }).isError).toBeFalsy();
  });

  it('reports a not-found callback without erroring', async () => {
    const { client } = await connect();
    const result = await client.callTool({
      name: 'get_callback',
      arguments: { correlationId: 'does-not-exist' },
    });
    expect(textOf(result)).toContain('"found": false');
  });
});
