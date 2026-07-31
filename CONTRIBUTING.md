# Contributing

Thanks for looking. This project wraps a payments API, so a bug here can move
real money in the wrong direction. That shapes most of what follows.

## Getting set up

```bash
git clone https://github.com/parseen254/daraja-mcp.git
cd daraja-mcp
npm install
npm test
```

The tests pass without a Safaricom account. That is deliberate: the bundled
simulator speaks the real endpoint paths and returns the real payload shapes,
so you can work on almost anything here without credentials.

Before opening a pull request:

```bash
npm run verify
```

That runs typecheck, the full test suite, a build, and an end-to-end check that
drives the built CLI over stdio MCP through a payment, a cancellation, and a
standing order.

## The rule that matters most

**Everything in this repository comes from Safaricom's public Daraja
documentation.**

Do not contribute code, payloads, error tables, or reconciliation logic derived
from an employer's private integration, a client project, or an NDA-covered
system. If you know something about Daraja's behaviour because you saw it in
production at work, and it is not in the public docs, it does not belong here.

Describing a failure class in general terms is fine. Reproducing a specific
company's implementation is not.

## What makes a good contribution

**Fidelity over tidiness.** Daraja is inconsistent, and this codebase
reproduces those inconsistencies on purpose. B2C sends `InitiatorName` while
B2B sends `Initiator`. `RecieverIdentifierType` is misspelled. Ratiba changes
its envelope casing between the synchronous response and the callback. Do not
"fix" these. The corrected spellings are rejected by the API. If you find one
that is genuinely wrong, cite the documentation page in your pull request.

**Tests that assert the wire format.** For anything touching a Daraja request,
assert the exact field names and values that go out, not just that the call
succeeded. The tests in `src/tools/*.test.ts` show the pattern: build a
harness, make the call, inspect the captured body.

**Never retry a payment blindly.** The HTTP client has an opt-in `retryable`
flag for exactly this reason. Queries can retry. Anything that moves money
cannot. If you are unsure which side something falls on, it cannot.

**Callback security is not negotiable.** Source verification is on by default
and the server refuses to start in production without it. If a change makes it
easier to accidentally accept an unverified callback, it will not be merged.

## Adding a Daraja product

Roughly the shape:

1. Add the request builder in the right file under `src/tools/`. Group by what
   the product does, not by which endpoint it happens to share, since several
   products share `/mpesa/b2b/v1/paymentrequest` and differ only by
   `CommandID`.
2. Add a handler to the simulator in `src/simulator/server.ts` and fixtures in
   `src/simulator/fixtures.ts`. Copy the real response shape from the docs
   including anything odd about it.
3. Register the tool in `src/server.ts` with a description written for a model,
   not a human. Say what the tool does *and* what it does not confirm.
4. Write tests asserting the wire format.
5. Update the tool table in `README.md` and `site/index.html`.

## Style

Match the surrounding code. Beyond that:

- Comments explain *why*, and are worth writing when the reason is
  non-obvious. `// Daraja rejects the correct spelling` earns its place.
  `// loop over items` does not.
- Prose in docs and comments uses plain punctuation. No em dashes.
- Commit messages explain the reasoning, not just the change. If a commit fixes
  something subtle, the body should say what would have gone wrong.

## Reporting a bug

Include the mode you were in (`simulator`, `sandbox`, `production`), the tool
you called, and what came back. `server_health` output is usually the fastest
way to show your configuration.

**Never paste credentials, real receipt numbers, or customer phone numbers into
an issue.** If you need to show a real payload, replace the MSISDN with
`254708374149` and the receipt with `NLJ7RT61SV`.

## Security

If you find a vulnerability, particularly anything letting a forged callback
be accepted, do not open a public issue. See [SECURITY.md](SECURITY.md).

## Licence

Contributions are licensed under MIT, matching the project.
