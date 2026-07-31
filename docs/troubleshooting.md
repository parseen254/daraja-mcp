# Troubleshooting

Start with `server_health`. It reports the mode, which credentials are present,
and whether the callback receiver is running. Most problems are visible there.

## "Invalid Access Token" (404.001.03)

Rarely about the token.

**Wrong environment.** Sandbox credentials against production, or the reverse.
The error is identical either way.

**Product not enabled on the app.** If you did not tick the product when
creating your Daraja app, calls to it return this instead of a useful message.
Ratiba in particular must be selected explicitly.

**Not through Go Live.** Sandbox credentials will not work against
`api.safaricom.co.ke` no matter how correct they are.

## STK push accepted but nothing happens on the phone

The push was accepted by Daraja, not delivered to a handset.

Check the number is on Safaricom and M-Pesa registered. Check the shortcode
type matches `transactionType`: a PayBill shortcode with
`CustomerBuyGoodsOnline` is accepted and then silently fails.

In sandbox, use `254708374149`. Other numbers behave unpredictably.

## STK push works but the callback never arrives

Almost always reachability.

**Localhost.** Safaricom cannot reach `127.0.0.1`. You need a public HTTPS URL
in `DARAJA_CALLBACK_PUBLIC_URL`.

**Tunnel expired.** Free ngrok URLs change on restart. Confirm the current URL
matches the config with `server_health`.

**Blocked by source verification.** Check `server_health` for a non-zero
`rejectedIp`. If your proxy strips `X-Forwarded-For`, the server sees the
proxy's address rather than Safaricom's. For sandbox only, set
`DARAJA_CALLBACK_ALLOW_ANY_IP=1`. Never in production.

**Path secret mismatch.** If you set `DARAJA_CALLBACK_PATH_SECRET` after
registering C2B URLs, the registered URLs no longer match. Re-register.

## "The initiator information is invalid" (2001)

The initiator credentials, not the OAuth ones. Three separate things go wrong:

The **initiator name** is the API operator username from the portal, not your
account email. The **security credential** is the initiator password encrypted
with Safaricom's certificate, and the sandbox and production certificates
differ. And the credential expires when Safaricom rotates the certificate,
which happens without announcement.

Regenerate with `encryptSecurityCredential`. See
[going-live.md](going-live.md).

## Timestamp or password errors on STK push

The timestamp must be East Africa Time, not UTC. A UTC timestamp is three hours
behind and Daraja rejects the request as expired.

This server handles it, but if you are comparing against your own code, that is
usually the difference.

The `Password` field is `base64(shortcode + passkey + timestamp)` and the
timestamp inside it must be byte-identical to the one in the `Timestamp` field.
Deriving them separately fails intermittently when a request straddles a second
boundary.

## "Insufficient funds" in sandbox

Sandbox shortcodes are shared and the B2C float gets drained by other people
testing. Try a smaller amount, or wait.

Note that amount `1` triggers the insufficient-funds scenario deliberately in
simulator mode.

## Ratiba rejects a standing order

**Duplicate name.** Names must be unique per customer. This is the most common
rejection.

**Not enabled.** Ratiba is commercial. Without a signed agreement it is not
available on your shortcode in production, and the app must have the product
selected in sandbox.

**Date format.** `yyyymmdd`. This server also accepts `yyyy-mm-dd` and
converts. End date must not precede start date.

## Payments succeed but my system does not know

Usually the two code spaces.

A synchronous `ResponseCode` of `0` means the request was accepted for
processing. It does not mean money moved. The callback's `ResultCode` of `0`
means it did. Treating the first as payment confirmation marks unpaid orders as
paid.

Ratiba compounds this: `200` for sync success, `0` for callback success,
different envelope casing between the two.

Use the `*_and_wait` tools, which return the settled outcome, or reconcile
against `list_callbacks`.

## The server will not start

**Port in use.** Change `DARAJA_CALLBACK_PORT`, default `8787`.

**Sockets forbidden.** Some sandboxed hosts do not allow listening. Set
`DARAJA_DISABLE_RECEIVER=1`. You lose the `*_and_wait` tools and must supply
your own callback URLs.

**Refuses to start in production.** By design, if
`DARAJA_CALLBACK_ALLOW_ANY_IP` is set. Unset it.

## Still stuck

Run with the callback receiver's health endpoint open:

```bash
curl http://localhost:8787/health
```

That reports counts of received, rejected, and malformed callbacks, which
usually says whether the problem is reachability or verification.

Then open an issue with the output of `server_health` and the mode you are in.
Do not paste credentials, receipt numbers, or customer phone numbers.
