/**
 * Programmatic entry point, for embedding the server or reusing its pieces.
 * The Daraja client, simulator, and callback receiver are all useful on their
 * own, independently of MCP.
 */

export { createServer, SERVER_NAME, SERVER_VERSION } from './server.js';
export type { CreateServerOptions, RunningServer } from './server.js';

export { DarajaClient } from './client.js';
export type { RequestOptions } from './client.js';

export { loadConfig, SAFARICOM_CIDRS } from './config.js';
export type { DarajaConfig, DarajaMode, CallbackConfig } from './config.js';

export { DarajaError, describeResultCode, normaliseError } from './errors.js';
export type { DarajaErrorKind } from './errors.js';

export {
  darajaTimestamp,
  encryptSecurityCredential,
  normaliseMsisdn,
  stkCredentials,
  stkPassword,
} from './crypto.js';

export { CallbackReceiver } from './callbacks/receiver.js';
export type { ReceiverOptions } from './callbacks/receiver.js';
export { CallbackStore, correlationIdOf, kindOf, outcomeOf } from './callbacks/store.js';
export type { CallbackKind, CallbackRecord } from './callbacks/store.js';
export { ipInCidr, isAllowedSource, normaliseIp, resolveClientIp } from './callbacks/ip.js';

export { DarajaSimulator } from './simulator/server.js';
export type { SimulatorOptions } from './simulator/server.js';
export * as fixtures from './simulator/fixtures.js';

export { RATIBA_FREQUENCIES } from './tools/payments.js';
export type { RatibaFrequency } from './tools/payments.js';
