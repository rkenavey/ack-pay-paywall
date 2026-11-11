# Wire protocol

This is the contract between the client agent, the two server agents and the payment service. It is defined in code in `packages/protocol` (`@paywall/protocol`): every body below has a TypeScript type and a valibot schema of the same name plus `Schema` (`PaymentView` and `paymentViewSchema`), and both sides validate what they receive with them. Payment requests are validated with the ACK schema from `agentcommercekit/schemas/valibot`.

All bodies are JSON. Amounts are `Money`: `{ "amount": 500, "decimals": 2, "currency": "USD" }` is $5.00. `amount` is always a positive safe integer of minor units; only USD with 2 decimals is accepted.

## Flow

1. The client calls a paywalled route without a receipt and gets `402` with a signed ACK payment request.
2. It verifies the token, picks a payment option and POSTs a signed initiation to the option's `paymentService`.
3. The payment service applies the spend policy. Above the approval threshold a human decides first.
4. The client pays (sandbox settle call, or Stripe Payment Element in the browser).
5. The client asks the payment service for the receipt. The payment service checks settlement itself and signs a `PaymentReceiptCredential`.
6. The client retries the original request with header `Payment-Receipt: <receipt JWT>` and gets `200` with the resource. Each receipt is redeemed once.

## Errors

Every error answer has the body `{ "error": { "code": "...", "message": "...", "details": { ... } } }`. `details` is optional; `policy_denied` puts the rule there.

## Server agents

Acme is mounted at `/api`, Globex at `/partner`. Both have the same routes.

| Route | Answers |
| :- | :- |
| `GET /resources` | `200 { "resources": ResourceSummary[] }`, free. A summary is `{ id, title, price }`; the content is never listed. |
| `GET /resources/:id` | `200 ResourceBody` (`{ id, title, content }`) when the request carries a valid receipt. Otherwise `402 PaymentRequiredBody` with `Cache-Control: no-store`. `404 resource_not_found`. |

`PaymentRequiredBody` is `{ paymentRequest, paymentRequestToken, error? }`. `paymentRequestToken` is the ACK payment request signed by the server agent; `paymentRequest` is an unsigned copy, and clients trust only the token. The request carries a fresh `id`, the resource title as `description`, an `expiresAt`, and one option per offered network:

```json
{
  "id": "sandbox-usd",
  "amount": 500,
  "decimals": 2,
  "currency": "USD",
  "recipient": "<server agent DID>",
  "network": "sandbox",
  "paymentService": "http://localhost:8787/payment-service",
  "receiptService": "<payment service DID>"
}
```

Option ids are `<network>-usd`; networks are `stripe` and `sandbox`.

`error` is absent on a first request. When a presented receipt is rejected the 402 says why and carries a fresh payment request:

| Code | Meaning |
| :- | :- |
| `receipt_invalid` | Not a valid receipt: bad signature, not a JWT, another credential type, a token from another server agent, a request id never issued here, or an option id not in the request. |
| `receipt_untrusted_issuer` | Signed by someone other than the payment service. |
| `receipt_expired` | Past its expiry. |
| `receipt_wrong_resource` | Paid for another resource. |
| `receipt_already_redeemed` | Already used once. |

## Payment service

Mounted at `/payment-service`.

| Route | Answers |
| :- | :- |
| `POST /payments` | Body `{ "initiation": "<JWT>" }`. `201 PaymentView` in `requires_payment`; `202 PaymentView` in `pending_approval`; `200 PaymentView` for a repeat of the same payer, request and option, whatever its status. `400 invalid_initiation`, `payment_request_invalid`, `payment_option_unknown`, `payment_option_unsupported`. `403 policy_denied` with `details.rule`. `410 payment_request_expired`. |
| `GET /payments/:id` | `200 PaymentView`. `404 payment_not_found`. |
| `POST /payments/:id/sandbox/settle` | `200 PaymentView` in `settled`. `409 payment_not_payable` unless the payment is a sandbox payment in `requires_payment`. |
| `POST /payments/:id/receipt` | `200 { "receipt": "<JWT>" }`. Asking again returns the same JWT. `409 payment_not_settled` or `settlement_mismatch`. `404 payment_not_found`. |
| `POST /webhooks/stripe` | `200`. `400 webhook_signature_invalid`. `503 webhook_not_configured`. |
| `GET /approvals?status=pending` | `200 { "approvals": ApprovalView[] }`. `401 unauthorized`. |
| `POST /approvals/:id/decision` | Body `{ "decision": "approve" \| "reject", "note"?: string }`. `200 ApprovalView`. `401 unauthorized`. `404 approval_not_found`. `409 approval_already_decided`. `410 payment_request_expired`. |

