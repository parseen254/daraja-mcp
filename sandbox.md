# The real sandbox

The simulator gets you the shape of the thing. Sandbox gets you Safaricom's
actual responses, including the ones nobody documents.

## 1. Create a Daraja account

Register at [developer.safaricom.co.ke](https://developer.safaricom.co.ke). An
individual account is enough for sandbox; production needs a company account.

## 2. Create an app

In the portal, create a new app and select the products you need. This matters:
a product you did not tick returns "invalid access token" rather than anything
resembling "you do not have access to this product."

For Ratiba specifically you must select **M-Pesa Ratiba** when creating the app.

Copy the **Consumer Key** and **Consumer Secret**.

## 3. Get the test credentials

The portal's simulator section lists sandbox test values. You need:

- **Shortcode**: usually `174379` for STK push testing
- **Passkey**: the Lipa na M-Pesa Online passkey
- **Test MSISDN**: `254708374149`, which always succeeds
- **Initiator name** and **security credential**, for B2C and the treasury APIs

## 4. Expose a callback URL

This is the step that blocks everyone. Safaricom must be able to POST to you
over public HTTPS, and `localhost` is not reachable from Nairobi.

```bash
ngrok http 8787
```

or

```bash
cloudflared tunnel --url http://localhost:8787
```

Either prints a public HTTPS URL. That is your `DARAJA_CALLBACK_PUBLIC_URL`.

The URL changes every time you restart the tunnel unless you are on a paid
plan, so expect to update it.

## 5. Configure

```bash
export DARAJA_MODE=sandbox
export DARAJA_CONSUMER_KEY=your-key
export DARAJA_CONSUMER_SECRET=your-secret
export DARAJA_SHORTCODE=174379
export DARAJA_PASSKEY=your-passkey
export DARAJA_CALLBACK_PUBLIC_URL=https://your-tunnel.ngrok.io

npx daraja-mcp
```

Confirm it took:

> Run server_health

You want `"mode": "sandbox"` and a `publicBaseUrl` that is your tunnel, not
localhost.

## 6. Send a real sandbox payment

> Send an M-Pesa payment request for 1 shilling to 254708374149 and wait for
> the result.

The sandbox auto-approves the test number after a few seconds. You should get a
receipt number back.

If it hangs and times out, the callback is not reaching you. Check
[Troubleshooting](/daraja-mcp/troubleshooting/).

## Sandbox quirks worth knowing

**Source verification is on.** Callbacks now have to come from Safaricom's
published ranges. If you are tunnelling, the tunnel forwards the original
address in `X-Forwarded-For` and the server reads it, because it trusts proxies
by default. If your setup strips that header, set
`DARAJA_CALLBACK_ALLOW_ANY_IP=1` for sandbox only. The server refuses that flag
in production.

**Sandbox credentials are not production credentials.** Different consumer key,
different shortcode, different passkey, different security credential. Swapping
`DARAJA_MODE` alone gets you "invalid access token."

**The sandbox is not always up.** Intermittent 500s with
`errorCode 500.001.1001` are usually Safaricom, not you. The client retries
those automatically with backoff.

**Balances are shared.** Sandbox shortcodes are used by everyone, so the B2C
float can be drained by strangers. An unexpected "insufficient funds" is often
someone else's testing.
