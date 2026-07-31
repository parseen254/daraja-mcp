---
title: Callbacks and waiting
description: Why a payment result arrives later, how the *_and_wait tools handle it, and what happens when it never comes.
---

# Callbacks and waiting

Daraja is asynchronous in a way that catches people out. This page explains the
model, then what this server does about it.

## The shape of the problem

You call `stk_push`. Daraja responds in a second or so:

```json
{
  "MerchantRequestID": "29115-34620561-1",
  "CheckoutRequestID": "ws_CO_191220191020363925",
  "ResponseCode": "0",
  "ResponseDescription": "Success. Request accepted for processing",
  "CustomerMessage": "Success. Request accepted for processing"
}
```

Nothing there says a payment happened. `ResponseCode: "0"` means Daraja
accepted the request. A prompt is now on the customer's phone and they have
about a minute to enter their PIN, decline, or ignore it. Whatever they do
arrives later as an HTTP POST to a URL you nominated.

For an agent this is awkward. The tool returned, the model saw success, and it
will happily tell the user the payment went through. It has no idea.

## What the waiting tools do

`stk_push_and_wait` sends the push, then blocks until the callback for that
`CheckoutRequestID` arrives, and returns the settled outcome:

```json
{
  "environment": "simulator",
  "status": "success",
  "checkoutRequestId": "ws_CO_895779657909821",
  "resultCode": "0",
  "resultDesc": "The service request is processed successfully.",
  "metadata": {
    "Amount": 100,
    "MpesaReceiptNumber": "XZAWA9JEBX",
    "TransactionDate": 20260731121937,
    "PhoneNumber": 254712345678
  }
}
```

`MpesaReceiptNumber` is proof. There is an equivalent for payouts
(`b2c_payment_and_wait`) and standing orders (`ratiba_create_and_wait`).

## When the customer declines

```json
{
  "environment": "simulator",
  "status": "failure",
  "checkoutRequestId": "ws_CO_...",
  "resultCode": "1032",
  "resultDesc": "Request cancelled by user",
  "metadata": null
}
```

`metadata` is `null` because Daraja omits `CallbackMetadata` entirely on
failure. A cancellation is a normal outcome, not a fault: the customer looked
at the prompt and said no.

## When nothing arrives

```json
{
  "environment": "sandbox",
  "status": "pending",
  "checkoutRequestId": "ws_CO_...",
  "message": "No callback arrived before the timeout. The payment may still complete. Query it with stk_query or check get_callback using this CheckoutRequestID."
}
```

> **Warning** `pending` is not `failure`. The payment may well have succeeded
> and the callback got lost. Never resend on a timeout without checking:
> `transaction_status` tells you what actually happened. Resending an STK push
> to a customer who already paid is how you double-charge someone.

## Waits are bound to the amount

A callback's correlation id comes out of its own body, so quoting the right id
only proves the sender knew it. Each wait is therefore bound to the amount that
was requested.

If you asked for KES 100 and a callback claims KES 999,999 against the same id,
the wait stays open and the mismatch is counted. The callback is still stored,
because hiding it would hide the discrepancy from whoever investigates later.

Callbacks that report no amount, which is normal on failure, still settle the
wait. You need to hear that a payment failed.

## Running the receiver

The server starts a callback receiver on port `8787` by default and generates
callback URLs pointing at it. In simulator mode this all happens on loopback
and needs no setup.

Against real Daraja, Safaricom must be able to reach you over public HTTPS:

```bash
ngrok http 8787
export DARAJA_CALLBACK_PUBLIC_URL=https://your-tunnel.ngrok.io
```

Behind a tunnel or load balancer, also set `DARAJA_TRUST_PROXY=1` so the
receiver reads the forwarded address rather than the proxy's. Do not set it if
you are exposed directly: see the [security model](/daraja-mcp/security/) for
why.

If your host forbids listening sockets, `DARAJA_DISABLE_RECEIVER=1` turns it
off. You lose the `*_and_wait` tools and must supply your own callback URLs.

## Callbacks are stored

Every callback is appended to a JSON Lines file under
`DARAJA_CALLBACK_STORE_DIR`, reloaded on restart. A crash does not lose the
record of a payment that already settled. Back that directory up alongside your
database.

Two tools read it. `list_callbacks` gives a summary, newest first.
`get_callback` returns the full payload for one correlation id.

> **Note** Text inside a callback is partly written by the paying customer.
> Both tools sanitise it and label it as customer-supplied. Read the
> [security model](/daraja-mcp/security/) before feeding callback contents back
> into anything that can act.

## Reconciling after an outage

Callbacks get lost: tunnels drop, processes restart mid-delivery, retry budgets
run out. Two tools help.

`transaction_status` looks up a single transaction by receipt number, or by
conversation id when the original request timed out before returning one.

`pull_transactions` fetches C2B transactions for a time window, which is how
you backfill what you missed. It needs `pull_register` run once for the
shortcode first.
