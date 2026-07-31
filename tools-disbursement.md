# Disbursement and treasury

Moving money out, and the treasury operations around it. Nothing here asks a human to approve anything, which is why most of it is disabled in production until you opt in.

## b2c_payment

`money` `gated in production`

Pay money out to a customer: refunds, withdrawals, salaries, promotional winnings. Asynchronous; the result arrives on a callback.

| Parameter | Type | Notes |
|---|---|---|
| `phoneNumber` **required** | `string` | Recipient phone number. |
| `amount` **required** | `number` | Amount in KES, whole numbers only. |
| `commandId` | `"BusinessPayment" \| "SalaryPayment" \| "PromotionPayment"` | BusinessPayment for general payouts, SalaryPayment for salaries (allows unregistered recipients), PromotionPayment for winnings. Defaults to `"BusinessPayment"`. |
| `remarks` | `string` |  Defaults to `"Payment"`. |
| `occasion` | `string` |  |
| `shortCode` | `string` |  |
| `resultUrl` | `string` |  |

> **Warning** This tool moves money outward and is disabled in production unless `DARAJA_ALLOW_PAYOUTS=true` is set. Nobody approves anything on a phone for this one, so whatever calls it needs its own authorisation step.

## b2c_payment_and_wait

`money` `waits for callback` `gated in production`

Pay money out to a customer and wait for the result callback, returning the receipt number on success.

| Parameter | Type | Notes |
|---|---|---|
| `phoneNumber` **required** | `string` | Recipient phone number. |
| `amount` **required** | `number` | Amount in KES, whole numbers only. |
| `commandId` | `"BusinessPayment" \| "SalaryPayment" \| "PromotionPayment"` | BusinessPayment for general payouts, SalaryPayment for salaries (allows unregistered recipients), PromotionPayment for winnings. Defaults to `"BusinessPayment"`. |
| `remarks` | `string` |  Defaults to `"Payment"`. |
| `occasion` | `string` |  |
| `shortCode` | `string` |  |
| `resultUrl` | `string` |  |
| `timeoutSeconds` | `number` |  Defaults to `120`. |

> **Warning** This tool moves money outward and is disabled in production unless `DARAJA_ALLOW_PAYOUTS=true` is set. Nobody approves anything on a phone for this one, so whatever calls it needs its own authorisation step.

## b2b_payment

`money` `gated in production`

Pay another business: a PayBill, a Buy Goods till, or a B2C working account top-up.

| Parameter | Type | Notes |
|---|---|---|
| `target` **required** | `"paybill" \| "buygoods" \| "topup"` | paybill pays a PayBill, buygoods pays a till, topup funds a B2C working account. |
| `receiverShortCode` **required** | `string` | Shortcode being paid. |
| `amount` **required** | `number` | Amount in KES, whole numbers only. |
| `accountReference` | `string` | Required for paybill. Ignored for buy goods. |
| `requester` | `string` | Optional phone number of the person on whose behalf you are paying. |
| `remarks` | `string` |  Defaults to `"Payment"`. |
| `shortCode` | `string` |  |
| `resultUrl` | `string` |  |

> **Warning** This tool moves money outward and is disabled in production unless `DARAJA_ALLOW_PAYOUTS=true` is set. Nobody approves anything on a phone for this one, so whatever calls it needs its own authorisation step.

## tax_remittance

`money` `gated in production`

Remit tax to the Kenya Revenue Authority using a Payment Registration Number.

| Parameter | Type | Notes |
|---|---|---|
| `amount` **required** | `number` | Amount in KES, whole numbers only. |
| `paymentRegistrationNumber` **required** | `string` | KRA Payment Registration Number (PRN) for the tax being paid. |
| `remarks` | `string` |  Defaults to `"Tax payment"`. |
| `shortCode` | `string` |  |
| `resultUrl` | `string` |  |

> **Warning** This tool moves money outward and is disabled in production unless `DARAJA_ALLOW_PAYOUTS=true` is set. Nobody approves anything on a phone for this one, so whatever calls it needs its own authorisation step.

## business_to_pochi

`money` `gated in production`

Pay a Pochi la Biashara number.

| Parameter | Type | Notes |
|---|---|---|
| `phoneNumber` **required** | `string` | Pochi la Biashara number receiving the payment. |
| `amount` **required** | `number` | Amount in KES, whole numbers only. |
| `remarks` | `string` |  Defaults to `"Payment"`. |
| `shortCode` | `string` |  |
| `resultUrl` | `string` |  |

> **Warning** This tool moves money outward and is disabled in production unless `DARAJA_ALLOW_PAYOUTS=true` is set. Nobody approves anything on a phone for this one, so whatever calls it needs its own authorisation step.

## account_balance

`control`

Query the balance of your M-Pesa business account. Asynchronous; the balance arrives on a callback as a pipe-delimited string per account type.

| Parameter | Type | Notes |
|---|---|---|
| `shortCode` | `string` |  |
| `remarks` | `string` |  Defaults to `"Balance query"`. |
| `resultUrl` | `string` |  |

## transaction_status

`control`

Check the status of any past transaction by receipt number, or by conversation id when the original request timed out. Use this before retrying a payment you are unsure about.

| Parameter | Type | Notes |
|---|---|---|
| `transactionId` | `string` | M-Pesa receipt number, for example NEF61H8J60. |
| `originalConversationId` | `string` | Use when you never received a receipt number. |
| `shortCode` | `string` |  |
| `remarks` | `string` |  Defaults to `"Status query"`. |
| `resultUrl` | `string` |  |

## reversal

`money` `gated in production`

Reverse a transaction that was paid into your shortcode.

| Parameter | Type | Notes |
|---|---|---|
| `transactionId` **required** | `string` | M-Pesa receipt number of the transaction to reverse. |
| `amount` **required** | `number` | Amount in KES, whole numbers only. |
| `receiverShortCode` | `string` | Shortcode that received the money. |
| `remarks` | `string` |  Defaults to `"Reversal"`. |
| `resultUrl` | `string` |  |

> **Warning** This tool moves money outward and is disabled in production unless `DARAJA_ALLOW_PAYOUTS=true` is set. Nobody approves anything on a phone for this one, so whatever calls it needs its own authorisation step.

