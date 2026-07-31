import type { DarajaClient } from '../client.js';
import type { CallbackReceiver } from '../callbacks/receiver.js';
import type { DarajaConfig } from '../config.js';
import { DarajaError } from '../errors.js';

/** Everything the tool handlers need, passed explicitly so they stay testable. */
export interface ToolContext {
  client: DarajaClient;
  config: DarajaConfig;
  receiver: CallbackReceiver | null;
}

/** Require a config value that only matters for certain products. */
export function requireConfig(
  ctx: ToolContext,
  key: 'shortCode' | 'passkey' | 'initiatorName' | 'securityCredential',
  envName: string,
): string {
  const value = ctx.config[key];
  if (!value) {
    throw new DarajaError({
      kind: 'config',
      message: `Missing required configuration: ${envName}`,
      hint: `Set ${envName} in your environment. In simulator mode a placeholder is used automatically, so this usually means you are in sandbox or production without full credentials.`,
    });
  }
  return value;
}

/**
 * Resolve a callback URL for a product.
 *
 * Prefers the running receiver so results are actually captured. Falls back to
 * an explicitly supplied URL, and finally errors rather than silently sending
 * Safaricom a URL that nothing is listening on, which is how integrators end up
 * with payments they cannot account for.
 */
export function callbackUrl(
  ctx: ToolContext,
  kind: string,
  explicit?: string,
): string {
  if (explicit) return explicit;
  if (ctx.receiver) return ctx.receiver.urlFor(kind);
  throw new DarajaError({
    kind: 'config',
    message: 'No callback URL available',
    hint: 'Either enable the built-in receiver, or pass an explicit callback URL. Daraja will not deliver the result of this request without one.',
  });
}

/**
 * Refuse a money-moving operation that has not been explicitly enabled.
 *
 * Call this at the top of any tool that sends money out, reverses someone
 * else's transaction, or sets up a recurring debit. Collecting a payment is
 * exempt: the customer has to approve the M-Pesa prompt, so a human is already
 * in the loop.
 */
export function requirePayoutsAllowed(ctx: ToolContext, toolName: string): void {
  if (ctx.config.allowPayouts) return;

  throw new DarajaError({
    kind: 'config',
    message: `${toolName} moves money out and is disabled in production by default`,
    hint:
      'Set DARAJA_ALLOW_PAYOUTS=true to enable it. Before you do: this tool can be ' +
      'called by an agent without a human approving anything on their phone, unlike ' +
      'a payment prompt. Make sure whatever calls it has its own authorisation step.',
  });
}

/**
 * Environment marker attached to every tool result.
 *
 * A model cannot otherwise tell whether it just moved real money or talked to
 * the simulator, and neither can someone reading a transcript later. Both need
 * to see it without having to ask.
 */
export function environmentBanner(ctx: ToolContext): string {
  switch (ctx.config.mode) {
    case 'simulator':
      return 'SIMULATOR: no real money, no Safaricom account, nothing left this machine.';
    case 'sandbox':
      return 'SANDBOX: Safaricom test environment. No real money.';
    case 'production':
      return 'PRODUCTION: real money.';
  }
}

/** Wrap a handler so thrown DarajaErrors become readable tool output. */
export async function toolResult(
  ctx: ToolContext,
  fn: () => Promise<unknown>,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const value = await fn();
    // Spread first so the environment always wins. A response echoing an
    // attacker-influenced field must not be able to claim it came from the
    // simulator while real money is moving.
    const payload =
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? { ...(value as Record<string, unknown>), environment: ctx.config.mode }
        : { result: value, environment: ctx.config.mode };

    return {
      content: [
        {
          type: 'text',
          text: `${environmentBanner(ctx)}\n\n${JSON.stringify(payload, null, 2)}`,
        },
      ],
    };
  } catch (err) {
    const text =
      err instanceof DarajaError
        ? err.toToolResult()
        : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
    return {
      content: [{ type: 'text', text: `${environmentBanner(ctx)}\n\n${text}` }],
      isError: true,
    };
  }
}
