---
title: Quickstart
description: From nothing to a settled M-Pesa payment in about a minute, with no Safaricom account.
---

# Quickstart

No Safaricom account. No sandbox app. No tunnel. This runbook gets you from
nothing to a settled payment with a receipt number.

## What you need

Node 20 or newer. That is the whole list.

```bash
node --version
```

## 1. Start the server (10 seconds)

```bash
npx -y daraja-mcp
```

You should see:

```
[daraja-mcp] Simulator mode. No Safaricom credentials required.
[daraja-mcp] Mode: simulator
[daraja-mcp] Callback receiver listening on port 8787
[daraja-mcp] Ready.
```

The server is now speaking MCP on stdin and stdout. It started a local fake
Daraja and a callback receiver, so the full asynchronous cycle works offline.

Leave it running, or press Ctrl-C and wire it into a client instead.

## 2. Wire it into your client (30 seconds)

**Claude Code**

```bash
claude mcp add daraja -- npx -y daraja-mcp
```

**Claude Desktop**

Edit `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "daraja": {
      "command": "npx",
      "args": ["-y", "daraja-mcp"]
    }
  }
}
```

macOS puts that file at
`~/Library/Application Support/Claude/claude_desktop_config.json`.
Restart the app afterwards.

Other clients: [Install per client](/daraja-mcp/clients/).

## 3. Take a payment (20 seconds)

Ask your assistant:

> Send an M-Pesa payment request for 100 shillings to 0712345678 and tell me
> whether it went through.

It should call `stk_push_and_wait` and come back with something like:

```json
{
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

That is a complete payment cycle: prompt sent, customer accepted, callback
received, receipt returned. On real Daraja the same call does the same thing,
except a phone rings.

## 4. Try the failure paths

This is the part you cannot do on real Daraja without a lot of setup and a
cooperative human. The simulator keys scenarios off the amount:

| Ask for | You get |
|---|---|
| 100 shillings | Success with a receipt |
| 1 shilling | Insufficient funds |
| 1032 shillings | Cancelled by user |
| 1037 shillings | Timeout, customer unreachable |
| 2001 shillings | Wrong PIN |
| 9999 shillings | Upstream server error |

Try:

> Send an M-Pesa request for 1032 shillings to 0712345678.

You get a failure with `ResultCode 1032` and no receipt. Note the response has
no `metadata` at all: real Daraja omits `CallbackMetadata` entirely on failed
payments, and code that reaches for the receipt number without checking is a
common production crash. Better to meet it here.

## 5. Try a standing order

Ratiba is the recurring-payment product: subscriptions, loan repayments,
insurance premiums, SACCO contributions.

> Set up a monthly M-Pesa standing order of 2000 shillings from 0712345678 for
> a gym membership, starting 1 August 2026 and ending 1 August 2027.

```json
{
  "status": "success",
  "details": {
    "standingOrderName": "Gym membership",
    "amount": "2000.00",
    "reminderScheduleId": "3813734",
    "firstPaymentReminderDate": "20260807",
    "status": "ACTIVE",
    "Msisdn": "*********678"
  }
}
```

The masked MSISDN is not a bug: Safaricom masks it in Ratiba callbacks.

Standing order names must be unique per customer. Ask for the same name twice
and the second attempt is rejected, same as on real Daraja.

## What next

- Point it at the real sandbox: [The real sandbox](/daraja-mcp/sandbox/)
- Go to production: [Going live](/daraja-mcp/going-live/)
- Something not working: [Troubleshooting](/daraja-mcp/troubleshooting/)
