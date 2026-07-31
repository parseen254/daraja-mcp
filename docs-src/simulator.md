---
title: The simulator
description: A local fake Daraja with deterministic failure scenarios, so you can test without a Safaricom account.
---

# The simulator

With no credentials set, `npx daraja-mcp` starts a local fake Daraja and points
the client at it. Every tool works. No Safaricom account, no sandbox app, no
public callback URL.

This exists because Daraja normally cannot be tried at all until you have
registered, created an app, selected products, and exposed an HTTPS endpoint to
the internet. That is a lot of setup to answer "is this library any good".

## What it actually does

It is not a stub that returns `{ ok: true }`. It speaks the real endpoint
paths, returns the documented payload shapes, and pushes callbacks the way
Safaricom does, with the same delay between the acknowledgement and the result.

It also preserves Daraja's inconsistencies rather than tidying them up. Ratiba
still changes its envelope casing between response and callback. Dynamic QR
still returns `"00"` rather than `"0"`. Failed STK callbacks still omit
`CallbackMetadata` entirely. Code written against a clean mock passes its tests
and then fails against the real thing.

## Failure scenarios are keyed off the amount

Every branch is reachable deterministically. Ask for a particular amount and
you get a particular outcome:

| Amount | Outcome |
|---|---|
| Anything else | Success, with a receipt number |
| `1` | Insufficient funds |
| `1032` | Cancelled by user |
| `1037` | Timeout, customer unreachable |
| `2001` | Wrong PIN |
| `9999` | Upstream 500, to exercise retry handling |

Try it. Ask your agent:

> Send an M-Pesa request for 1032 shillings to 0712345678 and wait for the
> result.

You get a failure with `ResultCode 1032` and `metadata: null`. That null is the
point: real Daraja omits the metadata block on failed payments, so code that
reads the receipt number unconditionally crashes on the first declined payment.
Better to meet that here.

## Testing your own integration

The simulator is exported, so your test suite can use it directly without going
through MCP:

```ts
import { DarajaSimulator, DarajaClient, loadConfig } from 'daraja-mcp';

const sim = new DarajaSimulator({ callbackDelayMs: 5 });
const baseUrl = await sim.start();

const client = new DarajaClient(
  loadConfig({
    DARAJA_MODE: 'sandbox',
    DARAJA_CONSUMER_KEY: 'test',
    DARAJA_CONSUMER_SECRET: 'test',
    DARAJA_BASE_URL: baseUrl,
  }),
);

// ... exercise your code against it ...

await sim.stop();
```

`callbackDelayMs` controls how long the simulator waits before delivering a
result. Set it low in tests. `sim.flushCallbacks()` fires every queued callback
immediately, which removes timing flakiness entirely.

This is how this project's own 538 tests run, which is why they need no
credentials and no network.

## What it does not do

It does not validate credentials beyond checking that a bearer token is
present, does not enforce Daraja's rate limits, and does not model the
commercial rules around Ratiba or the shortcode provisioning process.

It also cannot tell you whether your production shortcode is configured
correctly. For that you need [the real sandbox](/daraja-mcp/sandbox/), which is
the sensible next step once the shape of your integration is settled.

## Moving off it

Set credentials and the server switches to sandbox automatically:

```bash
export DARAJA_CONSUMER_KEY=your-key
export DARAJA_CONSUMER_SECRET=your-secret
```

`server_health` reports which mode you are in. Every tool response says so too,
in the leading line and in an `environment` field, so there is never a question
of whether a payment was real.