The approver routes require `Authorization: Bearer <approver token>`. CORS on both services allows only the client origin and the headers `Content-Type`, `Authorization` and `Payment-Receipt`.

### The initiation

A JWT signed by the payer with these claims:

| Claim | Value |
| :- | :- |
| `iss` | The payer's DID. |
| `aud` | The option's `paymentService` URL. |
| `iat`, `exp` | `exp` at most 300 seconds after `iat`. |
| `paymentRequestToken` | The token from the 402. |
| `paymentOptionId` | The chosen option's id. |

Nothing else in the initiation or the body is trusted. Amount, currency and payee always come from the verified payment request token.

### PaymentView

```json
{
  "paymentId": "pay_…",
  "status": "requires_payment",
  "paymentRequestId": "pr_…",
  "paymentOptionId": "sandbox-usd",
  "network": "sandbox",
  "amount": { "amount": 500, "decimals": 2, "currency": "USD" },
  "description": "Market brief",
  "payer": "<initiation iss>",
  "payee": "<payment request token iss>",
  "policy": { "outcome": "allow", "rule": "within_limits" },
  "next": { "type": "sandbox_settle" }
}
```

`status` is one of `pending_approval`, `rejected`, `requires_payment`, `settled`, `failed`. `next` is present exactly when the status is `requires_payment`: `{ "type": "sandbox_settle" }`, or `{ "type": "stripe_payment_element", "clientSecret", "publishableKey" }`. `failure` is present exactly when the status is `failed`. `approvalId` is present when the policy asked for approval.

`policy` is one of:

| `outcome` | `rule` |
| :- | :- |
| `allow` | `within_limits` |
| `needs_approval` | `amount_over_threshold`, with `threshold` |
| `deny` | `invalid_amount`, `currency_not_supported` or `counterparty_not_allowed` |

### The receipt

A `PaymentReceiptCredential` signed by the payment service, as a JWT. Its subject is the payer; it embeds the payment request token and the option id, and expires a fixed time after settlement. Its metadata is `{ paymentId, paymentRequestId, network, amount, decimals, currency, payee, settlementRef, settledAt }`.

### ApprovalView

`{ approvalId, paymentId, status, payer, payee, amount, description?, requestedAt, decidedAt?, note? }`, where `status` is `pending`, `approved` or `rejected` and times are ISO 8601.

## Events

Every protocol step emits one event to an injected event log: `{ name, actor, at, paymentRequestId?, paymentId?, data? }`. `at` is ISO 8601 from the injected clock; `data` holds only strings, numbers, booleans and nulls. Event data never contains a private key, a Stripe secret key, a client secret, the approver token or a complete JWT; tokens appear as their last 8 characters (`tokenTail`).

In the order they happen on a paid request:

| Step | Events |
| :- | :- |
| Request | `client.request.sent`, `server.request.received` |
| 402 | `server.payment_required.issued`, `client.payment_required.received`, `client.payment_request.verified` |
| Initiation | `client.option.selected`, `client.payment.initiated`, `ps.payment.initiated` |
| Policy and approval | `ps.policy.evaluated`, `ps.approval.requested`, `client.approval.waiting`, `ps.approval.decided` |
| Payment | `ps.settlement.started`, `client.payment.executing`, `ps.settlement.confirmed` |
| Receipt | `ps.receipt.issued`, `client.receipt.received`, `client.receipt.verified` |
| Retry and delivery | `client.request.retried`, `server.receipt.presented`, `server.receipt.verified`, `server.resource.delivered`, `client.resource.received` |
| Failures | `server.receipt.rejected`, `ps.settlement.failed`, `client.flow.failed` |

The prefix names the actor: `client.` the client agent, `server.` a server agent, `ps.` the payment service. `EVENT_LABELS` gives each a readable label.
