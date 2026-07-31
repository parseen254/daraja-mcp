import { describe, expect, it } from 'vitest';
import { loadConfig, SAFARICOM_CIDRS } from './config.js';

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

describe('mode selection', () => {
  it('falls back to the simulator when no credentials are present', () => {
    // This is what makes `npx daraja-mcp` work on a machine with no account.
    expect(loadConfig(env({})).mode).toBe('simulator');
  });

  it('assumes sandbox once credentials appear', () => {
    const config = loadConfig(
      env({ DARAJA_CONSUMER_KEY: 'k', DARAJA_CONSUMER_SECRET: 's' }),
    );
    expect(config.mode).toBe('sandbox');
    expect(config.baseUrl).toBe('https://sandbox.safaricom.co.ke');
  });

  it('uses the production host when asked', () => {
    const config = loadConfig(
      env({
        DARAJA_MODE: 'production',
        DARAJA_CONSUMER_KEY: 'k',
        DARAJA_CONSUMER_SECRET: 's',
      }),
    );
    expect(config.baseUrl).toBe('https://api.safaricom.co.ke');
  });

  it('honours an explicit simulator mode even with credentials set', () => {
    const config = loadConfig(
      env({
        DARAJA_MODE: 'simulator',
        DARAJA_CONSUMER_KEY: 'k',
        DARAJA_CONSUMER_SECRET: 's',
      }),
    );
    expect(config.mode).toBe('simulator');
  });

  it('rejects an unrecognised mode', () => {
    expect(() => loadConfig(env({ DARAJA_MODE: 'staging' }))).toThrowError(/Invalid DARAJA_MODE/);
  });

  it.each(['sandbox', 'production'])('requires credentials for %s mode', (mode) => {
    expect(() => loadConfig(env({ DARAJA_MODE: mode }))).toThrowError(
      /requires DARAJA_CONSUMER_KEY/,
    );
  });

  it('supplies placeholder credentials in simulator mode', () => {
    const config = loadConfig(env({}));
    expect(config.consumerKey).toBe('simulator-key');
    expect(config.consumerSecret).toBe('simulator-secret');
  });

  it('allows the base URL to be overridden', () => {
    const config = loadConfig(
      env({
        DARAJA_CONSUMER_KEY: 'k',
        DARAJA_CONSUMER_SECRET: 's',
        DARAJA_BASE_URL: 'https://proxy.internal',
      }),
    );
    expect(config.baseUrl).toBe('https://proxy.internal');
  });
});

describe('callback source verification', () => {
  it('defaults to Safaricom published ranges outside the simulator', () => {
    const config = loadConfig(
      env({ DARAJA_CONSUMER_KEY: 'k', DARAJA_CONSUMER_SECRET: 's' }),
    );
    expect(config.callback.allowedCidrs).toEqual(SAFARICOM_CIDRS);
  });

  it('accepts no ranges in simulator mode', () => {
    expect(loadConfig(env({})).callback.allowedCidrs).toEqual([]);
  });

  it('allows the ranges to be overridden', () => {
    const config = loadConfig(
      env({
        DARAJA_CONSUMER_KEY: 'k',
        DARAJA_CONSUMER_SECRET: 's',
        DARAJA_CALLBACK_CIDRS: '10.0.0.0/8, 192.168.1.1/32',
      }),
    );
    expect(config.callback.allowedCidrs).toEqual(['10.0.0.0/8', '192.168.1.1/32']);
  });

  it('ignores empty entries in an override list', () => {
    const config = loadConfig(
      env({
        DARAJA_CONSUMER_KEY: 'k',
        DARAJA_CONSUMER_SECRET: 's',
        DARAJA_CALLBACK_CIDRS: '10.0.0.0/8,,  ,192.168.1.1/32',
      }),
    );
    expect(config.callback.allowedCidrs).toHaveLength(2);
  });

  it.each(['1', 'true', 'yes'])('honours the escape hatch in sandbox (%s)', (value) => {
    const config = loadConfig(
      env({
        DARAJA_CONSUMER_KEY: 'k',
        DARAJA_CONSUMER_SECRET: 's',
        DARAJA_CALLBACK_ALLOW_ANY_IP: value,
      }),
    );
    expect(config.callback.allowedCidrs).toEqual([]);
  });

  it('refuses to disable verification in production', () => {
    // An open callback endpoint handling real money is a genuine vulnerability.
    expect(() =>
      loadConfig(
        env({
          DARAJA_MODE: 'production',
          DARAJA_CONSUMER_KEY: 'k',
          DARAJA_CONSUMER_SECRET: 's',
          DARAJA_CALLBACK_ALLOW_ANY_IP: '1',
        }),
      ),
    ).toThrowError(/cannot be set in production/);
  });

  it('ignores an unset-looking escape hatch value', () => {
    const config = loadConfig(
      env({
        DARAJA_MODE: 'production',
        DARAJA_CONSUMER_KEY: 'k',
        DARAJA_CONSUMER_SECRET: 's',
        DARAJA_CALLBACK_ALLOW_ANY_IP: 'false',
      }),
    );
    expect(config.callback.allowedCidrs).toEqual(SAFARICOM_CIDRS);
  });

  it('publishes only /32 host addresses', () => {
    for (const cidr of SAFARICOM_CIDRS) {
      expect(cidr).toMatch(/^\d+\.\d+\.\d+\.\d+\/32$/);
    }
  });
});

describe('callback settings', () => {
  it('defaults the port and store directory', () => {
    const config = loadConfig(env({}));
    expect(config.callback.port).toBe(8787);
    expect(config.callback.storeDir).toBe('.daraja-callbacks');
  });

  it('reads overrides from the environment', () => {
    const config = loadConfig(
      env({
        DARAJA_CALLBACK_PORT: '9000',
        DARAJA_CALLBACK_STORE_DIR: '/var/daraja',
        DARAJA_CALLBACK_PUBLIC_URL: 'https://tunnel.test',
        DARAJA_CALLBACK_PATH_SECRET: 'abc123',
      }),
    );
    expect(config.callback.port).toBe(9000);
    expect(config.callback.storeDir).toBe('/var/daraja');
    expect(config.callback.publicUrl).toBe('https://tunnel.test');
    expect(config.callback.pathSecret).toBe('abc123');
  });
});

describe('credential passthrough', () => {
  it('carries the optional product credentials', () => {
    const config = loadConfig(
      env({
        DARAJA_CONSUMER_KEY: 'k',
        DARAJA_CONSUMER_SECRET: 's',
        DARAJA_SHORTCODE: '174379',
        DARAJA_PASSKEY: 'pk',
        DARAJA_INITIATOR_NAME: 'api',
        DARAJA_SECURITY_CREDENTIAL: 'cred',
      }),
    );
    expect(config).toMatchObject({
      shortCode: '174379',
      passkey: 'pk',
      initiatorName: 'api',
      securityCredential: 'cred',
    });
  });

  it('leaves optional credentials undefined when absent', () => {
    const config = loadConfig(env({}));
    expect(config.shortCode).toBeUndefined();
    expect(config.passkey).toBeUndefined();
  });
});
