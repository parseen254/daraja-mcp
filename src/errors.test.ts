import { describe, expect, it } from 'vitest';
import { DarajaError, describeResultCode, normaliseError } from './errors.js';

describe('DarajaError', () => {
  it('renders a readable tool result', () => {
    const err = new DarajaError({
      kind: 'validation',
      message: 'Something was wrong',
      code: '400.002.02',
      httpStatus: 400,
      hint: 'Shorten the reference',
    });

    const text = err.toToolResult();
    expect(text).toContain('Daraja error (validation): Something was wrong');
    expect(text).toContain('Code: 400.002.02');
    expect(text).toContain('HTTP: 400');
    expect(text).toContain('Hint: Shorten the reference');
  });

  it('omits absent fields rather than printing undefined', () => {
    const text = new DarajaError({ kind: 'unknown', message: 'Bare' }).toToolResult();
    expect(text).toBe('Daraja error (unknown): Bare');
  });

  it('is a real Error subclass', () => {
    const err = new DarajaError({ kind: 'unknown', message: 'x' });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('DarajaError');
    expect(err.stack).toBeTruthy();
  });
});

describe('describeResultCode', () => {
  it.each([
    ['1', 'insufficient_funds'],
    ['1032', 'cancelled_by_user'],
    ['1037', 'timeout'],
    ['2001', 'validation'],
    ['1001', 'duplicate'],
    ['1019', 'timeout'],
    ['17', 'validation'],
    ['404.001.03', 'validation'],
    ['400.002.02', 'validation'],
    ['500.001.1001', 'upstream'],
  ])('classifies %s as %s', (code, kind) => {
    expect(describeResultCode(code)?.kind).toBe(kind);
  });

  it('accepts a numeric code', () => {
    expect(describeResultCode(1032)?.kind).toBe('cancelled_by_user');
  });

  it('explains that a cancellation is a normal outcome', () => {
    // Worth stating: a model should not treat this as a fault to retry around.
    expect(describeResultCode('1032')?.hint).toMatch(/normal outcome/i);
  });

  it('warns against treating a server error as a payment failure', () => {
    expect(describeResultCode('500.001.1001')?.hint).toMatch(/do not treat as a payment failure/i);
  });

  it('returns null for unknown or absent codes', () => {
    expect(describeResultCode('99999')).toBeNull();
    expect(describeResultCode(undefined)).toBeNull();
  });
});

describe('normaliseError', () => {
  it('reads the requestId/errorCode/errorMessage envelope', () => {
    const err = normaliseError(400, {
      requestId: 'r-1',
      errorCode: '400.002.02',
      errorMessage: 'Bad Request - Invalid Amount',
    });
    expect(err.code).toBe('400.002.02');
    expect(err.message).toBe('Bad Request - Invalid Amount');
  });

  it('reads the ResponseCode/ResponseDescription envelope', () => {
    const err = normaliseError(200, {
      ResponseCode: '1',
      ResponseDescription: 'The balance is insufficient',
    });
    expect(err.kind).toBe('insufficient_funds');
  });

  it('reads the ResultCode/ResultDesc envelope used by callbacks', () => {
    const err = normaliseError(200, {
      ResultCode: '1032',
      ResultDesc: 'Request cancelled by user',
    });
    expect(err.kind).toBe('cancelled_by_user');
    expect(err.message).toBe('Request cancelled by user');
  });

  it('reads lowercase variants', () => {
    const err = normaliseError(400, { errorCode: undefined, resultCode: '1', resultDesc: 'low' });
    expect(err.kind).toBe('insufficient_funds');
  });

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [404, 'not_found'],
    [429, 'rate_limit'],
    [500, 'upstream'],
    [503, 'upstream'],
    [400, 'validation'],
    [422, 'validation'],
  ])('falls back to HTTP %i as %s', (status, kind) => {
    expect(normaliseError(status, {}).kind).toBe(kind);
  });

  it('classifies an unexpected 2xx failure as unknown', () => {
    expect(normaliseError(200, {}).kind).toBe('unknown');
  });

  it('synthesises a message when the body carries none', () => {
    expect(normaliseError(503, {}).message).toContain('HTTP 503');
  });

  it('survives a null or non-object body', () => {
    expect(() => normaliseError(500, null)).not.toThrow();
    expect(() => normaliseError(500, 'a string')).not.toThrow();
    expect(normaliseError(500, null).kind).toBe('upstream');
  });

  it('keeps the raw body for debugging', () => {
    const body = { errorCode: 'x', extra: { nested: true } };
    expect(normaliseError(400, body).raw).toEqual(body);
  });

  it('prefers a known code hint over the raw description', () => {
    const err = normaliseError(200, { ResultCode: '1001', ResultDesc: 'terse' });
    expect(err.hint).toContain('unresolved STK prompt');
  });
});
