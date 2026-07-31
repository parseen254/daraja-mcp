# daraja-mcp

An MCP server for the Safaricom M-Pesa Daraja 3.0 API. All 26 products
including M-Pesa Ratiba, callbacks verified at the source, and a simulator so
you can run every tool without a Safaricom account.

:::facts 25 tools | 26 Daraja products | 538 tests | 99% coverage | MIT

```bash
npx daraja-mcp
```

That works on a machine that has never heard of Safaricom. No credentials, no
sandbox app, no public callback URL. It starts a local fake Daraja and points
the server at it, so you can watch a payment settle end to end before deciding
whether any of this is worth your time.

:::links [Start in 60 seconds](/daraja-mcp/quickstart/) | [Browse the tools](/daraja-mcp/tools/) | [GitHub](https://github.com/parseen254/daraja-mcp)

## Why this exists

There are several M-Pesa MCP servers already. Most wrap the STK push endpoint
and stop. Three things make Daraja genuinely awkward, and they are the three
this handles.

**The result is not in the response.** You initiate a payment, get an
acknowledgement, and the actual outcome arrives on a webhook up to a minute
later. A tool that returns the acknowledgement has told the model nothing. The
`*_and_wait` tools block on the callback and return the receipt number.

**Callbacks are unsigned.** Safaricom does not sign callback bodies, so the
only thing distinguishing a genuine payment result from a forged one is where
it came from. An unprotected callback endpoint lets anyone mark an unpaid order
as paid. Inbound callbacks are checked against Safaricom's published ranges,
and verification cannot be turned off in production.

**You cannot normally test any of it.** Daraja wants credentials and a publicly
reachable HTTPS callback URL before the first request works. The bundled
simulator speaks the real endpoint paths, returns the real payload shapes, and
pushes callbacks the way Safaricom does.

## What a payment looks like

One tool call, start to settled, with no Safaricom account:

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

Every response states which environment it ran against, so neither you nor the
model has to guess whether real money moved.

## Where to go next

If you want it working now, the [quickstart](/daraja-mcp/quickstart/) gets you
from nothing to a receipt number in about a minute.

If you are evaluating whether this is serious, two pages will tell you faster
than the rest of the site: [Daraja's inconsistencies](/daraja-mcp/quirks/),
which documents the field-naming traps this reproduces deliberately, and the
[security model](/daraja-mcp/security/), which covers unsigned callbacks and
what customer-written text does when it reaches a model's context.

If you are going to production, read [going live](/daraja-mcp/going-live/)
first. It is a checklist, not an essay.

## For agents

Machine-readable versions of everything here:

- [`/llms.txt`](/daraja-mcp/llms.txt), a curated index with a summary of each page
- [`/llms-full.txt`](/daraja-mcp/llms-full.txt), every page concatenated into one file
- Every page has a `.md` twin at the same path, linked from its header
