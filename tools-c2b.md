# C2B and diagnostics

Receiving payments customers start themselves, and the tools for seeing what actually arrived.

## c2b_register_urls

`control`

Register the validation and confirmation URLs that Daraja calls when a customer pays your PayBill or till directly. Required once per shortcode before C2B notifications work.

| Parameter | Type | Notes |
|---|---|---|
| `shortCode` | `string` |  |
| `responseType` | `"Completed" \| "Cancelled"` | What Daraja should do when your validation endpoint is unreachable. Completed accepts the payment anyway; Cancelled rejects it. Defaults to `"Completed"`. |
| `confirmationUrl` | `string` |  |
| `validationUrl` | `string` |  |

## c2b_simulate

`money`

Simulate a customer paying your shortcode. Sandbox and simulator only.

| Parameter | Type | Notes |
|---|---|---|
| `phoneNumber` **required** | `string` |  |
| `amount` **required** | `number` |  |
| `billRefNumber` | `string` |  Defaults to `"TEST"`. |
| `commandId` | `"CustomerPayBillOnline" \| "CustomerBuyGoodsOnline"` |  Defaults to `"CustomerPayBillOnline"`. |
| `shortCode` | `string` |  |

## pull_register

`control`

Register a shortcode for the Pull Transactions API, which lets you fetch missed C2B transactions after an outage.

| Parameter | Type | Notes |
|---|---|---|
| `shortCode` | `string` |  |
| `nominatedNumber` **required** | `string` | Phone number registered to receive pull notifications. |
| `callbackUrl` | `string` |  |

## pull_transactions

`control`

Fetch C2B transactions for a time window. Useful for reconciliation when callbacks were missed.

| Parameter | Type | Notes |
|---|---|---|
| `shortCode` | `string` |  |
| `startDate` **required** | `string` | Start of the window, "yyyy-mm-dd hh:mm:ss". |
| `endDate` **required** | `string` | End of the window, "yyyy-mm-dd hh:mm:ss". |
| `offsetValue` | `string` | Pagination offset. Defaults to `"0"`. |

## list_callbacks

`control`

List callbacks this server has received, newest first.

| Parameter | Type | Notes |
|---|---|---|
| `limit` | `number` |  Defaults to `20`. |
| `kind` | `"stk" \| "b2c" \| "b2b" \| "balance" \| "status" \| "reversal" \| "ratiba" \| "c2b-validation" \| "c2b-confirmation" \| "timeout" \| "unknown"` | Filter to one product family. |

## get_callback

`control`

Fetch the full callback payload for a correlation id.

| Parameter | Type | Notes |
|---|---|---|
| `correlationId` **required** | `string` | CheckoutRequestID, ConversationID, or the Ratiba correlationId. |

## server_health

`control`

Report the current mode, which credentials are configured, and callback receiver status. Start here when something is not working.

_No parameters._

