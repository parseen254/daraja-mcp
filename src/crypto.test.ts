import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { darajaTimestamp, normaliseMsisdn, stkCredentials, stkPassword } from './crypto.js';

describe('darajaTimestamp', () => {
  it('formats as YYYYMMDDHHmmss', () => {
    const ts = darajaTimestamp(new Date('2026-06-28T06:24:08Z'));
    expect(ts).toMatch(/^\d{14}$/);
  });

  it('renders in East Africa Time, not UTC', () => {
    // 06:24:08 UTC is 09:24:08 in Nairobi.
    expect(darajaTimestamp(new Date('2026-06-28T06:24:08Z'))).toBe('20260628092408');
  });

  it('rolls the date forward when UTC evening is next-day EAT', () => {
    // 22:30 UTC on the 28th is 01:30 on the 29th in Nairobi.
    expect(darajaTimestamp(new Date('2026-06-28T22:30:00Z'))).toBe('20260629013000');
  });

  it('zero-pads single-digit components', () => {
    expect(darajaTimestamp(new Date('2026-01-05T02:03:04Z'))).toBe('20260105050304');
  });
});

describe('stkPassword', () => {
  it('is base64 of shortcode + passkey + timestamp', () => {
    const password = stkPassword('174379', 'bfb279f9aa9bdbcf', '20210628092408');
    expect(Buffer.from(password, 'base64').toString('utf8')).toBe(
      '174379bfb279f9aa9bdbcf20210628092408',
    );
  });
});

describe('stkCredentials', () => {
  it('derives a password matching the timestamp it returns', () => {
    const { timestamp, password } = stkCredentials('174379', 'passkey123');
    const decoded = Buffer.from(password, 'base64').toString('utf8');
    // The exact timestamp must be embedded; a mismatch here is the classic
    // intermittent STK failure across a second boundary.
    expect(decoded).toBe(`174379passkey123${timestamp}`);
  });
});

describe('normaliseMsisdn', () => {
  it.each([
    ['0712345678', '254712345678'],
    ['+254712345678', '254712345678'],
    ['254712345678', '254712345678'],
    ['712345678', '254712345678'],
    ['0112345678', '254112345678'],
    ['+254 712 345 678', '254712345678'],
    ['0712-345-678', '254712345678'],
    ['(254) 712345678', '254712345678'],
  ])('normalises %s to %s', (input, expected) => {
    expect(normaliseMsisdn(input)).toBe(expected);
  });

  it.each([
    ['', 'empty'],
    ['12345', 'too short'],
    ['0812345678', 'invalid prefix 8'],
    ['07123456789', 'too long'],
    ['254612345678', 'invalid prefix 6'],
    ['abcdefghij', 'not numeric'],
  ])('rejects %s (%s)', (input) => {
    expect(normaliseMsisdn(input)).toBeNull();
  });
});
