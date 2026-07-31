import { describe, expect, it } from 'vitest';
import { ipInCidr, isAllowedSource, normaliseIp, resolveClientIp } from './ip.js';
import { SAFARICOM_CIDRS } from '../config.js';

describe('normaliseIp', () => {
  it('unwraps IPv4-mapped IPv6 addresses', () => {
    expect(normaliseIp('::ffff:196.201.214.200')).toBe('196.201.214.200');
  });

  it('leaves plain IPv4 untouched', () => {
    expect(normaliseIp('196.201.214.200')).toBe('196.201.214.200');
  });

  it('trims surrounding whitespace', () => {
    expect(normaliseIp('  10.0.0.1  ')).toBe('10.0.0.1');
  });
});

describe('ipInCidr', () => {
  it('matches an exact /32', () => {
    expect(ipInCidr('196.201.214.200', '196.201.214.200/32')).toBe(true);
    expect(ipInCidr('196.201.214.201', '196.201.214.200/32')).toBe(false);
  });

  it('matches within a /24', () => {
    expect(ipInCidr('196.201.214.55', '196.201.214.0/24')).toBe(true);
    expect(ipInCidr('196.201.215.55', '196.201.214.0/24')).toBe(false);
  });

  it('handles a /0 as match-all', () => {
    expect(ipInCidr('8.8.8.8', '0.0.0.0/0')).toBe(true);
  });

  it('treats a bare address as /32', () => {
    expect(ipInCidr('10.0.0.1', '10.0.0.1')).toBe(true);
    expect(ipInCidr('10.0.0.2', '10.0.0.1')).toBe(false);
  });

  it('handles high octets without sign errors', () => {
    // 196.x sets the high bit of the int32; a naive shift makes this negative.
    expect(ipInCidr('196.201.214.200', '196.0.0.0/8')).toBe(true);
    expect(ipInCidr('255.255.255.255', '255.255.255.255/32')).toBe(true);
  });

  it.each([
    ['not-an-ip', '10.0.0.0/8'],
    ['10.0.0.1', 'garbage'],
    ['999.1.1.1', '10.0.0.0/8'],
    ['10.0.0', '10.0.0.0/8'],
    ['10.0.0.1', '10.0.0.0/33'],
  ])('returns false for malformed input (%s, %s)', (ip, cidr) => {
    expect(ipInCidr(ip, cidr)).toBe(false);
  });
});

describe('isAllowedSource', () => {
  it('accepts every published Safaricom address', () => {
    for (const cidr of SAFARICOM_CIDRS) {
      const ip = cidr.split('/')[0]!;
      expect(isAllowedSource(ip, SAFARICOM_CIDRS)).toBe(true);
    }
  });

  it('rejects an arbitrary internet host', () => {
    expect(isAllowedSource('8.8.8.8', SAFARICOM_CIDRS)).toBe(false);
    expect(isAllowedSource('196.201.214.199', SAFARICOM_CIDRS)).toBe(false);
  });

  it('allows anything when the list is empty (simulator mode)', () => {
    expect(isAllowedSource('8.8.8.8', [])).toBe(true);
  });
});

describe('resolveClientIp', () => {
  it('uses the socket address when not trusting a proxy', () => {
    expect(resolveClientIp('10.0.0.5', '8.8.8.8', false)).toBe('10.0.0.5');
  });

  it('ignores a spoofed forwarded header when trustProxy is off', () => {
    // The attack: forge XFF to look like Safaricom. Must not work.
    expect(resolveClientIp('8.8.8.8', '196.201.214.200', false)).toBe('8.8.8.8');
  });

  it('uses the leftmost forwarded entry when trusting a proxy', () => {
    expect(resolveClientIp('10.0.0.5', '196.201.214.200, 10.0.0.1', true)).toBe(
      '196.201.214.200',
    );
  });

  it('falls back to the socket when the header is absent', () => {
    expect(resolveClientIp('10.0.0.5', undefined, true)).toBe('10.0.0.5');
  });

  it('returns an empty string when there is no address at all', () => {
    expect(resolveClientIp(undefined, undefined, true)).toBe('');
  });
});
