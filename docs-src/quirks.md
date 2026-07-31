---
title: Daraja's inconsistencies
description: Field names, casing and code spaces that differ between Daraja products, reproduced deliberately.
---

# Daraja's inconsistencies

Daraja is not consistent with itself. The same concept has different field
names in different products, one field name is misspelled in the specification
and the corrected spelling is rejected, and one product changes both its
envelope casing and its success code between the response and the callback.

This server reproduces all of it. The list below is useful whether or not you
use this server: if you are writing your own integration, these are the things
that will cost you an afternoon.

## The initiator has two names

B2C sends `InitiatorName`. B2B, transaction status, account balance and
reversal all send `Initiator`. Same concept, same credential, different key.

```json
{ "InitiatorName": "apiuser" }   // B2C only
{ "Initiator": "apiuser" }       // everything else
```

## RecieverIdentifierType is misspelled

The published specification spells it `RecieverIdentifierType`, with the `i`
and `e` transposed. This is not a typo in the docs: the API rejects the
correctly spelled `ReceiverIdentifierType`.

The value also changes by product. `4` identifies an organisation shortcode in
most places, `2` a Buy Goods till, and reversal wants `11` for the receiving
party.

## Occasion has two spellings

B2C expects `Occassion`, with a double s. Transaction status expects
`Occasion`, with one. Both are optional, which means sending the wrong one
fails quietly rather than loudly.

## Ratiba disagrees with itself

The published sample body names the field `StandingOrderNameName`, doubled,
while the parameter table directly beneath it says `StandingOrderName`. The
same page spells the tracking id `CustomStoId` in the sample and `CustomstdoId`
in the table.

This server sends both spellings of both fields. Daraja ignores the one it does
not recognise, and the request survives whichever spelling they eventually fix.

Ratiba also changes shape between its two messages:

| | Synchronous response | Callback |
|---|---|---|
| Envelope | `ResponseHeader` / `ResponseBody` | `responseHeader` / `responseBody` |
| Success code | `"200"` | `"0"` |

Different casing and a different code space, from one product, on one page of
documentation.

## Success codes are not one value

Most products treat `ResponseCode: "0"` as success. Dynamic QR returns `"00"`.
Pull Transactions returns `"1000"`. A client that only accepts `"0"` raises an
error on a perfectly successful QR generation.

Daraja also returns HTTP 200 with an error envelope, and occasionally an HTML
gateway page with a 200 status. Neither is success.

## ResultCode is sometimes a number

STK push callbacks send `ResultCode` as a JSON number. Most other products send
it as a string. If you compare with `===` against `"0"` you will silently treat
successful STK payments as failures.

## The two code spaces

This is the one that causes real financial errors.

A synchronous `ResponseCode` of `0` means *accepted for processing*. It does
not mean money moved. The callback's `ResultCode` of `0` means it did.

Treating the first as confirmation marks unpaid orders as paid. It is an easy
mistake because both fields are called something-Code and both use 0 for
success. See [callbacks and waiting](/daraja-mcp/callbacks/) for how the
`*_and_wait` tools avoid it.

## Failure callbacks carry no metadata

A successful STK callback includes `CallbackMetadata` holding the receipt
number, amount, and phone number. A failed one omits the field entirely.

```json
// Success
{
  "Body": {
    "stkCallback": {
      "ResultCode": 0,
      "CallbackMetadata": { "Item": [ ... ] }
    }
  }
}

// Failure: no CallbackMetadata at all
{
  "Body": {
    "stkCallback": {
      "ResultCode": 1032,
      "ResultDesc": "Request cancelled by user"
    }
  }
}
```

Code that reaches for the receipt number without checking crashes on the first
declined payment. The simulator reproduces this, so you find it locally rather
than at 2am.

## Timestamps must be East Africa Time

The `Timestamp` field on an STK push must be Nairobi local time, `UTC+3`, in
`YYYYMMDDHHmmss`. Using UTC backdates the request by three hours and Daraja
rejects it as expired.

The `Password` field is `base64(shortcode + passkey + timestamp)`, and the
timestamp inside it must be byte-identical to the one in the `Timestamp` field.
Deriving them in two separate calls fails intermittently when a request happens
to straddle a second boundary, which is a memorable way to spend a day.

## One more typo, for completeness

The C2B register-URL response returns `OriginatorCoversationID`, missing the
`n` in Conversation. Not harmful, but worth knowing before you spend ten
minutes wondering why your destructuring returns undefined.

## Why reproduce them

Because the API rejects the corrected forms. A client that tidies these up
looks better and does not work.

The [simulator](/daraja-mcp/simulator/) preserves the quirks too. A mock that
returns clean, consistent payloads lets you write code that passes its tests
and fails against the real thing.
