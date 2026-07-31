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

/** Wrap a handler so thrown DarajaErrors become readable tool output. */
export async function toolResult(
  fn: () => Promise<unknown>,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const value = await fn();
    return {
      content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    };
  } catch (err) {
    const text =
      err instanceof DarajaError
        ? err.toToolResult()
        : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
    return { content: [{ type: 'text', text }], isError: true };
  }
}
