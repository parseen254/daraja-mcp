#!/usr/bin/env node
/**
 * End-to-end check that the built CLI starts, speaks MCP over stdio, and can
 * take a payment through to a settled result.
 *
 * Runs against the simulator, so CI needs no Safaricom credentials.
 */
import { spawn } from 'node:child_process';

const proc = spawn('node', ['dist/cli.js'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    DARAJA_MODE: 'simulator',
    DARAJA_SHORTCODE: '174379',
    DARAJA_PASSKEY: 'smoke-test-passkey',
    // Port 0 lets the OS pick, so parallel CI jobs do not collide.
    DARAJA_CALLBACK_PORT: '0',
  },
});

let buffer = '';
const pending = new Map();
let nextId = 1;

proc.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      }
    } catch {
      // Non-JSON on stdout would be a bug, but do not crash the harness here.
    }
  }
});

const serverLog = [];
proc.stderr.on('data', (d) => serverLog.push(d.toString()));

function send(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), 30000);
  });
}

const failures = [];
function check(label, condition, detail = '') {
  const status = condition ? 'ok' : 'FAIL';
  console.log(`  ${status}  ${label}${detail ? ` (${detail})` : ''}`);
  if (!condition) failures.push(label);
}

function textOf(response) {
  return response.result?.content?.[0]?.text ?? '';
}

try {
  const init = await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'ci-smoke', version: '1.0.0' },
  });
  check('handshake', init.result?.serverInfo?.name === 'daraja-mcp');

  proc.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`,
  );

  const list = await send('tools/list', {});
  const tools = list.result?.tools ?? [];
  const names = tools.map((t) => t.name);
  check('tools registered', tools.length >= 20, `${tools.length} tools`);

  for (const required of [
    'stk_push',
    'stk_push_and_wait',
    'stk_query',
    'ratiba_create',
    'ratiba_create_and_wait',
    'b2c_payment',
    'account_balance',
    'transaction_status',
    'check_sim_swap',
    'list_callbacks',
    'server_health',
  ]) {
    check(`tool ${required}`, names.includes(required));
  }

  const health = textOf(await send('tools/call', { name: 'server_health', arguments: {} }));
  check('health reports simulator mode', health.includes('simulator'));

  // The full asynchronous cycle: initiate, callback delivered, result returned.
  const success = textOf(
    await send('tools/call', {
      name: 'stk_push_and_wait',
      arguments: {
        phoneNumber: '0712345678',
        amount: 100,
        accountReference: 'CI',
        timeoutSeconds: 20,
      },
    }),
  );
  check('payment settles', success.includes('"status": "success"'));
  check('receipt returned', success.includes('MpesaReceiptNumber'));

  // Failure path, including the absence of metadata that trips naive parsers.
  const cancelled = textOf(
    await send('tools/call', {
      name: 'stk_push_and_wait',
      arguments: { phoneNumber: '0712345678', amount: 1032, timeoutSeconds: 20 },
    }),
  );
  check('cancellation reported as failure', cancelled.includes('"status": "failure"'));
  check('cancellation carries result code', cancelled.includes('1032'));

  const ratiba = textOf(
    await send('tools/call', {
      name: 'ratiba_create_and_wait',
      arguments: {
        standingOrderName: 'CI standing order',
        phoneNumber: '0712345678',
        amount: 500,
        startDate: '2026-08-01',
        endDate: '2027-08-01',
        frequency: 'monthly',
        timeoutSeconds: 20,
      },
    }),
  );
  check('standing order settles', ratiba.includes('"status": "success"'));
  check('standing order is active', ratiba.includes('ACTIVE'));

  const invalid = await send('tools/call', {
    name: 'stk_push',
    arguments: { phoneNumber: '0812345678', amount: 10 },
  });
  check('invalid number rejected', invalid.result?.isError === true);

  const callbacks = textOf(await send('tools/call', { name: 'list_callbacks', arguments: {} }));
  check('callbacks recorded', callbacks.includes('"kind"'));
} catch (err) {
  console.error(`\nSmoke test error: ${err.message}`);
  if (serverLog.length) console.error(`Server output:\n${serverLog.join('')}`);
  failures.push('exception');
} finally {
  proc.kill();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`);
  process.exit(1);
}

console.log('\nSmoke test passed.');
process.exit(0);
