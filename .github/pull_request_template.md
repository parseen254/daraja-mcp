## What this changes

<!-- What the change does, and why it is needed. If it fixes something subtle,
say what would have gone wrong without it. -->

## Verification

<!-- Delete what does not apply. Please actually run these rather than assuming. -->

- [ ] `npm run verify` passes (typecheck, tests, build, end-to-end MCP check)
- [ ] New behaviour has tests that assert the wire format, not only that the
      call succeeded
- [ ] Tested against the real Daraja sandbox <!-- optional, say so if you did -->

## If this touches a Daraja request

- [ ] Field names match the published documentation exactly, including any
      misspellings Daraja requires
- [ ] Linked the documentation page for anything non-obvious
- [ ] Money-moving calls are not marked `retryable`

## If this touches callbacks

- [ ] Source verification still cannot be disabled in production
- [ ] No path added that stores a callback before it has been verified

## Provenance

- [ ] Everything here derives from Safaricom's public Daraja documentation, not
      from an employer's or client's private integration

## Anything else

<!-- Trade-offs, things you were unsure about, follow-up work you deliberately
left out. -->
