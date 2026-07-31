# Identity and fraud

New in Daraja 3.0. Cheap checks worth running before you send money to a number you have not paid before.

## check_sim_swap

`control`

Return the date a number was last SIM-swapped. A recent swap is a strong fraud signal; check this before disbursing to an unfamiliar number.

| Parameter | Type | Notes |
|---|---|---|
| `phoneNumber` **required** | `string` | Number to check. |

## check_age_on_network

`control`

Return the date a number was first registered on the Safaricom network. Very new lines carry elevated fraud risk.

| Parameter | Type | Notes |
|---|---|---|
| `phoneNumber` **required** | `string` | Number to check. |

## validate_identity

`control`

Check whether a phone number is registered against a given national ID number.

| Parameter | Type | Notes |
|---|---|---|
| `phoneNumber` **required** | `string` | Number to validate. |
| `idNumber` **required** | `string` | Identification number the line should be registered against. |
| `idType` | `"national" \| "military" \| "passport"` | Which identity document the number belongs to. Defaults to `"national"`. |
| `shortCode` | `string` |  |

## query_org_info

`control`

Look up the registered name and tariff of a PayBill or till. Use this to confirm you are paying the business you intend to before sending money.

| Parameter | Type | Notes |
|---|---|---|
| `shortCode` **required** | `string` | PayBill or till number to look up. |
| `identifierType` | `"4" \| "2"` | 4 for PayBill, 2 for a Buy Goods till. Defaults to `"4"`. |

