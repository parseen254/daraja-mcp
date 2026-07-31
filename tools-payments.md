# Payments

Collecting money from a customer. These are the flows where the customer approves a prompt on their own phone, so a person is always in the loop.

## stk_push

`money`

Send an M-Pesa payment prompt (STK push) to a customer. Returns immediately with an acknowledgement; it does NOT confirm payment. Use stk_push_and_wait if you need the outcome.

| Parameter | Type | Notes |
|---|---|---|
| `phoneNumber` **required** | `string` | Customer phone number. Accepts 07..., +2547..., or 2547... and is normalised. |
| `amount` **required** | `number` | Amount in KES. Whole numbers only. |
| `accountReference` | `string` | Account identifier shown on the customer statement. Max 12 characters. |
| `transactionDesc` | `string` | Short description. Max 13 characters. |
| `shortCode` | `string` | Overrides DARAJA_SHORTCODE. |
| `callbackUrl` | `string` | Overrides the built-in receiver URL. |
| `transactionType` | `"CustomerPayBillOnline" \| "CustomerBuyGoodsOnline"` | PayBill or Buy Goods. Must match the shortcode type. Defaults to `"CustomerPayBillOnline"`. |

## stk_push_and_wait

`money` `waits for callback`

Send an M-Pesa payment prompt and wait for the customer to accept or decline. Returns the settled outcome including the receipt number on success. Use this when you need to know whether the payment actually completed.

| Parameter | Type | Notes |
|---|---|---|
| `phoneNumber` **required** | `string` | Customer phone number. Accepts 07..., +2547..., or 2547... and is normalised. |
| `amount` **required** | `number` | Amount in KES. Whole numbers only. |
| `accountReference` | `string` | Account identifier shown on the customer statement. Max 12 characters. |
| `transactionDesc` | `string` | Short description. Max 13 characters. |
| `shortCode` | `string` | Overrides DARAJA_SHORTCODE. |
| `callbackUrl` | `string` | Overrides the built-in receiver URL. |
| `transactionType` | `"CustomerPayBillOnline" \| "CustomerBuyGoodsOnline"` | PayBill or Buy Goods. Must match the shortcode type. Defaults to `"CustomerPayBillOnline"`. |
| `timeoutSeconds` | `number` | How long to wait for the customer. Prompts expire after about 60 seconds. Defaults to `90`. |

## stk_query

`control`

Query the status of a previous STK push using its CheckoutRequestID.

| Parameter | Type | Notes |
|---|---|---|
| `checkoutRequestId` **required** | `string` | The CheckoutRequestID returned by stk_push. |
| `shortCode` | `string` |  |

## ratiba_create

`money` `gated in production`

Create an M-Pesa Ratiba standing order for recurring collection: subscriptions, loan repayments, insurance premiums, SACCO contributions. The customer approves via an M-Pesa prompt. The standing order name must be unique per customer.

| Parameter | Type | Notes |
|---|---|---|
| `standingOrderName` **required** | `string` | Name of the standing order. Must be unique for this customer; a repeat name is rejected. |
| `phoneNumber` **required** | `string` | Customer phone number. Accepts 07..., +2547..., or 2547... and is normalised. |
| `amount` **required** | `number` | Amount in KES. Whole numbers only. |
| `startDate` **required** | `string` | First execution date, yyyymmdd or yyyy-mm-dd. |
| `endDate` **required** | `string` | Final execution date, yyyymmdd or yyyy-mm-dd. |
| `frequency` **required** | `"one-off" \| "daily" \| "weekly" \| "bi-weekly" \| "monthly" \| "bi-monthly" \| "quarterly" \| "half-yearly" \| "yearly"` | How often the standing order executes. |
| `receiverType` | `"paybill" \| "till"` | Whether the shortcode is a PayBill or a Buy Goods till. Defaults to `"paybill"`. |
| `accountReference` | `string` |  |
| `transactionDesc` | `string` |  |
| `shortCode` | `string` |  |
| `callbackUrl` | `string` |  |

> **Warning** This tool moves money outward and is disabled in production unless `DARAJA_ALLOW_PAYOUTS=true` is set. Nobody approves anything on a phone for this one, so whatever calls it needs its own authorisation step.

## ratiba_create_and_wait

`money` `waits for callback` `gated in production`

Create an M-Pesa Ratiba standing order and wait for the customer to approve it. Returns the settled outcome including the reminder schedule id.

| Parameter | Type | Notes |
|---|---|---|
| `standingOrderName` **required** | `string` | Name of the standing order. Must be unique for this customer; a repeat name is rejected. |
| `phoneNumber` **required** | `string` | Customer phone number. Accepts 07..., +2547..., or 2547... and is normalised. |
| `amount` **required** | `number` | Amount in KES. Whole numbers only. |
| `startDate` **required** | `string` | First execution date, yyyymmdd or yyyy-mm-dd. |
| `endDate` **required** | `string` | Final execution date, yyyymmdd or yyyy-mm-dd. |
| `frequency` **required** | `"one-off" \| "daily" \| "weekly" \| "bi-weekly" \| "monthly" \| "bi-monthly" \| "quarterly" \| "half-yearly" \| "yearly"` | How often the standing order executes. |
| `receiverType` | `"paybill" \| "till"` | Whether the shortcode is a PayBill or a Buy Goods till. Defaults to `"paybill"`. |
| `accountReference` | `string` |  |
| `transactionDesc` | `string` |  |
| `shortCode` | `string` |  |
| `callbackUrl` | `string` |  |
| `timeoutSeconds` | `number` |  Defaults to `90`. |

> **Warning** This tool moves money outward and is disabled in production unless `DARAJA_ALLOW_PAYOUTS=true` is set. Nobody approves anything on a phone for this one, so whatever calls it needs its own authorisation step.

## generate_qr

`money`

Generate a dynamic M-Pesa QR code for a specific amount and till or paybill.

| Parameter | Type | Notes |
|---|---|---|
| `merchantName` **required** | `string` | Name shown to the customer scanning the code. |
| `refNo` **required** | `string` | Your reference for the transaction. |
| `amount` **required** | `number` | Amount in KES. Whole numbers only. |
| `trxCode` **required** | `"BG" \| "WA" \| "PB" \| "SM" \| "SB"` | BG buy goods, WA withdraw agent, PB paybill, SM send money, SB send to business. |
| `cpi` **required** | `string` | Till, paybill, or phone number the payment goes to. |
| `size` | `string` | QR image size in pixels. Defaults to `"300"`. |

