# All tools

25 tools covering the Daraja 3.0 product surface. Every one runs against the simulator with no Safaricom account, so you can try any of them before deciding whether the shape fits.

## Find one by task

| I want to | Use |
|---|---|
| Charge a customer and know whether it worked | `stk_push_and_wait` |
| Charge a customer without waiting | `stk_push` |
| Set up a recurring collection | `ratiba_create_and_wait` |
| Pay someone out | `b2c_payment_and_wait` |
| Pay another business | `b2b_payment` |
| Check whether a past payment succeeded | `transaction_status` |
| See what a callback actually contained | `get_callback` |
| Check a number for SIM-swap fraud before paying it | `check_sim_swap` |
| Confirm which business owns a shortcode | `query_org_info` |
| Work out why nothing is happening | `server_health` |

## Groups

### Payments

Collecting money from a customer. These are the flows where the customer approves a prompt on their own phone, so a person is always in the loop.

`stk_push` · `stk_push_and_wait` · `stk_query` · `ratiba_create` · `ratiba_create_and_wait` · `generate_qr`

[See all 6 in Payments](/daraja-mcp/tools-payments/)

### Disbursement and treasury

Moving money out, and the treasury operations around it. Nothing here asks a human to approve anything, which is why most of it is disabled in production until you opt in.

`b2c_payment` · `b2c_payment_and_wait` · `b2b_payment` · `tax_remittance` · `business_to_pochi` · `account_balance` · `transaction_status` · `reversal`

[See all 8 in Disbursement and treasury](/daraja-mcp/tools-disbursement/)

### Identity and fraud

New in Daraja 3.0. Cheap checks worth running before you send money to a number you have not paid before.

`check_sim_swap` · `check_age_on_network` · `validate_identity` · `query_org_info`

[See all 4 in Identity and fraud](/daraja-mcp/tools-identity/)

### C2B and diagnostics

Receiving payments customers start themselves, and the tools for seeing what actually arrived.

`c2b_register_urls` · `c2b_simulate` · `pull_register` · `pull_transactions` · `list_callbacks` · `get_callback` · `server_health`

[See all 7 in C2B and diagnostics](/daraja-mcp/tools-c2b/)

## Reading an entry

Each tool carries a few labels. `money` means it moves or reports money; `control` means it configures or inspects. `waits for callback` means it blocks until Daraja reports the settled outcome, rather than returning an acknowledgement. `gated in production` means it is disabled unless you opt in, because it moves money outward with no human approving anything.

Every tool response also states the environment it ran against, so neither you nor the model has to guess whether real money moved.
