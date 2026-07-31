import { Buffer } from 'node:buffer';
import { constants, publicEncrypt } from 'node:crypto';

/**
 * Daraja's two encoding rituals. Both are documented ambiguously and are a
 * common source of "Invalid Access Token" and "Invalid Initiator" errors that
 * actually have nothing to do with either.
 */

/**
 * Timestamp in Daraja's required format: YYYYMMDDHHmmss, in East Africa Time.
 *
 * Safaricom's servers interpret this as Nairobi local time (UTC+3, no DST).
 * Using UTC here is the single most common STK push bug: the request is
 * rejected as expired because the timestamp is three hours in the past.
 */
export function darajaTimestamp(date: Date = new Date()): string {
  // Shift into UTC+3 regardless of the host machine's timezone.
  const eat = new Date(date.getTime() + 3 * 60 * 60 * 1000);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return (
    `${eat.getUTCFullYear()}` +
    pad(eat.getUTCMonth() + 1) +
    pad(eat.getUTCDate()) +
    pad(eat.getUTCHours()) +
    pad(eat.getUTCMinutes()) +
    pad(eat.getUTCSeconds())
  );
}

/**
 * The STK push Password field: base64(Shortcode + Passkey + Timestamp).
 *
 * The timestamp used here MUST be the same one sent in the Timestamp field.
 * Deriving them separately introduces a race across a second boundary that
 * fails roughly 1 in 1000 requests, which is exactly the kind of bug that only
 * shows up in production.
 */
export function stkPassword(
  shortCode: string,
  passkey: string,
  timestamp: string,
): string {
  return Buffer.from(`${shortCode}${passkey}${timestamp}`).toString('base64');
}

/** Convenience: derive a matching timestamp and password in one call. */
export function stkCredentials(
  shortCode: string,
  passkey: string,
  date: Date = new Date(),
): { timestamp: string; password: string } {
  const timestamp = darajaTimestamp(date);
  return { timestamp, password: stkPassword(shortCode, passkey, timestamp) };
}

/**
 * SecurityCredential: the initiator password, RSA-encrypted with Safaricom's
 * public certificate and base64 encoded.
 *
 * Most integrators paste a pre-generated value from the portal, which is fine,
 * but it silently expires when the certificate rotates. Generating it locally
 * from the cert makes rotation a config change rather than an outage.
 *
 * Safaricom's cert uses PKCS#1 v1.5 padding, not OAEP.
 */
export function encryptSecurityCredential(
  initiatorPassword: string,
  certificatePem: string,
): string {
  return publicEncrypt(
    {
      key: certificatePem,
      padding: constants.RSA_PKCS1_PADDING,
    },
    Buffer.from(initiatorPassword, 'utf8'),
  ).toString('base64');
}

/**
 * Normalise a Kenyan phone number into Daraja's required 2547XXXXXXXX /
 * 2541XXXXXXXX form.
 *
 * Accepts the shapes real users type: 0712..., +254712..., 254712..., 712...
 * Returns null when the input cannot be a valid Safaricom-format MSISDN, so
 * callers can fail with a clear message instead of letting Daraja reject it
 * with an opaque code.
 */
export function normaliseMsisdn(input: string): string | null {
  const digits = input.replace(/[\s\-()+]/g, '');

  let national: string;
  if (digits.startsWith('254')) {
    national = digits.slice(3);
  } else if (digits.startsWith('0')) {
    national = digits.slice(1);
  } else {
    national = digits;
  }

  // Kenyan mobile numbers are 9 digits after the country code and start with 7 or 1.
  if (!/^[71]\d{8}$/.test(national)) return null;

  return `254${national}`;
}
