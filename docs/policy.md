# Spend policy

The spend policy decides, before any money moves, whether a payment may go ahead, needs a human, or is refused. It runs in the payment service on every new payment. It guards the payer's money, so the counterparty it checks is the payee: the DID that signed the payment request.

The code is `packages/server/src/policy`: `evaluateSpend(request, config)` and `parseSpendPolicyConfig(env)`.

## The rules

`evaluateSpend` is pure and synchronous: it reads no clock, no randomness, no files and no environment, and it never throws. The same input always gets the same decision. The rules are checked in this order and the first that matches decides:

| # | When | Decision |
| :- | :- | :- |
| 1 | `amount.amount` is not a positive safe integer of type `number` (zero, negative, fractional, `NaN`, infinite, above 2^53 - 1, a string, missing) | deny, `invalid_amount` |
| 2 | `amount.currency` or `amount.decimals` differs from the threshold's (`USD`, 2) | deny, `currency_not_supported` |
| 3 | the counterparty is not in the allowlist, by exact, case-sensitive string comparison; an empty allowlist matches nothing | deny, `counterparty_not_allowed` |
| 4 | `amount.amount` is greater than the threshold's amount | `needs_approval`, `amount_over_threshold`, with the threshold in the decision |
| 5 | otherwise | allow, `within_limits` |

Deny beats approval: a human cannot approve a payment to a payee that is not on the list. Exactly the threshold is allowed; one cent more needs approval.

Malformed input is denied rather than raising an error: a request without a usable amount is `invalid_amount`, a configuration without a usable threshold is `currency_not_supported`, and one without an allowlist is `counterparty_not_allowed`.

## Examples

With the allowlist `did:key:zAcme` and the default threshold of $50.00. Each row was run against the code. Amounts are `{ amount, decimals: 2, currency: "USD" }` unless stated.

| Counterparty | Amount | Decision |
| :- | :- | :- |
| `did:key:zAcme` | 500 ($5.00) | `{"outcome":"allow","rule":"within_limits"}` |
| `did:key:zAcme` | 5000 ($50.00) | `{"outcome":"allow","rule":"within_limits"}` |
| `did:key:zAcme` | 5001 ($50.01) | `{"outcome":"needs_approval","rule":"amount_over_threshold","threshold":{"amount":5000,"decimals":2,"currency":"USD"}}` |
| `did:key:zAcme` | 7500 ($75.00) | `needs_approval`, as above |
| `did:key:zGlobex` | 500 | `{"outcome":"deny","rule":"counterparty_not_allowed"}` |
| `did:key:zGlobex` | 7500 | `{"outcome":"deny","rule":"counterparty_not_allowed"}` |
| `DID:KEY:ZACME` | 500 | `{"outcome":"deny","rule":"counterparty_not_allowed"}` |
| `did:key:zAcme` | 500, currency `EUR` | `{"outcome":"deny","rule":"currency_not_supported"}` |
| `did:key:zAcme` | 500, decimals 3 | `{"outcome":"deny","rule":"currency_not_supported"}` |
| `did:key:zAcme` | 0, -500, 12.5, `"500"` or 2^60 | `{"outcome":"deny","rule":"invalid_amount"}` |
| `did:key:zGlobex` | 0, currency `EUR` | `{"outcome":"deny","rule":"invalid_amount"}` (rule 1 comes first) |
| `did:key:zAcme`, empty allowlist | 500 | `{"outcome":"deny","rule":"counterparty_not_allowed"}` |

## Configuration

`parseSpendPolicyConfig(env)` builds the configuration from two environment-style variables:

| Variable | Meaning |
| :- | :- |
| `POLICY_ALLOWED_COUNTERPARTIES` | Required. Comma-separated payee DIDs. Whitespace around each DID and empty entries are ignored. Set but empty (`POLICY_ALLOWED_COUNTERPARTIES=`) means an empty list, which denies every payment. |
| `POLICY_APPROVAL_THRESHOLD_MINOR` | The approval threshold in US cents, a positive whole number. Default `5000` ($50.00); an empty value also means the default. |

`parseSpendPolicyConfig` throws when the allowlist variable is missing, when an entry is not a DID (`did:<method>:<id>`), or when the threshold is zero, negative, fractional, not a number or above 2^53 - 1. The message names the variable and does not repeat its value:

```
POLICY_ALLOWED_COUNTERPARTIES is required (comma-separated DIDs; empty denies every payment)
POLICY_ALLOWED_COUNTERPARTIES entry 1 is not a DID
POLICY_APPROVAL_THRESHOLD_MINOR must be a positive whole number of US cents
```

To let the client pay another server agent, add its DID to `POLICY_ALLOWED_COUNTERPARTIES`. The DID must match exactly what that agent signs its payment requests with.
