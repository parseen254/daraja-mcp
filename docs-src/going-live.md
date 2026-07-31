---
title: Going live
description: Production checklist: credentials, callback security, reconciliation.
---

# Going live

Production means real money and irreversible mistakes. Read this before
switching `DARAJA_MODE`.

## Before you switch

**Get production credentials.** In the Daraja portal, take your app through Go
Live. You get a different consumer key and secret, and your own shortcode. None
of your sandbox values carry over.

**Ratiba needs a contract.** M-Pesa Ratiba is a commercial API. You email
`apisupport@safaricom.co.ke`, Safaricom's commercial team discusses terms, you
sign, and only then is it enabled on your shortcode. Pricing at time of writing
is 5% of transaction value capped at KES 5 per standing order executed,
exclusive of VAT, on top of the normal C2B tariff.

**Generate your own security credential.** The portal gives you a pre-encrypted
initiator password. It works, and it silently stops working when Safaricom
rotates the certificate. Generating it locally makes rotation a config change:

```ts
import { encryptSecurityCredential } from 'daraja-mcp';
import { readFileSync } from 'node:fs';

const cert = readFileSync('./ProductionCertificate.cer', 'utf8');
console.log(encryptSecurityCredential('your-initiator-password', cert));
```

The certificate is on the portal under the API docs. Note that Safaricom's cert
uses PKCS#1 v1.5 padding, not OAEP.

## Callback security

This is the part that actually matters.

Daraja callbacks are unsigned HTTP POSTs that change payment state. There is no
HMAC, no shared secret in the body, nothing to verify. If your callback URL is
reachable and unprotected, anyone who guesses it can tell your system a payment
succeeded when no money moved.

Three controls, all on by default in production:

**Source verification.** Only Safaricom's published egress ranges are accepted.
The server will not start in production with `DARAJA_CALLBACK_ALLOW_ANY_IP`
set. If Safaricom adds ranges, override with `DARAJA_CALLBACK_CIDRS`.

**Path secret.** Set `DARAJA_CALLBACK_PATH_SECRET` to a long random string.
Callback URLs become `/cb/<secret>/stk`, so the endpoint is unguessable even if
someone learns your hostname. Compared in constant time.

```bash
export DARAJA_CALLBACK_PATH_SECRET=$(openssl rand -hex 32)
```

**Proxy trust.** The server reads `X-Forwarded-For` only when it is behind a
proxy you have told it to trust. If you terminate TLS yourself with nothing in
front, that header is attacker-controlled and must not be trusted.

## Reconciliation

Callbacks get lost. The tunnel drops, your process restarts mid-delivery,
Safaricom's retry budget runs out. Do not treat a missing callback as a failed
payment.

**Callbacks are stored on disk.** Append-only JSON Lines at
`DARAJA_CALLBACK_STORE_DIR`, reloaded on restart, so a crash does not lose the
record of a settled payment. Back this up alongside your database.

**Query before retrying.** If a payment's outcome is unknown, call
`transaction_status` rather than resending. Resending an STK push to a customer
who already paid is how you double-charge someone.

**Backfill with pull transactions.** After an outage, `pull_transactions`
fetches C2B transactions for a window so you can reconcile what you missed.

**Watch for the two code spaces.** A synchronous `ResponseCode` of `0` means
"accepted for processing", not "paid". The callback's `ResultCode` of `0` means
paid. Conflating them means marking orders paid that never were. Ratiba makes
this worse by using `200` for sync success and `0` for callback success.

## Operational checklist

- [ ] Production credentials, separate from sandbox
- [ ] `DARAJA_MODE=production`
- [ ] `DARAJA_CALLBACK_PUBLIC_URL` on stable public HTTPS, not a dev tunnel
- [ ] `DARAJA_CALLBACK_PATH_SECRET` set to a random value
- [ ] Source verification left on
- [ ] Callback store directory on persistent, backed-up disk
- [ ] `server_health` checked after deploy
- [ ] Ratiba commercial agreement signed, if you use it
- [ ] Alerting on callbacks that never arrive for initiated payments

## What this server does not do

It is a Daraja client, not a ledger. It does not decide whether a payment
should happen, hold balances, or reconcile against your books. Those belong in
your system, where the money lives.
