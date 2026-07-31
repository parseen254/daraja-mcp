/**
 * Runtime configuration, resolved from environment variables.
 *
 * Three modes:
 *   - simulator: talk to the bundled fake Daraja. No Safaricom account needed.
 *   - sandbox:   talk to sandbox.safaricom.co.ke with sandbox credentials.
 *   - production: talk to api.safaricom.co.ke with live credentials.
 */

export type DarajaMode = 'simulator' | 'sandbox' | 'production';

export interface DarajaConfig {
  mode: DarajaMode;
  baseUrl: string;
  consumerKey: string;
  consumerSecret: string;
  /** Lipa na M-Pesa passkey, used to derive the STK push Password field. */
  passkey?: string;
  shortCode?: string;
  initiatorName?: string;
  /** Already-encrypted initiator password. See docs/security-credential.md. */
  securityCredential?: string;
  callback: CallbackConfig;
  /**
   * Whether tools that move money outward are permitted in production.
   *
   * Collecting a payment requires the customer to approve an M-Pesa prompt, so
   * there is a human in the loop. Paying out, reversing someone else's
   * transaction, and creating a standing order have no such check: an agent can
   * do them alone, and a standing order keeps debiting after the session ends.
   *
   * These stay available in simulator and sandbox, where no real money exists.
   * In production they require deliberate opt-in.
   */
  allowPayouts: boolean;
}

export interface CallbackConfig {
  /** Public base URL Safaricom will POST results to, e.g. https://abc.ngrok.io */
  publicUrl?: string;
  /** Port the local callback receiver listens on. */
  port: number;
  /**
   * Only accept callbacks from these CIDR ranges. Safaricom publishes its egress
   * IPs; anything else POSTing to an open callback endpoint is hostile.
   * Empty array disables the check (simulator mode does this deliberately).
   */
  allowedCidrs: string[];
  /**
   * Shared secret embedded in the callback path, so the URL itself is unguessable.
   * Defence in depth alongside the IP allowlist.
   */
  pathSecret?: string;
  /** Directory for durable callback storage. Survives restarts. */
  storeDir: string;
}

const SANDBOX_URL = 'https://sandbox.safaricom.co.ke';
const PRODUCTION_URL = 'https://api.safaricom.co.ke';

/**
 * Safaricom's published egress ranges for Daraja callbacks.
 * Source: Daraja portal "Go Live" documentation, whitelisting section.
 */
export const SAFARICOM_CIDRS = [
  '196.201.214.200/32',
  '196.201.214.206/32',
  '196.201.213.114/32',
  '196.201.214.207/32',
  '196.201.214.208/32',
  '196.201.213.44/32',
  '196.201.212.127/32',
  '196.201.212.138/32',
  '196.201.212.129/32',
  '196.201.212.136/32',
  '196.201.212.74/32',
  '196.201.212.69/32',
];

/**
 * Read a boolean flag from the supplied environment.
 *
 * Takes the env explicitly rather than reaching for process.env, so that a
 * caller passing its own environment gets consistent behaviour. Reading the
 * ambient process.env here would silently ignore a flag the caller set, and
 * would let the production guard below be bypassed.
 */
function envFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  const v = env[name];
  return v === '1' || v === 'true' || v === 'yes';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DarajaConfig {
  const explicitMode = env.DARAJA_MODE as DarajaMode | undefined;

  // Default to simulator when no credentials are present. This is what makes
  // `npx daraja-mcp` work on a machine that has never heard of Safaricom.
  const hasCreds = Boolean(env.DARAJA_CONSUMER_KEY && env.DARAJA_CONSUMER_SECRET);
  const mode: DarajaMode = explicitMode ?? (hasCreds ? 'sandbox' : 'simulator');

  if (!['simulator', 'sandbox', 'production'].includes(mode)) {
    throw new Error(
      `Invalid DARAJA_MODE "${mode}". Expected one of: simulator, sandbox, production.`,
    );
  }

  if (mode !== 'simulator' && !hasCreds) {
    throw new Error(
      `DARAJA_MODE=${mode} requires DARAJA_CONSUMER_KEY and DARAJA_CONSUMER_SECRET. ` +
        `Leave them unset to run in simulator mode instead.`,
    );
  }

  const baseUrl =
    env.DARAJA_BASE_URL ??
    (mode === 'production' ? PRODUCTION_URL : mode === 'sandbox' ? SANDBOX_URL : 'http://127.0.0.1:0');

  // In production, refusing to skip IP verification is the safe default. An open
  // callback endpoint that mutates payment state is a real vulnerability.
  const skipIpCheck = envFlag(env, 'DARAJA_CALLBACK_ALLOW_ANY_IP');
  if (skipIpCheck && mode === 'production') {
    throw new Error(
      'DARAJA_CALLBACK_ALLOW_ANY_IP cannot be set in production mode. ' +
        'Callback source verification is required when handling real money.',
    );
  }

  const allowedCidrs =
    mode === 'simulator' || skipIpCheck
      ? []
      : (env.DARAJA_CALLBACK_CIDRS?.split(',').map((s) => s.trim()).filter(Boolean) ??
        SAFARICOM_CIDRS);

  return {
    mode,
    baseUrl,
    consumerKey: env.DARAJA_CONSUMER_KEY ?? 'simulator-key',
    consumerSecret: env.DARAJA_CONSUMER_SECRET ?? 'simulator-secret',
    passkey: env.DARAJA_PASSKEY,
    shortCode: env.DARAJA_SHORTCODE,
    initiatorName: env.DARAJA_INITIATOR_NAME,
    securityCredential: env.DARAJA_SECURITY_CREDENTIAL,
    callback: {
      publicUrl: env.DARAJA_CALLBACK_PUBLIC_URL,
      port: Number(env.DARAJA_CALLBACK_PORT ?? 8787),
      allowedCidrs,
      pathSecret: env.DARAJA_CALLBACK_PATH_SECRET,
      storeDir: env.DARAJA_CALLBACK_STORE_DIR ?? '.daraja-callbacks',
    },
    // Outside production there is no real money to protect, so payouts are
    // always available. In production they are off unless explicitly enabled.
    allowPayouts: mode === 'production' ? envFlag(env, 'DARAJA_ALLOW_PAYOUTS') : true,
  };
}
