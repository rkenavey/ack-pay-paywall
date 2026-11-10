# ACK-Pay HTTP 402 paywall

This file is the spec. It defines what is built, the interfaces, the tests that define "done", the task list, and the gate every task passes. Read sections 1 to 5 before writing code, and the brief for your task in section 7.

Status: nothing is implemented yet. Work proceeds through tasks T1 to T7.

## 1. What we are building

A TypeScript implementation of an HTTP 402 paywall that follows the ACK-Pay [server-initiated sequence](https://www.agentcommercekit.com/ack-pay/server-initiated-sequence.md), built on the ACK npm packages.

| Piece | What it is |
| :- | :- |
| Server agent | A small API. Paywalled routes answer `402 Payment Required` with an ACK Payment Request, and deliver the resource when the retry carries a valid ACK Receipt. |
| Payment service | Takes the client's payment for a payment option, applies the spend policy, settles it (sandbox or Stripe test mode), and issues the signed receipt. It is also the receipt service. |
| Spend policy | A deterministic module in the payment service: an allowlist of counterparties, and human approval above $50. |
| Client agent | A small React site. It calls the API, receives the 402, picks a payment option, pays, gets the receipt and retries. The UI shows every step. |
| Test suite | Written first. It defines done for everything else. |

### Roles and where they run

```
Browser (Vite, :5173)                        Node process (:8787)
┌────────────────────────────┐   HTTP    ┌──────────────────────────────────────────┐
│ Client agent (did:key)     │──────────▶│ /api          Server agent "Acme"        │
│  agent core + React UI     │           │ /partner      Server agent "Globex"      │
│ Human approver panel       │──────────▶│ /payment-service   Payment + receipt     │
│ Stripe.js Payment Element  │──┐        │      service: policy, approvals,         │
└────────────────────────────┘  │        │      sandbox + Stripe settlement         │
                                ▼        └───────────────────┬──────────────────────┘
                           Stripe (test mode) ◀──────────────┘
```

The server agents and the payment service share a process but nothing else: separate DIDs and keys, separate route trees, no imports between them (section 5). They exchange only ACK artifacts. Globex is a second instance of the same paywall whose DID is not on the allowlist; it exists so the deny path is visible.

### The sequence, as built

| ACK step | Here | Events (section 3.6) |
| :- | :- | :- |
| 1. Client request | `GET /api/resources/:id` with no receipt | `client.request.sent`, `server.request.received` |
| 2. Payment Request | `402` with `{ paymentRequest, paymentRequestToken }`; the client verifies the token | `server.payment_required.issued`, `client.payment_required.received`, `client.payment_request.verified` |
| 3. Select option, contact payment service | Client picks an option and POSTs a signed initiation to the option's `paymentService` | `client.option.selected`, `client.payment.initiated`, `ps.payment.initiated` |
| 4. Negotiation, human in the loop | Policy runs before any money moves; above $50 a human decides | `ps.policy.evaluated`, `ps.approval.requested`, `client.approval.waiting`, `ps.approval.decided` |
| 5. Execution | Sandbox settle call, or Stripe Payment Element confirmed in the browser | `ps.settlement.started`, `client.payment.executing`, `ps.settlement.confirmed` |
| 6. Receipt generation | Payment service verifies settlement itself, then signs a `PaymentReceiptCredential` | `ps.receipt.issued` |
| 7. Receipt delivery | Client fetches and verifies the receipt | `client.receipt.received`, `client.receipt.verified` |
| 8. Present receipt | Retry with header `Payment-Receipt: <receipt JWT>` | `client.request.retried`, `server.receipt.presented`, `server.receipt.verified` |
| 9. Service delivery | `200` with the resource | `server.resource.delivered`, `client.resource.received` |

### Not in scope

Receipt revocation lists, `did:web` hosting, ACK-ID controller credentials, `serviceCallback`, persistence beyond process memory, refunds, currencies other than USD, production deployment, binding a receipt to its presenter (receipts are single-use bearer tokens).

## 2. Ground rules

1. **Use the ACK packages.** Every payment request, payment request token, receipt, DID, key and JWT is created and verified with `agentcommercekit` (exact version `0.11.0`). No hand-rolled JWT or credential code, and no direct imports of `jose`, `jsonwebtoken`, `did-jwt`, `did-jwt-vc` or `did-resolver`.
2. **Do not copy the ACK demos.** Do not read, clone or vendor `demos/` or `examples/` from the `agentcommercekit/ack` repository. Work from the docs pages at agentcommercekit.com, this spec, and the type declarations in `node_modules/@agentcommercekit/*/dist/*.d.mts`.
3. **Types beat prose.** Where a package README disagrees with its `.d.mts`, the `.d.mts` is right. Section 3.8 lists what was checked.
4. **Tests are the definition of done.** After T1, change a pre-existing test only when it contradicts this spec, and mark the change `// spec-fix(T<n>): <reason>`. Never skip, focus, delete or loosen a test to get green. Adding tests is always fine.
5. **The harness is the human's.** Do not edit `CLAUDE.md` or anything under `.claude/`. If the spec or the gate is wrong, stop and say so.
6. **Secrets.** Stripe keys, private JWKs and the approver token live only in `.env` (gitignored). Never print, log or commit them, and never send a secret key to the browser. Test-mode Stripe keys only.
7. **Fail closed.** A missing config value, an unverifiable token, an unknown state or a policy error means no payment and no resource.
8. **Server-derived money.** Amount, currency and payee always come from the verified payment request token, never from a client-supplied field.
9. **Document as you go.** Each task writes the documentation for what it builds, in the same task (section 7, Documentation). A task whose documentation is missing or wrong does not conform to this spec.

## 3. Interfaces

These are the contracts. T1 turns them into code in `packages/protocol` and into stubs elsewhere; later tasks fill the stubs without changing the shapes.

### 3.1 Wire contract (`@paywall/protocol`, shared by server and client)

```ts
import type { DidUri, JwtString, PaymentRequest } from "agentcommercekit"

export const RECEIPT_HEADER = "Payment-Receipt" // request header carrying the receipt VC-JWT

export type Network = "sandbox" | "stripe"       // PaymentOption.network values we issue
export interface Money { amount: number; decimals: number; currency: string } // amount: positive safe integer in minor units

export interface ErrorBody<C extends string = string> {
  error: { code: C; message: string; details?: Record<string, unknown> }
}

// 402 body. `error` is absent on a first request. When a presented receipt was
// rejected it says why, and the body carries a fresh payment request.
export type ReceiptErrorCode =
  | "receipt_invalid" | "receipt_untrusted_issuer" | "receipt_expired"
  | "receipt_wrong_resource" | "receipt_already_redeemed"
export interface PaymentRequiredBody {
  paymentRequest: PaymentRequest
  paymentRequestToken: JwtString
  error?: ErrorBody<ReceiptErrorCode>["error"]
}

export interface ResourceSummary { id: string; title: string; price: Money }
export interface ResourceBody { id: string; title: string; content: string }

// POST {paymentService}/payments
export interface InitiatePaymentBody { initiation: JwtString }
// Claims of the initiation JWT. Registered claims: iss = payer DID,
// aud = the option's paymentService URL, exp at most 300 s after iat.
export interface PaymentInitiationClaims { paymentRequestToken: JwtString; paymentOptionId: string }

export type PaymentStatus = "pending_approval" | "rejected" | "requires_payment" | "settled" | "failed"
export type NextAction =
  | { type: "sandbox_settle" }
  | { type: "stripe_payment_element"; clientSecret: string; publishableKey: string }

export interface PaymentView {
  paymentId: string
  status: PaymentStatus
  paymentRequestId: string
  paymentOptionId: string
  network: Network
  amount: Money
  description?: string
  payer: DidUri                 // iss of the initiation JWT
  payee: DidUri                 // iss of the payment request token
  policy: PolicyDecision        // section 3.4
  approvalId?: string           // present when policy.outcome is "needs_approval"
  next?: NextAction             // present exactly when status is "requires_payment"
  failure?: string              // present exactly when status is "failed"
}
export interface ReceiptBody { receipt: JwtString }

// Approver API. Human only.
export interface ApprovalView {
  approvalId: string; paymentId: string
  status: "pending" | "approved" | "rejected"
  payer: DidUri; payee: DidUri; amount: Money; description?: string
  requestedAt: string; decidedAt?: string; note?: string
}
export interface ApprovalDecisionBody { decision: "approve" | "reject"; note?: string }
```

Every wire type has a valibot schema of the same name plus `Schema` (`paymentViewSchema`). `PaymentRequest` is validated with the ACK schema from `agentcommercekit/schemas/valibot`. Both sides validate what they receive.

**Server agent routes** (Acme at `/api`, Globex at `/partner`):

| Route | Responses |
| :- | :- |
| `GET /resources` | `200 { resources: ResourceSummary[] }`. Free. |
| `GET /resources/:id` | `200 ResourceBody` with a valid receipt. `402 PaymentRequiredBody` otherwise, with `Cache-Control: no-store`. `404 ErrorBody<"resource_not_found">`. |

**Payment service routes** (at `/payment-service`):

| Route | Responses |
| :- | :- |
| `POST /payments` | `201 PaymentView` (`requires_payment`). `202 PaymentView` (`pending_approval`). `200 PaymentView` for a repeat of the same payer, request and option, whatever its status. `400` `invalid_initiation`, `payment_request_invalid`, `payment_option_unknown`, `payment_option_unsupported`. `403 policy_denied` with `details.rule`. `410 payment_request_expired`. |
| `GET /payments/:id` | `200 PaymentView`. `404 payment_not_found`. |
| `POST /payments/:id/sandbox/settle` | `200 PaymentView` (`settled`). `409 payment_not_payable` unless the payment is a sandbox payment in `requires_payment`. |
| `POST /payments/:id/receipt` | `200 ReceiptBody`. `409 payment_not_settled` or `settlement_mismatch`. `404 payment_not_found`. |
| `POST /webhooks/stripe` | `200`. `400 webhook_signature_invalid`. `503 webhook_not_configured`. |
| `GET /approvals?status=pending` | `200 { approvals: ApprovalView[] }`. `401 unauthorized`. |
| `POST /approvals/:id/decision` | `200 ApprovalView`. `401 unauthorized`. `404 approval_not_found`. `409 approval_already_decided`. `410 payment_request_expired`. |

`paymentId` and `approvalId` are random 128-bit identifiers. The approver routes require `Authorization: Bearer <APPROVER_TOKEN>`, compared in constant time. CORS on both services allows only `CLIENT_ORIGIN` and the headers `Content-Type`, `Authorization` and `Payment-Receipt`.

### 3.2 Server agent

```ts
export interface AgentIdentity { did: DidUri; signer: JwtSigner; alg: JwtAlgorithm } // built from a private JWK with jwkToKeypair, createDidKeyUri, createJwtSigner, curveToJwtAlgorithm

export interface CatalogEntry extends ResourceSummary { content: string }

export interface IssuedPaymentRequest { id: string; resourceId: string; expiresAt: Date; redeemedAt?: Date }
export interface PaymentRequestStore {
  save(record: IssuedPaymentRequest): Promise<void>
  get(id: string): Promise<IssuedPaymentRequest | undefined>
  redeem(id: string, at: Date): Promise<boolean> // atomic; true for the first caller only
}

export interface Clock { now(): Date }
export interface IdGenerator { next(prefix: string): string }

export interface ServerAgentDeps {
  identity: AgentIdentity
  catalog: readonly CatalogEntry[]
  store: PaymentRequestStore
  paymentService: { url: string; did: DidUri; networks: readonly Network[] } // where to pay, who signs receipts, which options to offer
  paymentRequestTtlSeconds: number
  resolver: Resolvable
  clock: Clock; ids: IdGenerator; log: EventLog
}
export function createServerAgent(deps: ServerAgentDeps): Hono
```

**Issuing the 402.** `createSignedPaymentRequest` with a fresh `id`, the resource title as `description`, `expiresAt = now + ttl`, and one option per network in `deps.paymentService.networks`: `id` is `"<network>-usd"`, `amount`, `decimals` and `currency` from the catalog, `recipient` is the server agent's DID, `paymentService` is the payment service URL, `receiptService` is the payment service DID. Save `{ id, resourceId, expiresAt }` before responding. The payment request schema strips unknown fields, which is why the resource binding lives in the store and not in the token.

**Verifying a receipt.** In this order; the first failure answers `402` with the listed code and a fresh payment request.

1. `verifyPaymentReceipt(header, { resolver, trustedReceiptIssuers: [paymentService.did], paymentRequestIssuer: identity.did })`. `UntrustedIssuerError` maps to `receipt_untrusted_issuer`, `CredentialExpiredError` to `receipt_expired`, anything else to `receipt_invalid`. From here on read only the values this call returned.
2. `paymentRequest.id` is in the store, else `receipt_invalid`. Its `resourceId` is the requested resource, else `receipt_wrong_resource`.
3. `credentialSubject.paymentOptionId` is one of the request's option ids, else `receipt_invalid`.
4. `store.redeem(id)` returns true, else `receipt_already_redeemed`.
5. Respond `200` with the resource.

### 3.3 Payment service

```ts
export interface PaymentRecord {
  id: string; status: PaymentStatus
  paymentRequestId: string; paymentRequestToken: JwtString; paymentOptionId: string
  network: Network; amount: Money; description?: string
  payer: DidUri; payee: DidUri; expiresAt?: Date
  policy: PolicyDecision; approvalId?: string
  next?: NextAction; failure?: string
  settlement?: { ref: string; settledAt: Date }
  receipt?: JwtString
}
export interface PaymentStore {
  create(record: PaymentRecord): Promise<void>
  get(id: string): Promise<PaymentRecord | undefined>
  findByKey(payer: DidUri, paymentRequestId: string, paymentOptionId: string): Promise<PaymentRecord | undefined>
  // compare-and-set on status; resolves false when the record is not in `from`
  transition(id: string, from: PaymentStatus, patch: Partial<PaymentRecord> & { status: PaymentStatus }): Promise<boolean>
}

export type SettlementResult =
  | { settled: true; ref: string; settledAt: Date }
  | { settled: false; reason: "pending" | "failed" | "mismatch"; detail?: string }
export interface SettlementAdapter {
  readonly network: Network
  begin(payment: PaymentRecord): Promise<NextAction>      // idempotent per payment.id; the only place money movement starts
  verify(payment: PaymentRecord): Promise<SettlementResult> // authoritative, server-side
}

// The seam over the Stripe SDK. Real implementation in T5; FakeStripeGateway in the testkit.
export interface StripeGateway {
  createPaymentIntent(input: { amount: number; currency: string; description?: string; metadata: Record<string, string>; idempotencyKey: string }): Promise<{ id: string; clientSecret: string }>
  retrievePaymentIntent(id: string): Promise<{ id: string; status: string; amount: number; amountReceived: number; currency: string; metadata: Record<string, string> }>
  constructWebhookEvent(rawBody: string, signature: string): { id: string; type: string; paymentIntentId?: string } // throws on a bad signature
}

export interface Approval { id: string; paymentId: string; status: "pending" | "approved" | "rejected"; requestedAt: Date; decidedAt?: Date; note?: string }
export interface ApprovalStore {
  create(approval: Approval): Promise<void>
  get(id: string): Promise<Approval | undefined>
  list(status?: Approval["status"]): Promise<Approval[]>
  decide(id: string, status: "approved" | "rejected", at: Date, note?: string): Promise<boolean> // atomic; true for the first decision only
}

export interface PaymentServiceDeps {
  identity: AgentIdentity         // signs receipts; its DID is the receiptService
  publicUrl: string               // must equal option.paymentService
  policy: (request: SpendRequest) => PolicyDecision
  adapters: readonly SettlementAdapter[]
  payments: PaymentStore; approvals: ApprovalStore
  approverToken: string
  receiptTtlSeconds: number
  stripe?: { gateway: StripeGateway; webhookConfigured: boolean }
  resolver: Resolvable
  clock: Clock; ids: IdGenerator; log: EventLog
}
export function createPaymentService(deps: PaymentServiceDeps): Hono
```

**Payment states.**

```
POST /payments ── policy deny ──────────▶ 403, no record
              ├─ policy allow ─────────▶ requires_payment ── settlement verified ──▶ settled
              └─ policy needs_approval ▶ pending_approval ── approve ─▶ requires_payment
                                                          └─ reject ──▶ rejected
requires_payment or pending_approval ── request expired, settlement failed ──▶ failed
```

**Initiating a payment.** In this order:

1. `verifyJwt` on the initiation with our resolver. Require `aud === publicUrl` and an `exp` no more than 300 s after `iat`. Failure is `invalid_initiation`. The payer is the verified `iss`.
2. `verifyPaymentRequestToken(claims.paymentRequestToken, { resolver })`. Failure is `payment_request_invalid`. The payee is the verified `iss`. That function does not enforce `expiresAt`, so compare it to the clock here: past is `payment_request_expired`.
3. Find the option by id, else `payment_option_unknown`. Require `paymentService === publicUrl`, `receiptService === identity.did`, a `network` that has an adapter, and an `amount` that is a positive safe integer of type number, else `payment_option_unsupported`.
4. If `findByKey` returns a payment, respond `200` with it and stop. A rejected or failed payment cannot be retried by initiating again.
5. `policy({ payer, counterparty: payee, amount, paymentRequestId, description })`. Log the decision.
6. `deny`: respond `403 policy_denied`. Nothing is stored and no adapter is called.
7. `needs_approval`: store the payment as `pending_approval` with a pending `Approval`, respond `202`. No adapter is called.
8. `allow`: store the payment, call `adapter.begin`, store its `NextAction`, respond `201`.

**Settling and issuing the receipt.** One function, `settle(paymentId)`, called from the receipt route, the sandbox settle route and the Stripe webhook. It requires status `requires_payment`, calls `adapter.verify`, and on success moves the payment to `settled` with one compare-and-set. `POST /payments/:id/receipt` runs `settle` if needed, then issues the receipt once and stores it; later calls return the same JWT. `pending` answers `409 payment_not_settled`, `mismatch` answers `409 settlement_mismatch`.

**The receipt.** `createPaymentReceipt({ paymentRequestToken, paymentOptionId, issuer: identity.did, payerDid: payer, expirationDate: settledAt + receiptTtl, metadata })` then `signCredential(credential, { did, signer, alg })`. Metadata is `{ paymentId, paymentRequestId, network, amount, decimals, currency, payee, settlementRef, settledAt }`. No secrets.

**Sandbox adapter.** `begin` returns `{ type: "sandbox_settle" }`. The settle route marks the payment as paid in an in-memory ledger; `verify` reads that ledger. It moves no real money and is listed in `networks` only when `SANDBOX_NETWORK=on`.

**Stripe adapter (T5).** Section 4.

### 3.4 Spend policy

```ts
export interface SpendPolicyConfig {
  allowedCounterparties: readonly DidUri[]
  approvalThreshold: Money // default { amount: 5000, decimals: 2, currency: "USD" }
}
export interface SpendRequest { payer: DidUri; counterparty: DidUri; amount: Money; paymentRequestId: string; description?: string }
export type PolicyDecision =
  | { outcome: "allow"; rule: "within_limits" }
  | { outcome: "needs_approval"; rule: "amount_over_threshold"; threshold: Money }
  | { outcome: "deny"; rule: "invalid_amount" | "currency_not_supported" | "counterparty_not_allowed" }

export function evaluateSpend(request: SpendRequest, config: SpendPolicyConfig): PolicyDecision
export function parseSpendPolicyConfig(env: Record<string, string | undefined>): SpendPolicyConfig // throws on invalid input
```

`evaluateSpend` is pure, synchronous and total: no clock, no randomness, no I/O, no environment, never throws. The first matching rule wins:

1. `amount.amount` is not a positive safe integer: deny `invalid_amount`.
2. `amount.currency` or `amount.decimals` differs from the threshold's: deny `currency_not_supported`.
3. `counterparty` is not in `allowedCounterparties` by exact string comparison: deny `counterparty_not_allowed`. An empty list denies everything.
4. `amount.amount > approvalThreshold.amount`: `needs_approval`. Exactly $50.00 is allowed; $50.01 needs approval.
5. Otherwise allow.

Deny beats approval: a human cannot approve a payment to a counterparty that is not on the list. The counterparty is the payee, the DID that issued the payment request.

**Human approval.** The human is whoever holds `APPROVER_TOKEN`. The client agent never has it. Approving calls `adapter.begin` exactly once and moves the payment to `requires_payment`. Rejecting moves it to `rejected`. A decision is final. Deciding after the payment request expired answers `410` and fails the payment.

### 3.5 Client agent

```ts
// packages/client/src/agent. No React, no Stripe imports.
export interface PaymentExecutor {
  readonly network: Network
  // Does the client-side part of paying. Resolving means "ask for the receipt now", not "settled".
  execute(ctx: { payment: PaymentView; next: NextAction; paymentServiceUrl: string; fetch: typeof fetch; signal: AbortSignal }): Promise<void>
}
export type OptionSelector = (options: readonly PaymentOption[], supported: readonly Network[]) => PaymentOption | undefined

export type FlowStatus =
  | "idle" | "requesting" | "verifying_request" | "selecting_option" | "initiating"
  | "awaiting_approval" | "paying" | "fetching_receipt" | "retrying" | "delivered" | "failed"
export type FlowFailure =
  | "payment_request_invalid" | "payment_request_mismatch" | "payment_request_expired"
  | "no_supported_option" | "policy_denied" | "approval_rejected" | "approval_timeout"
  | "payment_failed" | "receipt_invalid" | "payment_not_accepted" | "http_error" | "aborted"
export interface FlowState {
  status: FlowStatus
  paymentRequired?: PaymentRequiredBody
  payee?: DidUri
  selectedOption?: PaymentOption
  payment?: PaymentView
  receipt?: JwtString
  resource?: ResourceBody
  failure?: { code: FlowFailure; message: string; details?: Record<string, unknown> }
}

export interface PaywallClientDeps {
  fetch: typeof fetch
  identity: AgentIdentity
  executors: readonly PaymentExecutor[]
  selectOption: OptionSelector          // default: first supported network in the order ["stripe", "sandbox"]
  resolver: Resolvable
  clock: Clock; log: EventLog
  approvalPoll: { intervalMs: number; timeoutMs: number } // default 1000 and 300000
}
export interface PaywallClient {
  fetchPaid(url: string, init?: { signal?: AbortSignal }): Promise<FlowState> // resolves in "delivered" or "failed"; never rejects for protocol failures
  subscribe(listener: (state: FlowState) => void): () => void
}
export function createPaywallClient(deps: PaywallClientDeps): PaywallClient
```

**What the client does on a 402.**

1. `verifyPaymentRequestToken(token, { resolver })`, else `payment_request_invalid`. The verified payload is the request. If the unsigned `paymentRequest` in the body differs from it, fail with `payment_request_mismatch`. A past `expiresAt` is `payment_request_expired`.
2. `selectOption` over the networks it has executors for, else `no_supported_option`.
3. Sign the initiation with `createJwt` (`aud` is the option's `paymentService`, `expiresIn` 300) and POST it. `403 policy_denied` ends the flow with the rule in `details`.
4. `pending_approval`: poll `GET /payments/:id` until it changes. `rejected` is `approval_rejected`; the poll timeout is `approval_timeout`.
5. `requires_payment`: run the executor for the network. A thrown error is `payment_failed`.
6. `POST /payments/:id/receipt`. Verify the result with `verifyPaymentReceipt(receipt, { resolver, trustedReceiptIssuers: [option.receiptService], paymentRequestIssuer: payee })`, then require that the returned token is the one it paid and the credential subject is its own DID, else `receipt_invalid`.
7. Retry the original request once with the receipt header. A second `402` is `payment_not_accepted`. One `fetchPaid` call never pays twice.

**Identity.** An Ed25519 `did:key` generated in the browser on first load and kept in `localStorage` as a JWK. This is demo-grade key storage and the UI says so.

**UI.** One page, three regions:

- *Catalog*: resources from both server agents with prices and a Fetch button.
- *Agent run*: the current `FlowStatus`, a timeline with one row per event in order, the decoded payment request (payee DID, description, options with the selected one marked), the payment element when Stripe is the selected network, the decoded receipt (issuer, payer, option, expiry) and the delivered content or the failure with its reason.
- *Human approver*: a field for the approver token, the pending approvals with payer, payee, amount and description, and Approve and Reject buttons. The token stays in component state.

Status changes are announced in an `aria-live` region. Every event is also written to the browser console.

### 3.6 Events and logs

```ts
export type Actor = "client-agent" | "server-agent" | "payment-service" | "human"
export interface ProtocolEvent {
  name: EventName
  actor: Actor
  at: string                       // ISO 8601, from the injected clock
  paymentRequestId?: string
  paymentId?: string
  data?: Record<string, string | number | boolean | null>
}
export interface EventLog { emit(event: Omit<ProtocolEvent, "at">): void }
```

`EventName` is the union of the names in the section 1 table plus `server.receipt.rejected`, `ps.settlement.failed` and `client.flow.failed`. Every protocol step emits its event through the injected `EventLog`; nothing protocol-relevant is logged another way. That is what makes "the logs show what is happening" testable.

The server writes one line per event to stdout, readable by default and JSON when `LOG_FORMAT=json`:

```
14:02:07.412 server-agent     server.payment_required.issued  pr=pr_8f2c resource=market-brief amount=5.00 USD options=stripe-usd,sandbox-usd
14:02:07.655 payment-service  ps.policy.evaluated             pr=pr_8f2c pay=pay_31aa outcome=allow rule=within_limits
```

Event data never contains a private key, a Stripe secret key, a client secret, the approver token or a complete JWT. Tokens are logged as their last 8 characters. DIDs, payment intent ids, amounts and rule names are fine.

### 3.7 Configuration

Server, read once at startup from the environment (`node --env-file=.env`). A missing or malformed required value stops the process with a message naming the variable.

| Variable | Meaning |
| :- | :- |
| `PORT` | Default `8787`. |
| `PUBLIC_BASE_URL` | Default `http://localhost:8787`. The payment service URL is this plus `/payment-service`. |
| `CLIENT_ORIGIN` | Default `http://localhost:5173`. |
| `ACME_AGENT_JWK`, `GLOBEX_AGENT_JWK`, `PAYMENT_SERVICE_JWK` | Private JWKs. Required. |
| `POLICY_ALLOWED_COUNTERPARTIES` | Comma-separated DIDs. Required; empty denies everything. |
| `POLICY_APPROVAL_THRESHOLD_MINOR` | Default `5000`. |
| `APPROVER_TOKEN` | Required, at least 24 characters. |
| `PAYMENT_REQUEST_TTL_SECONDS`, `RECEIPT_TTL_SECONDS` | Defaults `900` and `600`. |
| `SANDBOX_NETWORK` | `on` or `off`. Default `on`. |
| `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY` | Optional as a pair. Must start `sk_test_` or `rk_test_`, and `pk_test_`. Without them no Stripe option is offered. |
| `STRIPE_WEBHOOK_SECRET` | Optional, `whsec_...`. |
| `LOG_FORMAT` | `pretty` or `json`. Default `pretty`. |

`pnpm setup:env` writes a `.env` with three fresh keys, the Acme DID on the allowlist and a random approver token, and leaves the Stripe lines blank. The client needs only `VITE_API_BASE_URL`, default `http://localhost:8787`.

**Demo catalog.**

| Server agent | Resource | Price | Policy outcome |
| :- | :- | :- | :- |
| Acme `/api` | `market-brief` | $5.00 | allow |
| Acme `/api` | `annual-report` | $75.00 | needs approval |
| Globex `/partner` | `partner-feed` | $5.00 | deny, not on the allowlist |

### 3.8 ACK facts this spec relies on

Checked against `agentcommercekit@0.11.0` on 2026-11-10. PRO-2 and PRO-3 pin them so an upgrade that changes one fails loudly.

- `did:key` DIDs resolve with `getDidResolver()` with no hosting, for Ed25519, secp256k1 and secp256r1. All identities here are `did:key`.
- `createSignedPaymentRequest(init, { issuer, signer, algorithm })` returns `{ paymentRequest, paymentRequestToken }`. Unknown fields in `init` are dropped. `expiresAt` comes back as an ISO string.
- `verifyPaymentRequestToken(token, { resolver, issuer? })` checks the signature and the schema. It does not reject a past `expiresAt`.
- `createPaymentReceipt(...)` returns an unsigned credential. `signCredential(credential, { did, signer, alg })` returns the JWT string. The README shows an older signature.
- `verifyPaymentReceipt(receipt, { resolver, trustedReceiptIssuers, paymentRequestIssuer })` returns `{ receipt, paymentRequestToken, paymentRequest }`, where `receipt.issuer` is `{ id }`. It throws `UntrustedIssuerError`, `CredentialExpiredError` or `InvalidPaymentRequestTokenError`. It does not check revocation.
- `createJwt(payload, { issuer, signer, expiresIn }, { alg })` and `verifyJwt(jwt, { resolver, issuer?, audience? })` cover the initiation token. PS-2 must prove a wrong audience is rejected; if `verifyJwt` does not enforce it, compare the verified `aud` ourselves.
- `keypairToJwk` and `jwkToKeypair` round-trip a keypair.

## 4. Stripe payment option (T5)

Real Stripe in test mode, done the way Stripe recommends for a custom flow. Check the current Stripe docs for the Payment Element and PaymentIntents before writing code; this section is the intent, the docs are the detail.

- **Server creates the PaymentIntent** in `StripeAdapter.begin`, through `StripeGateway`: amount and currency from the payment record, `automatic_payment_methods: { enabled: true, allow_redirects: "never" }`, metadata `{ paymentId, paymentRequestId, paymentOptionId, payer }`, idempotency key `pi:<paymentId>`. The `NextAction` carries the client secret and the publishable key, so the browser needs no Stripe configuration.
- **Browser confirms.** `loadStripe(publishableKey)` from `@stripe/stripe-js`, memoised outside render. `<Elements options={{ clientSecret }}>` with `<PaymentElement />`. Submit calls `stripe.confirmPayment({ elements, confirmParams: { return_url }, redirect: "if_required" })`. A returned `error` is shown and the user can try again on the same PaymentIntent. Card data never touches our server and production code never confirms server-side.
- **Server verifies before issuing a receipt.** `StripeAdapter.verify` retrieves the PaymentIntent and requires `status === "succeeded"`, `amountReceived` equal to the expected amount, the expected currency and `metadata.paymentId` equal to the payment id. Anything else is `pending`, `failed` or `mismatch`. The browser's word is never the evidence.
- **Webhook.** `POST /payment-service/webhooks/stripe` reads the raw body, verifies the `Stripe-Signature` header with `STRIPE_WEBHOOK_SECRET`, handles `payment_intent.succeeded` (call `settle`) and `payment_intent.payment_failed` (fail the payment), ignores other types with `200`, and is idempotent per event id. Without a secret it answers `503` and processes nothing. Local use: `stripe listen --forward-to localhost:8787/payment-service/webhooks/stripe`. The receipt route also verifies settlement directly, so the demo works without the Stripe CLI.
- **Startup guard.** A key that is not a test-mode key stops the process.
- **Credentials.** The human supplies `STRIPE_SECRET_KEY` and `STRIPE_PUBLISHABLE_KEY`, and optionally `STRIPE_WEBHOOK_SECRET`. Ask for them when T5 starts, write them to `.env` and nowhere else, and do not echo them back.
- **Live check.** `pnpm test:stripe-live` runs `tests/stripe-live` against the real test-mode API: begin a payment, confirm the PaymentIntent with the test payment method `pm_card_visa` (a test-only shortcut that stands in for the browser), then `verify`, settle, issue and verify the receipt. It exits non-zero when the keys are missing.
- **Manual check in a browser**, recorded in the T5 hand-off: `4242 4242 4242 4242` succeeds, `4000 0025 0000 3155` succeeds after the 3D Secure challenge, `4000 0000 0000 9995` is declined with a visible message and can be retried.

## 5. Stack, layout and boundaries

TypeScript in strict mode, ESM, Node 22 or later, pnpm workspaces. Server: Hono on `@hono/node-server`. Client: Vite and React. Validation: valibot, the same library ACK uses. Tests: Vitest, with Testing Library for the React tests. Stripe: `stripe`, `@stripe/stripe-js`, `@stripe/react-stripe-js`. Take the current stable release of each at T1 and pin exact versions.

```
CLAUDE.md  .claude/                      human-owned spec and gate
README.md  docs/                         documentation for people, written task by task (section 7)
package.json  pnpm-workspace.yaml  tsconfig.base.json  eslint.config.js
vitest.config.ts  vitest.live.config.ts  .env.example
packages/
  protocol/  src/ test/                  @paywall/protocol: section 3.1 and 3.6, schemas, money helpers
  testkit/   src/                        @paywall/testkit: test doubles and fixtures, used by tests only
  server/    src/policy/                 T2  section 3.4
             src/server-agent/           T3  section 3.2
             src/payment-service/        T3  section 3.3, sandbox adapter, receipts
             src/payment-service/stripe/     T5
             src/payment-service/approvals/  T6
             src/shared/                 T3  identity, config, console log sink, in-memory stores
             src/app.ts  src/main.ts     T3  buildApp(config) and the process entry point
             test/{policy,server-agent,payment-service,stripe,approvals}/
  client/    src/agent/                  T4  section 3.5 core
             src/ui/                     T4  React app
             src/stripe/                 T5  Payment Element executor
             src/approver/               T6  approver panel
             test/{agent,ui,stripe,approvals}/
tests/e2e/{core,stripe,approval,http}/   whole-system tests
tests/stripe-live/                       real Stripe test mode, never part of `pnpm test`
```

Root scripts, which the gate calls by these names: `pnpm typecheck`, `pnpm lint`, `pnpm test` (every offline test), `pnpm test:stripe-live`, `pnpm build`, `pnpm dev` (server and client together), `pnpm setup:env`. `vitest.config.ts` at the root defines the projects so that `pnpm exec vitest run <directory>...` works from the root, with `passWithNoTests` off.

**Import boundaries**, enforced with ESLint `no-restricted-imports`:

- `protocol` imports only `agentcommercekit` and `valibot`.
- `server/src/policy` imports only types from `@paywall/protocol`.
- `server-agent` and `payment-service` do not import each other. They meet only in `app.ts`.
- `client/src/agent` imports no React, no DOM beyond `fetch` and Web Crypto, and no Stripe.
- `stripe` is imported only under `payment-service/stripe/`, and `@stripe/*` only under `client/src/stripe/`.
- `@paywall/testkit` is imported only from tests.
- Time and ids come from the injected `Clock` and `IdGenerator`. `Date.now()`, `new Date()` and `crypto.randomUUID()` appear only in the system implementations of those two interfaces.

## 6. Test suite

T1 writes all of it before any implementation exists.

**How tests are written.**

- Each acceptance criterion below has at least one test whose title starts with its ID: `it("SA-10: a receipt is delivered once", ...)`. The gate checks every ID is present.
- Test through public interfaces: `app.request(...)` on the Hono apps, the exported factories, the rendered UI. No reaching into module internals.
- Deterministic. Fixed clock, sequential ids, fixture keys, fake timers for polling. No network, no real sleeps, no order dependence.
- Real ACK cryptography everywhere. Never mock `agentcommercekit`. Negative cases use real artifacts that are wrong in one way: signed by another key, expired by the fixed clock, issued for another resource.
- Stripe is replaced at the `StripeGateway` seam on the server and by mocking `@stripe/stripe-js` and `@stripe/react-stripe-js` in client tests. Only `tests/stripe-live` talks to Stripe.
- Event assertions use the testkit's `MemoryEventLog`, and compare ordered event names.
- E2E tests wire the real client core to the real `buildApp` in process: the testkit turns `app.fetch` into a `fetch`.

**Testkit (`@paywall/testkit`).** `FixedClock` with `advance`, `SequenceIds`, `MemoryEventLog`, fixture identities (Acme, Globex, payment service, client, an untrusted issuer), `FakeStripeGateway` whose PaymentIntents a test can move to `succeeded` or alter, `inProcessFetch(app)`, and builders for signed payment requests, initiations and receipts.

**Acceptance criteria.**

Protocol, `packages/protocol/test` (green from T1):

| ID | Criterion |
| :- | :- |
| PRO-1 | Each wire schema accepts a valid example and rejects one with a missing or mistyped field. |
| PRO-2 | With `did:key` identities, a payment request, its token, a receipt and its verification round-trip through the ACK functions named in section 3.8. |
| PRO-3 | The ACK facts hold: unknown request fields are dropped, a past `expiresAt` still verifies, a receipt from an untrusted issuer throws `UntrustedIssuerError`, an expired receipt throws `CredentialExpiredError`. |
| PRO-4 | Money helpers format and compare minor units with integer arithmetic: 5000 is "$50.00", and no float appears. |

Spend policy, `packages/server/test/policy` (T2):

| ID | Criterion |
| :- | :- |
| POL-1 | An allowlisted counterparty and an amount under the threshold is allowed. |
| POL-2 | Exactly 5000 is allowed and 5001 needs approval, with the threshold in the decision. |
| POL-3 | A counterparty off the list is denied at any amount, including above the threshold. |
| POL-4 | An empty allowlist denies everything. |
| POL-5 | Another currency or another `decimals` is denied `currency_not_supported`. Zero, negative, fractional, unsafe or non-number amounts are denied `invalid_amount`. |
| POL-6 | The function is deterministic and never throws: the same input gives a deep-equal decision across repeated calls and under a changed system clock, and DID comparison is exact and case-sensitive. |
| POL-7 | `parseSpendPolicyConfig` applies the defaults and throws on a malformed DID, a negative threshold or a missing allowlist variable. |

Server agent, `packages/server/test/server-agent` (T3):

| ID | Criterion |
| :- | :- |
| SA-1 | A paywalled route without a receipt answers 402 with a body matching `PaymentRequiredBody` and `Cache-Control: no-store`. |
| SA-2 | The token verifies with `verifyPaymentRequestToken`, its issuer is the server agent DID, and its payload equals the `paymentRequest` in the body. |
| SA-3 | The request has a new `id` on every 402, `expiresAt` equal to now plus the TTL, the resource title as description, and one option per configured network with the fields of section 3.2. |
| SA-4 | A valid receipt in `Payment-Receipt` answers 200 with the resource. |
| SA-5 | A receipt signed by an untrusted issuer answers 402 `receipt_untrusted_issuer` with a fresh request. |
| SA-6 | A tampered receipt, a non-JWT value and a credential of another type each answer 402 `receipt_invalid`. |
| SA-7 | An expired receipt answers 402 `receipt_expired`. |
| SA-8 | A valid receipt for another resource answers 402 `receipt_wrong_resource`. |
| SA-9 | A receipt whose payment request token was signed by another server agent, or whose request id was never issued here, answers 402 `receipt_invalid`. |
| SA-10 | A receipt is delivered once: the second presentation answers 402 `receipt_already_redeemed`, and two concurrent presentations deliver exactly once. |
| SA-11 | A receipt naming an option id that is not in its payment request answers 402 `receipt_invalid`. |
| SA-12 | An unknown resource answers 404, and the catalog route answers 200 without payment. |
| SA-13 | A preflight from `CLIENT_ORIGIN` allows the `Payment-Receipt` header; another origin gets no CORS grant. |
| SA-14 | The happy path emits `server.request.received`, `server.payment_required.issued`, then on retry `server.request.received`, `server.receipt.presented`, `server.receipt.verified`, `server.resource.delivered`. A rejection emits `server.receipt.rejected` with the code. No event contains a complete JWT. |

Payment service, `packages/server/test/payment-service` (T3):

| ID | Criterion |
| :- | :- |
| PS-1 | A valid initiation for the sandbox option answers 201 with a `PaymentView` in `requires_payment` and `next.type` of `sandbox_settle`. |
| PS-2 | An initiation with a bad signature, a wrong audience, an expiry more than 300 s out or a missing claim answers 400 `invalid_initiation`. |
| PS-3 | A payment request token with a bad signature answers 400 `payment_request_invalid`; one past its `expiresAt` answers 410 `payment_request_expired`. |
| PS-4 | An unknown option id answers 400 `payment_option_unknown`. An option naming another payment service, another receipt service, a network with no adapter or a string amount answers 400 `payment_option_unsupported`. |
| PS-5 | Repeating an initiation for the same payer, request and option answers 200 with the same `paymentId` and starts no second settlement. |
| PS-6 | After the sandbox settle call the receipt route answers 200 with a JWT that `verifyPaymentReceipt` accepts: issuer is the payment service, subject is the payer, it embeds the same token and option id, carries the metadata of section 3.3 and expires at settlement plus the TTL. |
| PS-7 | The receipt route answers 409 `payment_not_settled` before settlement and 404 for an unknown payment. |
| PS-8 | Asking for the receipt again returns the identical JWT. |
| PS-9 | The settled amount and the receipt metadata come from the token: extra `amount`, `currency` or `payee` fields in the request body or the initiation claims change nothing. |
| PS-10 | A policy `deny` answers 403 `policy_denied` with the rule, stores no payment and calls no adapter. |
| PS-11 | A policy `needs_approval` answers 202 with `pending_approval` and an `approvalId`, and calls no adapter. |
| PS-12 | While a payment is `pending_approval`, the sandbox settle route answers 409 and the receipt route answers 409. |
| PS-13 | The happy path emits `ps.payment.initiated`, `ps.policy.evaluated`, `ps.settlement.started`, `ps.settlement.confirmed`, `ps.receipt.issued` in order, with the policy outcome and rule in the data. |

Client agent core, `packages/client/test/agent` (T4):

| ID | Criterion |
| :- | :- |
| CL-1 | A 200 on the first request returns the resource and contacts no payment service. |
| CL-2 | On a 402 the client verifies the token and works from the verified payload. A body whose unsigned request differs fails `payment_request_mismatch` and pays nothing. |
| CL-3 | A token with a bad signature fails `payment_request_invalid` and pays nothing. |
| CL-4 | An expired request fails `payment_request_expired` and pays nothing. |
| CL-5 | Option selection is deterministic: the default prefers `stripe` over `sandbox` among networks with an executor, and no supported network fails `no_supported_option`. |
| CL-6 | The initiation is a JWT signed by the client DID with the option's `paymentService` as audience, at most 300 s to expiry, and the token and option id as claims. |
| CL-7 | The sandbox happy path ends in `delivered` with the resource and the receipt, having retried exactly once with the receipt header. |
| CL-8 | A receipt from another issuer, for another token or for another subject fails `receipt_invalid` and is not presented. |
| CL-9 | `pending_approval` is polled at the configured interval: approval continues to payment, rejection fails `approval_rejected`, and the timeout fails `approval_timeout`. |
| CL-10 | A 403 `policy_denied` fails `policy_denied` with the rule in the details. |
| CL-11 | A 402 on the retry fails `payment_not_accepted`; the client never initiates a second payment in one call. |
| CL-12 | The happy path emits the client events of section 1 in order, and `subscribe` observes each `FlowStatus` in order. |
| CL-13 | Aborting the signal stops polling and fails `aborted`. |

Client UI, `packages/client/test/ui` (T4):

| ID | Criterion |
| :- | :- |
| UI-1 | The catalog lists the resources of both server agents with formatted prices; Fetch starts a run. |
| UI-2 | After a 402 the page shows the payee DID, the description, the amount and every option, with the selected option marked. |
| UI-3 | The timeline shows one row per event, in order, with a readable label. |
| UI-4 | After delivery the page shows the receipt's issuer, payer, option and expiry, and the resource content. |
| UI-5 | A failed run shows the failure code and reason, and a control that resets the run. Status changes reach an `aria-live` region. |

Stripe, `packages/server/test/stripe`, `packages/client/test/stripe`, `tests/stripe-live` (T5):

| ID | Criterion |
| :- | :- |
| STR-1 | Initiating the Stripe option creates one PaymentIntent with the token's amount and currency, automatic payment methods without redirects, the metadata of section 4 and the idempotency key `pi:<paymentId>`. The view's `next` is `stripe_payment_element` with the client secret and publishable key. |
| STR-2 | With the PaymentIntent `succeeded` and matching, the receipt route issues a receipt whose `settlementRef` is the PaymentIntent id. |
| STR-3 | With the PaymentIntent in `requires_payment_method` or `processing`, the receipt route answers 409 `payment_not_settled`. |
| STR-4 | A succeeded PaymentIntent with a different amount, currency or `metadata.paymentId` answers 409 `settlement_mismatch` and issues nothing. |
| STR-5 | A correctly signed `payment_intent.succeeded` webhook settles the payment; delivering the same event again changes nothing; `payment_intent.payment_failed` fails the payment. |
| STR-6 | A webhook with a bad or missing signature answers 400 and changes nothing. With no webhook secret the route answers 503. |
| STR-7 | Config rejects live-mode keys and a secret key without a publishable key. With no Stripe keys the server starts and payment requests offer no Stripe option. |
| STR-8 | No event and no log line contains the Stripe secret key or a client secret. |
| STR-9 | The browser executor mounts the Payment Element with the client secret, calls `confirmPayment` with `redirect: "if_required"`, resolves on success, and on an error shows the message and lets the user submit again. |
| STR-10 | Live: against Stripe test mode a payment begins, the PaymentIntent is confirmed with `pm_card_visa`, settlement verifies and the issued receipt verifies. |

Approval flow, `packages/server/test/approvals`, `packages/client/test/approvals` (T6):

| ID | Criterion |
| :- | :- |
| APR-1 | The approver routes answer 401 without the bearer token, with a wrong token, and with a JWT signed by the client agent. |
| APR-2 | The pending list shows each waiting payment with payer, payee, amount and description. |
| APR-3 | Approving moves the payment to `requires_payment`, calls `adapter.begin` exactly once, sets `next`, and emits `ps.approval.decided` then `ps.settlement.started`. |
| APR-4 | Rejecting moves the payment to `rejected`; the settle and receipt routes then answer 409. |
| APR-5 | A second decision on the same approval answers 409 `approval_already_decided` and changes nothing. |
| APR-6 | Deciding after the payment request expired answers 410 and the payment is `failed`. |
| APR-7 | Initiating again after a rejection returns the same rejected payment; no new approval is created. |
| UI-6 | The approver panel lists pending approvals once a token is entered; Approve and Reject call the decision route and the list updates. A 401 shows an error. |
| UI-7 | While a payment waits, the agent run shows that it is waiting for a human, and continues or fails when the decision arrives. |

End to end, `tests/e2e` (real client core, real `buildApp`, fake Stripe gateway):

| ID | Criterion | Directory |
| :- | :- | :- |
| E2E-1 | `market-brief` over the sandbox network: 402, payment, receipt, 200. The merged event sequence follows the section 1 table. | `core` |
| E2E-2 | Presenting the same receipt a second time is refused. | `core` |
| E2E-3 | `partner-feed` from Globex is denied by policy; nothing settles and nothing is delivered. | `core` |
| E2E-4 | `market-brief` over Stripe with the fake gateway: the PaymentIntent succeeds, the receipt is issued, 200. | `stripe` |
| E2E-5 | `annual-report`: the payment waits, the approver approves, the payment completes, 200. | `approval` |
| E2E-6 | `annual-report`: the approver rejects; the client ends `approval_rejected` and the resource is never delivered. | `approval` |
| E2E-7 | The server on a real ephemeral port with real `fetch`, CORS included, runs E2E-1 and E2E-5 through `buildApp` configured only from environment-style config. | `http` |

## 7. Tasks

Seven tasks. If `TaskList` does not already show them, create them with these exact subjects and wire the blocked-by links; the gate reads the `T<n>:` prefix.

| Task | Subject | Blocked by | Owns |
| :- | :- | :- | :- |
| T1 | `T1: Test suite, contracts and scaffold` | none | root config, `packages/protocol`, `packages/testkit`, every test directory, stubs, first `README.md` |
| T2 | `T2: Spend policy engine` | T1 | `packages/server/src/policy` |
| T3 | `T3: Server agent and payment service` | T1, T2 | the rest of `packages/server/src` except `stripe/` and `approvals/` |
| T4 | `T4: Client agent and UI` | T3 | `packages/client/src/agent`, `packages/client/src/ui` |
| T5 | `T5: Stripe payment option` | T4 | `payment-service/stripe`, `client/src/stripe`, their wiring |
| T6 | `T6: Human approval flow` | T4 | `payment-service/approvals`, `client/src/approver`, their wiring |
| T7 | `T7: Integration and demo` | T5, T6 | `README.md`, `tests/e2e/http` wiring, fixes anywhere |

```
T1 ─▶ T2 ─▶ T3 ─▶ T4 ─┬─▶ T5 ─┬─▶ T7
                       └─▶ T6 ─┘
```

T5 and T6 can run at the same time only in separate git worktrees, because both touch `app.ts` and the client's root component. The second to finish merges `main` into its branch and passes its gate again before it is merged. Everything else runs one at a time in the main checkout.

### Documentation

Documentation is written in the task that builds the thing, not saved for the end. Each task owns the documents below and finishes them before it closes.

| Task | Writes |
| :- | :- |
| T1 | `README.md` first version: what the project is, prerequisites, install, the root scripts, the repository layout, and a "What works today" list. `docs/protocol.md`: every route, body, error code and event of the wire contract. `docs/testing.md`: how to run the tests, how they are organised, what the acceptance IDs are, what the testkit provides. `docs/decisions.md`, started. A comment for every variable in `.env.example`. |
| T2 | `docs/policy.md`: the rules in the order they apply, a table of example inputs and the decision each gets, and how to configure the allowlist and threshold. |
| T3 | `docs/server.md`: the server agents and the payment service, each route with an example request and response, the configuration table, how to start the server, and a real log excerpt from one paid request with each line explained. |
| T4 | `docs/client.md`: the flow states, what each region of the page shows, how the agent's identity is stored and why that is demo-grade. `docs/architecture.md`: the roles, who holds which key, and a sequence diagram that maps each ACK step to the code and the event it emits. README: how to run the sandbox demo. |
| T5 | `docs/stripe.md`: getting test-mode keys, where they go, the webhook with the Stripe CLI, the test cards, what the server verifies before it issues a receipt, and how to run the live test. |
| T6 | `docs/approvals.md`: who the approver is, the approver routes, a walk-through of the panel, and what happens on approve, reject and expiry. |
| T7 | README finished: quickstart from a fresh clone, the three demo scenarios step by step, links to every page in `docs/`. Every earlier document read against the running system and corrected. |

Rules for all of it:

- **In the code.** Every exported type, function and constant in `packages/protocol`, and every exported function, factory and interface elsewhere, has a TSDoc comment: one sentence on what it is for, then whatever a caller cannot see from the signature (units, who may call it, what happens on failure). Other comments say why, not what. Do not restate the code.
- **For a reader who has never seen this file.** The README and `docs/` stand alone. They do not point at `CLAUDE.md`, and neither code nor docs cite its section numbers or the task numbers. The two exceptions are the `spec-fix(T<n>)` marker in tests and the `NotImplementedError("T<n>")` stubs.
- **Only what exists.** A document describes what works at the end of the task that wrote it. No placeholders and no "coming soon". The README's "What works today" list grows task by task.
- **Checked, not imagined.** Every command, request and response shown in a document was run, and pasted output is real output with secrets removed. Example values for secrets are obvious placeholders.
- **Keep earlier documents true.** A task that changes behaviour another task documented updates that document in the same task. That is the one case where editing a document you do not own is expected.
- **Decisions.** When you make a choice this spec left open, add an entry to `docs/decisions.md`: what was decided, why, and what was rejected. Three or four lines each, newest last.
- **Short.** About a page per document. Link to another page instead of repeating it.

### Task briefs

**T1: Test suite, contracts and scaffold.** Set up the workspace of section 5 with the root scripts. Implement `@paywall/protocol` fully: types, schemas, constants, event names, money helpers. Implement `@paywall/testkit`. Write every test in section 6. Create each exported function and factory of section 3 as a stub with its final signature and a body that throws `NotImplementedError("T<n>")`; stubs contain no logic. Add `.env.example`. Done when the protocol tests pass, everything typechecks and lints, every acceptance ID has a test, every other test directory fails because of the stubs, and the T1 documents are written.

**T2: Spend policy engine.** Implement `evaluateSpend` and `parseSpendPolicyConfig` as section 3.4 specifies. Nothing else in code. Done when POL-1 to POL-7 pass and `docs/policy.md` is written.

**T3: Server agent and payment service.** Implement `createServerAgent`, `createPaymentService` with the sandbox adapter and receipt issuance, the in-memory stores, config parsing, identity loading, the console log sink, `buildApp`, `main.ts` and `pnpm setup:env`. Wire the real policy from T2. Implement policy `deny` and the creation of `pending_approval` payments; the approver routes are T6, so until then a payment above $50 waits forever, which is the safe behaviour. Done when SA-1 to SA-14 and PS-1 to PS-13 pass and `docs/server.md` is written from a real run.

**T4: Client agent and UI.** Implement `createPaywallClient`, the sandbox executor, the browser identity, and the React page with the catalog and agent run regions. Confirm `vite build` works with `agentcommercekit` in the bundle and note any polyfill it needed. Done when CL-1 to CL-13, UI-1 to UI-5 and E2E-1 to E2E-3 pass, the sandbox flow works in a browser against `pnpm dev`, and `docs/client.md`, `docs/architecture.md` and the README's demo instructions are written.

**T5: Stripe payment option.** Implement section 4: the real `StripeGateway`, the Stripe adapter, the webhook route, config guards, the browser executor with the Payment Element, and the live test. Ask the human for the test-mode keys at the start. Done when STR-1 to STR-9 and E2E-4 pass, `pnpm test:stripe-live` passes (STR-10), the three manual card checks of section 4 are recorded in the hand-off, and `docs/stripe.md` is written.

**T6: Human approval flow.** Implement the approver routes, the approve, reject and expiry transitions, and the approver panel. Done when APR-1 to APR-7, UI-6, UI-7, E2E-5 and E2E-6 pass and `docs/approvals.md` is written.

**T7: Integration and demo.** Make the whole suite green on the merged result, including E2E-7 and the build. Run all three catalog scenarios in a browser. Finish `README.md`: quickstart from a fresh clone, `pnpm setup:env`, `pnpm dev`, the three demo scenarios, how to add Stripe keys, how to read the logs, and links to every page in `docs/`. Read every document in `docs/` against the running system and correct what has drifted. Remove any leftover stub or `NotImplementedError`. Done when the full gate passes and the documentation matches the system.

**Hand-off.** When you finish a task, say what you built, which documents you wrote or updated, any `spec-fix` test changes and why, anything in the spec you found ambiguous, and what you verified by hand.

## 8. The gate

`.claude/settings.json` registers a `TaskCompleted` hook, `.claude/hooks/task-completed.sh`. It runs whenever a task is marked completed and applies to tasks whose subject starts with `T1:` to `T7:`. A non-zero result exits with code 2: the task stays open and the reason comes back to the agent that tried to close it.

It runs, in order, stopping at the first failure:

1. **Preconditions.** A baseline commit exists; the diff is not empty; the diff does not touch `CLAUDE.md` or `.claude/`; no test is focused, skipped or marked todo.
2. **Deterministic checks.** `pnpm typecheck`, `pnpm lint`, then the tests for the task and for every task it depends on:

   | Task | Must pass |
   | :- | :- |
   | T1 | Every acceptance ID is named by a test. Protocol tests pass. Every other test directory exists and fails. |
   | T2 | protocol, policy |
   | T3 | the above, server-agent, payment-service |
   | T4 | the above, client agent, client ui, `tests/e2e/core` |
   | T5 | the above, server stripe, client stripe, `tests/e2e/stripe`, then `pnpm test:stripe-live` |
   | T6 | T4's set, server approvals, client approvals, `tests/e2e/approval` |
   | T7 | Every acceptance ID is named. `pnpm test`, `pnpm build`, `pnpm test:stripe-live`. |

3. **Reviewer.** The `reviewer` agent (`.claude/agents/reviewer.md`) reads the task's diff against this spec and returns pass or fail with findings. A fail blocks. No verdict also blocks.

Logs, the reviewed diff and the verdict are written to `.gate/`.

**Working with it.**

- Before the first task, the spec and harness are committed as the baseline. The gate refuses to run without it.
- Run the deterministic part yourself before closing a task: `.claude/hooks/task-completed.sh --task T3 --tests-only`.
- Close a task with `TaskUpdate` status `completed`. If the agent doing the work has no task tools, the lead closes it; the gate runs either way.
- Do not commit task work to `main` before its gate passes. The gate reviews the uncommitted changes against `HEAD` on `main`, or everything since the branch point on a task branch.
- When the gate passes, the lead commits the task as one commit, `T<n>: <subject>`, or merges the task branch. Then the next task starts.
- If the gate fails for a reason that is not your work (the reviewer cannot run, the gate maps a directory wrongly, the spec contradicts itself), stop and tell the human. Do not work around it.

## 9. Decisions worth knowing

These were choices, not requirements. Change the spec, not the code, if one is wrong.

| Decision | Why |
| :- | :- |
| The allowlist is checked against the payee, the DID that issued the payment request. | A spend policy guards the payer's money, so the counterparty is who gets paid. |
| The policy runs in the payment service, before any PaymentIntent exists. | It is server-side, cannot be skipped by the browser, and matches where ACK places pre-execution approval. |
| Receipts are single-use. | The payment request `id` exists to prevent replay. A paid call is delivered once. |
| A sandbox network exists beside Stripe. | The client has a real choice of option, and the flow is testable before Stripe credentials exist. |
| All identities are `did:key`. | Verifiable offline and in the browser with no DID hosting. |
| The client is built after the server, not beside it. | Its done-criteria include end-to-end tests against the real server. |
| Payment service and receipt service are one service with one DID. | Smallest thing that keeps the roles honest: the server agent trusts it only by DID and signature. |
