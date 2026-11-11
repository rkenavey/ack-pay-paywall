# Client

The client (`packages/client`) is a browser page with an agent inside it. The agent core (`src/agent`) speaks the protocol and has no React, no DOM beyond `fetch` and Web Crypto, and no Stripe; the page (`src/ui`) renders what the core does. The end-to-end tests drive the same core in Node.

## Running it

```sh
pnpm setup:env   # once
pnpm dev         # server on :8787, page on http://localhost:5173
```

The page talks to `VITE_API_BASE_URL` (default `http://localhost:8787`). `pnpm build` writes the production bundle to `packages/client/dist`; the server's `CLIENT_ORIGIN` must be the origin the page is served from.

## What the agent does

`createPaywallClient(deps).fetchPaid(url)` fetches a URL and pays for it when it answers `402`. It resolves with the final state, `delivered` or `failed`, and never rejects for protocol failures. One call pays at most once.

1. **Request.** `GET url`. A `200` is delivered as is.
2. **Verify the payment request.** The `402` body must be a payment-required body. The agent verifies `paymentRequestToken` with ACK's `verifyPaymentRequestToken` and works only from the verified payload; its issuer is the payee. If the unsigned `paymentRequest` in the body differs from the signed one, or the request's `expiresAt` has passed, nothing is paid.
3. **Select an option.** Among the options on a network the agent has an executor for, `stripe` is preferred over `sandbox`.
4. **Initiate.** The agent signs a JWT with its own DID (`aud` the option's `paymentService`, 300 s to expiry, claims `paymentRequestToken` and `paymentOptionId`) and POSTs it to `{paymentService}/payments`.
5. **Wait for a human** if the payment is `pending_approval`: it polls `GET /payments/:id` every second for up to five minutes.
6. **Pay.** For `requires_payment` it runs the executor for the network. The sandbox executor calls `POST /payments/:id/sandbox/settle`.
7. **Receipt.** `POST /payments/:id/receipt`, then `verifyPaymentReceipt` with the option's `receiptService` as the only trusted issuer and the payee as the payment request issuer. The receipt must embed the token it paid, name the option it chose, and be issued to its own DID.
8. **Retry** the original request once with `Payment-Receipt: <receipt>`. A second `402` ends the run.

### Flow states

| Status | Meaning |
| :- | :- |
| `idle` | No run yet. |
| `requesting` | First request sent. |
| `verifying_request` | Got a `402`, checking the payment request. |
| `selecting_option` | Choosing an option. |
| `initiating` | Sending the signed initiation. |
| `awaiting_approval` | The payment service is waiting for a human. |
| `paying` | The executor is paying. |
| `fetching_receipt` | Asking for and verifying the receipt. |
| `retrying` | Presenting the receipt. |
| `delivered` | Got the resource. |
| `failed` | Stopped; `failure.code` says why. |

| Failure code | When |
| :- | :- |
| `payment_request_invalid` | The `402` body is malformed or its token does not verify. |
| `payment_request_mismatch` | The unsigned request differs from the signed token. |
| `payment_request_expired` | The request's `expiresAt` has passed, or the payment service answered `410`. |
| `no_supported_option` | No option on a network the agent can pay on. |
| `policy_denied` | The payment service refused by policy; `details.rule` names the rule. |
| `approval_rejected`, `approval_timeout` | The human rejected, or nobody decided in time. |
| `payment_failed` | The executor threw, or the payment service reports the payment failed. |
| `receipt_invalid` | The receipt does not verify, or is for another token, option or payer. It is never presented. |
| `payment_not_accepted` | The server agent answered `402` to the receipt; `details.code` says why. |
| `http_error` | Any other unexpected status, body or network error. |
| `aborted` | The caller's `AbortSignal` fired. |

Each step emits a `client.*` event (see [protocol.md](protocol.md#events)); a failed run ends with `client.flow.failed` carrying the code. Tokens appear in event data only as their last 8 characters.

## The page

- **Catalog.** The free catalogs of Acme (`/api`) and Globex (`/partner`), with prices and a Fetch button per resource. Fetch starts a run; buttons are disabled while one is in progress.
- **Agent run.** The current status in an `aria-live` region (it says "waiting for a human" while a payment awaits approval), the resource URL, a Reset button, and:
  - a *Timeline* with one row per event: UTC time, readable label and event name;
  - the *Payment request* once verified: payee DID, description, amount, request id, expiry, and every option with the selected one marked;
  - the *Receipt* once verified: issuer, payer, option, expiry and the token's last 8 characters;
  - the delivered content, or the failure code, its message and any details such as the policy rule.

Every event is also written to the browser console as `[paywall] <time> <actor> <event> pr=… pay=…`, followed by the event object.

## The agent's identity

On first load the page generates an Ed25519 key with ACK's `generateKeypair`, stores the private JWK in `localStorage` under `paywall.client-agent.jwk`, and derives a `did:key` DID from it. Later loads reuse it, so the agent keeps its DID across reloads; clearing site data gives it a new one. The DID is shown at the top of the page.

This is demo-grade key storage, and the page says so: any script running on the page can read `localStorage`, so a cross-site scripting bug would leak the key. A real agent would keep its key in a non-extractable Web Crypto key, a wallet or a server-side signer.

The agent has no spending authority of its own: the spend policy runs in the payment service, and approvals need the approver token, which the agent never has.
