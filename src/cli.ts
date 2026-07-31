import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer, SERVER_NAME, SERVER_VERSION } from './server.js';
import { loadConfig } from './config.js';

/**
 * Entry point for `npx daraja-mcp`.
 *
 * Everything is logged to stderr, because stdout carries the MCP protocol and
 * a stray console.log there corrupts the stream.
 */

function log(message: string): void {
  process.stderr.write(`[daraja-mcp] ${message}\n`);
}

function printHelp(): void {
  process.stdout.write(`${SERVER_NAME} ${SERVER_VERSION}

MCP server for the Safaricom M-Pesa Daraja 3.0 API.

Usage:
  npx daraja-mcp              Start the server on stdio
  npx daraja-mcp --help       Show this message
  npx daraja-mcp --version    Print the version

Modes:
  Without credentials it runs against a built-in simulator, so you can explore
  every tool without a Safaricom account. Set credentials to talk to the real
  sandbox, and DARAJA_MODE=production to go live.

Environment:
  DARAJA_MODE                    simulator | sandbox | production
  DARAJA_CONSUMER_KEY            From your Daraja app
  DARAJA_CONSUMER_SECRET         From your Daraja app
  DARAJA_SHORTCODE               PayBill or till number
  DARAJA_PASSKEY                 Lipa na M-Pesa passkey, for STK push
  DARAJA_INITIATOR_NAME          For B2C, B2B, reversals, balance
  DARAJA_SECURITY_CREDENTIAL     Encrypted initiator password
  DARAJA_CALLBACK_PUBLIC_URL     Public HTTPS URL Safaricom can reach
  DARAJA_CALLBACK_PORT           Local callback port (default 8787)
  DARAJA_CALLBACK_PATH_SECRET    Unguessable path segment for callbacks
  DARAJA_CALLBACK_CIDRS          Override the allowed source ranges
  DARAJA_DISABLE_RECEIVER        Set to skip the callback listener

Docs: https://parseen254.github.io/daraja-mcp
`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return;
  }

  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    log(`Configuration error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const { server, context, shutdown } = await createServer({ config, onLog: log });

  log(`Mode: ${context.client.mode}`);
  log(`Daraja base URL: ${context.client.baseUrl}`);

  if (context.receiver) {
    log(`Callbacks: ${context.receiver.baseUrl()}`);
    if (config.mode !== 'simulator' && !config.callback.publicUrl) {
      log(
        'Warning: DARAJA_CALLBACK_PUBLIC_URL is not set. Safaricom cannot reach a ' +
          'localhost URL, so results will never arrive. Expose the port with a tunnel ' +
          'and set that URL.',
      );
    }
    if (config.mode === 'production' && config.callback.allowedCidrs.length === 0) {
      log('Warning: callback source verification is disabled in production.');
    }
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('Ready.');

  const close = async (signal: string) => {
    log(`Received ${signal}, shutting down.`);
    await shutdown();
    process.exit(0);
  };

  process.on('SIGINT', () => void close('SIGINT'));
  process.on('SIGTERM', () => void close('SIGTERM'));
}

main().catch((err) => {
  log(`Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
