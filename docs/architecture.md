# Architecture

The paywall follows the [ACK-Pay server-initiated sequence](https://www.agentcommercekit.com/ack-pay/server-initiated-sequence.md). Four roles take part; three run in one Node process and one in the browser. They share no code paths and trust each other only through signed ACK artifacts and DIDs.

```
Browser (Vite, :5173)                     Node process (:8787)
┌──────────────────────────┐   HTTP   ┌───────────────────────────────────────┐
│ Client agent (did:key)   │─────────▶│ /api              Acme server agent   │
│  agent core + React page │          │ /partner          Globex server agent │
└──────────────────────────┘─────────▶│ /payment-service  payment + receipt   │
                                      │   service: policy, sandbox settlement │
                                      └───────────────────────────────────────┘
```

## Roles and keys

| Role | Code | Key | Where the key lives | Signs |
| :- | :- | :- | :- | :- |
| Client agent | `packages/client/src/agent` | Ed25519 `did:key` | Generated in the browser, kept in `localStorage` ([demo-grade](client.md#the-agents-identity)) | payment initiations |
| Acme server agent | `packages/server/src/server-agent` at `/api` | `did:key` | `ACME_AGENT_JWK` in `.env` | payment requests |
| Globex server agent | the same code at `/partner` | `did:key` | `GLOBEX_AGENT_JWK` in `.env` | payment requests |
| Payment service, also the receipt service | `packages/server/src/payment-service` | `did:key` | `PAYMENT_SERVICE_JWK` in `.env` | receipts |
| Human approver | `packages/client/src/approver` (panel), `packages/server/src/payment-service/approvals` (routes) | none: a bearer token, `APPROVER_TOKEN` | `.env` on the server; the person pastes it into the panel, which keeps it in memory only. The client agent never has it | nothing; decides payments over the threshold |

Who trusts whom:

- The client trusts a payment request only if its token verifies; the token's issuer is the payee. It trusts a receipt only from the `receiptService` DID named in the option it paid.
- A server agent trusts receipts only from the payment service DID it was configured with, and only for payment requests it issued itself.
- The payment service trusts the payer's identity from the initiation's signature, and takes amount, currency and payee only from the verified payment request token. The [spend policy](policy.md) checks the payee against an allowlist before any money moves.

Every DID is a `did:key`, so everything verifies offline, including in the browser.

## The sequence

Each arrow is an HTTP call; the notes name the code and the events it emits. A payment over $50 waits at step 4 until the human approver decides it in the approver panel ([approvals.md](approvals.md)); the client polls meanwhile and gives up after five minutes. A payee off the allowlist gets `403 policy_denied` at step 4 and nothing is paid.

```mermaid
sequenceDiagram
    autonumber
    participant C as Client agent<br/>client/src/agent/client.ts
    participant S as Server agent<br/>server/src/server-agent
    participant P as Payment service<br/>server/src/payment-service
    participant H as Human approver<br/>client/src/approver

    C->>S: GET /api/resources/:id (no receipt)
    Note over C,S: 1. client.request.sent, server.request.received
    S-->>C: 402 { paymentRequest, paymentRequestToken }
    Note over C,S: 2. server.payment_required.issued (createSignedPaymentRequest)<br/>client.payment_required.received, client.payment_request.verified (verifyPaymentRequestToken)
    C->>P: POST /payment-service/payments { initiation JWT }
    Note over C,P: 3. client.option.selected, client.payment.initiated (createJwt)<br/>ps.payment.initiated (verifyJwt, verifyPaymentRequestToken)
    Note over P: 4. ps.policy.evaluated (evaluateSpend)
    opt amount over $50
        P-->>C: 202 pending_approval
        Note over P,C: ps.approval.requested, client.approval.waiting
        loop every second
            C->>P: GET /payments/:id
        end
        H->>P: POST /payment-service/approvals/:id/decision (Bearer approver token)
        Note over H,P: ps.approval.decided (actor human)<br/>approve: adapter.begin, then requires_payment; reject: the run ends approval_rejected
    end
    P-->>C: requires_payment, next = sandbox_settle (201, or the poll after approval)
    Note over P: 5. ps.settlement.started (adapter.begin)
    C->>P: POST /payments/:id/sandbox/settle
    Note over C,P: client.payment.executing (sandbox executor)<br/>ps.settlement.confirmed (settle, adapter.verify)
    C->>P: POST /payments/:id/receipt
    P-->>C: 200 { receipt }
    Note over C,P: 6. ps.receipt.issued (createPaymentReceipt, signCredential)<br/>7. client.receipt.received, client.receipt.verified (verifyPaymentReceipt)
    C->>S: GET /api/resources/:id, Payment-Receipt: <receipt>
    Note over C,S: 8. client.request.retried, server.request.received,<br/>server.receipt.presented, server.receipt.verified (verifyPaymentReceipt, store.redeem)
    S-->>C: 200 resource
    Note over C,S: 9. server.resource.delivered, client.resource.received
```

| ACK step | Client (`client.ts`) | Server agent | Payment service |
| :- | :- | :- | :- |
| 1. Request | `fetchPaid`, first `GET` | `GET /resources/:id` | |
| 2. Payment request | `verifyPaymentRequestToken`, mismatch and expiry checks | `paymentRequired`: `createSignedPaymentRequest`, saved to the request store | |
| 3. Select and initiate | `selectOption`, `createJwt`, `POST /payments` | | `initiate`: verify initiation and token, check the option |
| 4. Negotiation | `waitForDecision` polls while `pending_approval`; `403` ends the run `policy_denied` | | `evaluateSpend`; `deny` answers `403`, `needs_approval` holds the payment as `pending_approval` until `createApproverRoutes` records the human's decision |
| 5. Execution | the executor for the network (`createSandboxExecutor`) | | `begin` when the policy allows or the human approves; `settle` on the settle route |
| 6. Receipt generation | | | `issue`: `createPaymentReceipt`, `signCredential`, once per payment |
| 7. Receipt delivery | `verifyReceipt`: issuer, token, option and subject | | `POST /payments/:id/receipt` |
| 8. Present receipt | retry with `Payment-Receipt` | `checkReceipt`: `verifyPaymentReceipt`, issued here, right resource, known option, `redeem` | |
| 9. Delivery | `delivered` | `200` with the resource | |

On a failure the client emits `client.flow.failed`, the server agent `server.receipt.rejected`, and the payment service `ps.settlement.failed`. The routes and bodies are in [protocol.md](protocol.md), the server side in [server.md](server.md) and the client side in [client.md](client.md).
