/**
 * Source IP verification for inbound callbacks.
 *
 * A Daraja callback endpoint mutates payment state, and it is a plain unsigned
 * HTTP POST. Safaricom does not sign callback bodies, so the only thing
 * distinguishing a genuine result from a forged one is where it came from.
 * An open callback URL lets anyone mark an unpaid order as paid.
 */

/** Parse an IPv4 dotted quad into a 32-bit unsigned integer. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;

  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = (out << 8) | n;
  }
  // Force unsigned; the left shift above can produce a negative int32.
  return out >>> 0;
}

/**
 * Node reports IPv4 peers over a dual-stack socket as IPv4-mapped IPv6
 * (::ffff:196.201.214.200). Unwrap those so the comparison is like for like.
 */
export function normaliseIp(raw: string): string {
  const ip = raw.trim();
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  return ip;
}

/** Does `ip` fall inside `cidr`? IPv4 only, which is all Safaricom publishes. */
export function ipInCidr(ip: string, cidr: string): boolean {
  const [range, bitsRaw] = cidr.split('/');
  if (!range) return false;

  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;

  const ipInt = ipv4ToInt(normaliseIp(ip));
  const rangeInt = ipv4ToInt(range);
  if (ipInt === null || rangeInt === null) return false;

  if (bits === 0) return true;
  const mask = (~0 << (32 - bits)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

/** True when the address matches any allowed range. Empty list means "allow all". */
export function isAllowedSource(ip: string, allowedCidrs: readonly string[]): boolean {
  if (allowedCidrs.length === 0) return true;
  return allowedCidrs.some((cidr) => ipInCidr(ip, cidr));
}

/**
 * Resolve the client address, honouring X-Forwarded-For only when the request
 * arrives through a proxy we were told to trust.
 *
 * Trusting XFF unconditionally would defeat the whole check, since the header
 * is attacker-controlled. Most people run this behind ngrok or a load balancer,
 * so we cannot simply ignore it either.
 */
export function resolveClientIp(
  socketAddress: string | undefined,
  forwardedFor: string | undefined,
  trustProxy: boolean,
): string {
  if (trustProxy && forwardedFor) {
    // Leftmost entry is the original client; the rest are proxy hops.
    const first = forwardedFor.split(',')[0]?.trim();
    if (first) return normaliseIp(first);
  }
  return normaliseIp(socketAddress ?? '');
}
