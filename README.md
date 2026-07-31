# daraja-mcp

[![npm](https://img.shields.io/npm/v/daraja-mcp?color=cb3837&logo=npm)](https://www.npmjs.com/package/daraja-mcp)
[![downloads](https://img.shields.io/npm/dm/daraja-mcp?color=cb3837)](https://www.npmjs.com/package/daraja-mcp)
[![coverage](https://parseen254.github.io/daraja-mcp/coverage.svg)](#development)
[![tests](https://img.shields.io/badge/tests-368%20passing-4c1)](#development)
[![node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

An MCP server for the Safaricom M-Pesa Daraja 3.0 API.

Covers the full product surface including M-Pesa Ratiba, verifies the source of
inbound callbacks, and ships a simulator so you can run every tool without a
Safaricom account.

```bash
npx daraja-mcp
```

That works on a machine that has never heard of Safaricom. No credentials, no
sandbox app, no tunnel. It starts a local fake Daraja and points the server at
it, so you can call `stk_push_and_wait` and watch a payment settle end to end
before you decide whether this is worth your time.

## Why another one

There are several M-Pesa MCP servers already. Most wrap `POST /stkpush` and
stop. The three things that make Daraja genuinely hard to work with are:

**The result does not come back in the response.** You initiate a payment, get
an acknowledgement, and the actual outcome arrives on a webhook up to a minute
later. A tool that returns the acknowledgement has told the model nothing. So
this server runs a callback receiver and offers `*_and_wait` tools that block
until the real outcome arrives and return the receipt number.

**Callbacks are unsigned.** Safaricom does not sign callback bodies. The only
thing distinguishing a genuine payment result from a forged one is the source
address, which means an open callback endpoint lets anyone mark an unpaid order
as paid. This server verifies inbound callbacks against Safaricom's published
egress ranges, supports an unguessable path secret, and refuses to disable
verification in production.

**You cannot test any of it without an account.** Daraja requires credentials
and a publicly reachable HTTPS callback URL before the first request works. The
bundled simulator speaks the real endpoint paths, returns the real payload
shapes, and pushes callbacks the way Safaricom does, so the test suite runs in
CI with no secrets and you can evaluate the server in under a minute.

## Install

Add to your MCP client config:

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

That runs in simulator mode. To talk to the real sandbox, add credentials:

```json
{
  "mcpServers": {
    "daraja": {
      "command": "npx",
      "args": ["-y", "daraja-mcp"],
      "env": {
        "DARAJA_CONSUMER_KEY": "your-key",
        "DARAJA_CONSUMER_SECRET": "your-secret",
        "DARAJA_SHORTCODE": "174379",
        "DARAJA_PASSKEY": "your-passkey",
        "DARAJA_CALLBACK_PUBLIC_URL": "https://your-tunnel.ngrok.io"
      }
    }
  }
}
```

Client-specific instructions: [docs/clients.md](docs/clients.md).

## Tools

**Payments**

| Tool | What it does |
|---|---|
| `stk_push` | Send a payment prompt. Returns an acknowledgement only. |
| `stk_push_and_wait` | Send a prompt and wait for the customer. Returns the receipt. |
| `stk_query` | Check the status of a previous prompt. |
| `ratiba_create` | Create a standing order for recurring collection. |
| `ratiba_create_and_wait` | Create one and wait for the customer to approve. |
| `generate_qr` | Generate a dynamic QR code. |

**Disbursement**

| Tool | What it does |
|---|---|
| `b2c_payment` | Pay a customer: refunds, withdrawals, salaries. |
| `b2c_payment_and_wait` | Same, but returns the settled result. |
| `b2b_payment` | Pay a PayBill, a till, or top up a B2C working account. |
| `tax_remittance` | Remit tax to KRA against a PRN. |
| `business_to_pochi` | Pay a Pochi la Biashara number. |

**Treasury**

| Tool | What it does |
|---|---|
| `account_balance` | Query your business account balance. |
| `transaction_status` | Look up any past transaction. |
| `reversal` | Reverse a transaction paid into your shortcode. |

**Customer to business**

| Tool | What it does |
|---|---|
| `c2b_register_urls` | Register validation and confirmation URLs. |
| `c2b_simulate` | Simulate a customer payment. Sandbox only. |
| `pull_register` | Register for the Pull Transactions API. |
| `pull_transactions` | Fetch C2B transactions for a window. |

**Identity and fraud** (new in Daraja 3.0)

| Tool | What it does |
|---|---|
| `check_sim_swap` | When was this number last SIM-swapped? |
| `check_age_on_network` | When was this number first registered? |
| `validate_identity` | Is this number registered to this national ID? |
| `query_org_info` | What business owns this shortcode, and at what tariff? |

Those four are worth more than they look. Checking for a recent SIM swap before
disbursing to an unfamiliar number is a cheap control against SIM-swap fraud,
and `query_org_info` catches a fat-fingered shortcode before the money leaves.

**Diagnostics**

| Tool | What it does |
|---|---|
| `list_callbacks` | Recent callbacks, newest first. |
| `get_callback` | Full payload for a correlation id. |
| `server_health` | Mode, configured credentials, receiver status. |

Start with `server_health` when something is not working.

## Testing without a Safaricom account

Simulator mode is the default when no credentials are set. Failure paths are
driven by the amount, so you can exercise every branch deterministically:

| Amount | What happens |
|---|---|
| anything normal | Success, with a receipt number |
| `1` | Insufficient funds |
| `1032` | Cancelled by user |
| `1037` | Timeout, customer unreachable |
| `2001` | Wrong PIN |
| `9999` | Upstream 500, to exercise retry handling |

So `stk_push_and_wait` with amount `1032` gives you a realistic cancelled
payment, including the detail that failure callbacks carry no
`CallbackMetadata` at all. Code that reads the receipt number unconditionally
breaks there, which is exactly what you want to find locally.

## Going live

Read [docs/going-live.md](docs/going-live.md) before pointing this at
production. The short version:

1. Set `DARAJA_MODE=production` and real credentials.
2. Set `DARAJA_CALLBACK_PUBLIC_URL` to a public HTTPS endpoint.
3. Leave source verification on. It is on by default and the server refuses to
   let you disable it in production.
4. Set `DARAJA_CALLBACK_PATH_SECRET` to a random string.

Ratiba additionally requires a signed commercial agreement with Safaricom
before it works outside the sandbox.

## Configuration

| Variable | Purpose |
|---|---|
| `DARAJA_MODE` | `simulator`, `sandbox`, or `production` |
| `DARAJA_CONSUMER_KEY` | From your Daraja app |
| `DARAJA_CONSUMER_SECRET` | From your Daraja app |
| `DARAJA_SHORTCODE` | PayBill or till number |
| `DARAJA_PASSKEY` | Lipa na M-Pesa passkey, for STK push |
| `DARAJA_INITIATOR_NAME` | For B2C, B2B, reversals, balance |
| `DARAJA_SECURITY_CREDENTIAL` | Encrypted initiator password |
| `DARAJA_CALLBACK_PUBLIC_URL` | Public URL Safaricom can reach |
| `DARAJA_CALLBACK_PORT` | Local listener port, default `8787` |
| `DARAJA_CALLBACK_PATH_SECRET` | Unguessable path segment |
| `DARAJA_CALLBACK_CIDRS` | Override allowed source ranges |
| `DARAJA_DISABLE_RECEIVER` | Skip the callback listener entirely |

## Notes on Daraja's own inconsistencies

These are reproduced deliberately rather than tidied up, because Daraja rejects
the corrected forms:

- B2C sends `InitiatorName`; B2B and the treasury APIs send `Initiator`.
- `RecieverIdentifierType` is misspelled in the specification.
- B2C expects `Occassion`; transaction status expects `Occasion`.
- Ratiba's published sample says `StandingOrderNameName` while its parameter
  table says `StandingOrderName`. Both are sent.
- Ratiba's synchronous response uses `ResponseHeader` and code `200`; its
  callback uses `responseHeader` and code `0`. Different casing, different code
  space, same product.
- STK `ResultCode` is numeric; most other products send it as a string.

The timestamp is rendered in East Africa Time rather than UTC. Using UTC
backdates the request by three hours and Daraja rejects it as expired, which is
the single most common STK push bug.

## Using the pieces directly

The client, simulator, and callback receiver are exported independently if you
want them without MCP:

```ts
import { DarajaClient, DarajaSimulator, loadConfig } from 'daraja-mcp';
```

## Development

```bash
npm install
npm test              # 368 tests, no credentials needed
npm run test:coverage # with a coverage report
npm run build
npm run verify        # typecheck, test, build, and an end-to-end MCP check
```

`npm run verify` is the full gate. It drives the built CLI over stdio MCP
through a payment, a cancellation, and a standing order against the simulator,
so it needs no Safaricom credentials.

Coverage sits at about 98% of lines, with thresholds enforced by the test run
so a regression fails rather than passing quietly. The badge is generated
locally with `npm run coverage:badge`, since this repository does not run CI.

The docs site is served from the `gh-pages` branch. To update it, edit
`site/index.html` on `main` and run `npm run docs:publish`.

## Disclaimer

Not affiliated with or endorsed by Safaricom PLC. M-PESA and Daraja are their
trademarks. Built from the public Daraja documentation.

## License

MIT
