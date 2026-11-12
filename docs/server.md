# Server

One Node process (`packages/server`) serves three roles. Each has its own `did:key` identity and its own routes. They share no code paths and exchange only ACK artifacts:

| Mounted at | Role | Signs |
| :- | :- | :- |
| `/api` | **Acme** server agent: `market-brief` ($5.00), `annual-report` ($75.00) | payment requests |
| `/partner` | **Globex** server agent: `partner-feed` ($5.00). Its DID is not on the default allowlist. | payment requests |
| `/payment-service` | **Payment service**, also the receipt service: verifies initiations, applies the [spend policy](policy.md), settles, signs receipts | receipts |

The bodies and error codes are listed in [protocol.md](protocol.md). This page shows them on a running server. State is kept in memory and is lost on restart.

## Starting it

```sh
pnpm setup:env   # once: writes .env with three fresh keys, the Acme DID on the allowlist and an approver token
pnpm --filter @paywall/server start   # or `pnpm dev` for server and client together, restarting on change
```

`pnpm setup:env` prints only the public DIDs, writes `.env` readable by you alone, and refuses to overwrite an existing `.env`. On start the server prints its URLs and DIDs to standard error. Protocol events go to standard output.

```
Paywall server listening on port 8787, public URL http://localhost:8787
  Acme server agent      http://localhost:8787/api      did:key:z6MkuJMwxReQ1rMfAHGDTu7LcfFyyszSRJeuJ7rEmFJbfSaG
  Globex server agent    http://localhost:8787/partner  did:key:z6MkkbJtmshcJxmxkbStQBjeDd8PU35QQgjtQPYctkxYa8gw
  Payment service        http://localhost:8787/payment-service  did:key:z6Mkn9h1i6X7d6WtYS6xivwATgQGTtE3v8PpJzvQeUbUKmDn
  Networks: sandbox; CORS origin http://localhost:5173
```

A missing or malformed variable stops the process with exit code 1. The message names the variable and never shows its value: `Configuration error: ACME_AGENT_JWK is required`.

## Configuration

Read once at startup from the environment (`node --env-file=.env`). Each variable is described in `.env.example`. An empty value means the same as an unset one.

| Variable | Default | Rules |
| :- | :- | :- |
| `PORT` | `8787` | 0 to 65535. |
| `PUBLIC_BASE_URL` | `http://localhost:8787` | The payment service URL in every payment option is this plus `/payment-service`. |
| `CLIENT_ORIGIN` | `http://localhost:5173` | An origin with no path. The only origin CORS answers. |
| `ACME_AGENT_JWK`, `GLOBEX_AGENT_JWK`, `PAYMENT_SERVICE_JWK` | required | Private JWKs as one-line JSON (Ed25519, secp256k1 or secp256r1), three different keys. |
| `POLICY_ALLOWED_COUNTERPARTIES`, `POLICY_APPROVAL_THRESHOLD_MINOR` | required, `5000` | See [policy.md](policy.md). |
| `APPROVER_TOKEN` | required | At least 24 characters. |
| `PAYMENT_REQUEST_TTL_SECONDS`, `RECEIPT_TTL_SECONDS` | `900`, `600` | 1 to 86400. |
| `SANDBOX_NETWORK` | `on` | `on` or `off`. |
| `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` | unset | Both keys or neither; test-mode keys only (`sk_test_`/`rk_test_`, `pk_test_`, `whsec_`). Live keys stop the process. |
| `LOG_FORMAT` | `pretty` | `pretty` or `json`. |

The server needs at least one payment network: `SANDBOX_NETWORK=off` without Stripe keys is refused. The sandbox network moves no money. With Stripe keys the server also offers a `stripe-usd` option settled through Stripe test mode; [stripe.md](stripe.md) covers the keys, the checks before a receipt and the webhook.

## Server agent routes

`GET /api/resources` is free:

```
$ curl -s http://localhost:8787/api/resources
{"resources":[{"id":"market-brief","title":"Market brief","price":{"amount":500,"decimals":2,"currency":"USD"}},{"id":"annual-report","title":"Annual report","price":{"amount":7500,"decimals":2,"currency":"USD"}}]}
```

`GET /api/resources/:id` without a receipt answers 402 with a signed payment request. Each 402 has a new id and expires after `PAYMENT_REQUEST_TTL_SECONDS`. Tokens and DIDs below are shortened with `…`:

```
$ curl -si http://localhost:8787/api/resources/market-brief
HTTP/1.1 402 Payment Required
cache-control: no-store
content-type: application/json

{"paymentRequest":{"id":"pr_8a163a14c4c82feea262ab4cbf428bf2","description":"Market brief",
 "expiresAt":"2026-11-11T19:05:28.424Z","paymentOptions":[{"id":"sandbox-usd","amount":500,"decimals":2,
 "currency":"USD","recipient":"did:key:z6MkuJMw…","network":"sandbox",
 "paymentService":"http://localhost:8787/payment-service","receiptService":"did:key:z6Mkn9h1…"}]},
 "paymentRequestToken":"eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJpYXQiOjE3OTQ0MjMwMjgs…"}
```

With `Payment-Receipt: <receipt JWT>` it answers `200 {"id","title","content"}` once. Every rejected receipt answers 402 with a fresh payment request and the reason:

```
$ curl -s http://localhost:8787/api/resources/market-brief -H "Payment-Receipt: $RECEIPT"   # second time
{"paymentRequest":{"id":"pr_b9e0b53cad65d33abb4286b4e20ba868",…},"paymentRequestToken":"…",
 "error":{"code":"receipt_already_redeemed","message":"The receipt has already been redeemed."}}
```

The checks run in this order: the receipt verifies with ACK, is signed by the payment service's DID, and embeds a payment request token signed by this agent; the request id was issued here, for this resource; the receipt's option is one of the request's options; the request has not been redeemed. An unknown resource answers `404 resource_not_found`.

## Payment service routes

`POST /payment-service/payments` takes `{"initiation": "<JWT>"}`, signed by the payer with `aud` set to the payment service URL. Amount, currency and payee are read from the verified payment request token inside it. Nothing else in the body counts:

```
$ curl -si -X POST http://localhost:8787/payment-service/payments -H 'Content-Type: application/json' -d "{\"initiation\":\"$INITIATION\"}"
HTTP/1.1 201 Created

{"paymentId":"pay_2c1937827b9a92bf2f44c9eb9111921d","status":"requires_payment",
 "paymentRequestId":"pr_a405636b8c2081d51d91c011de09329c","paymentOptionId":"sandbox-usd","network":"sandbox",
 "amount":{"amount":500,"decimals":2,"currency":"USD"},"description":"Market brief",
 "payer":"did:key:z6Mkkn7j…","payee":"did:key:z6MkuJMw…",
 "policy":{"outcome":"allow","rule":"within_limits"},"next":{"type":"sandbox_settle"}}
```

The other outcomes from the same run:

| Request | Answer |
| :- | :- |
| The same initiation again | `200`, the same payment |
| `partner-feed` from Globex | `403 {"error":{"code":"policy_denied",…,"details":{"rule":"counterparty_not_allowed"}}}`; nothing is stored |
| `annual-report` ($75.00) | `202`, `"status":"pending_approval"`, an `approvalId`, no `next`; nothing is paid until the approver decides |
| `{"initiation":"not-a-jwt"}` | `400 invalid_initiation` |
| `GET /payment-service/payments/pay_nope` | `404 payment_not_found` |

A payment waiting for approval stays in `pending_approval` until the human approver decides through `GET /payment-service/approvals` and `POST /payment-service/approvals/:id/decision` ([approvals.md](approvals.md)); until then the settle route and the receipt route both answer 409 for it.

Then the client pays and asks for the receipt:

```
$ curl -s -X POST http://localhost:8787/payment-service/payments/$PAY/receipt          # before paying
{"error":{"code":"payment_not_settled","message":"The payment has not settled."}}       # 409
$ curl -s -X POST http://localhost:8787/payment-service/payments/$PAY/sandbox/settle   # 200, "status":"settled", no "next"
$ curl -s -X POST http://localhost:8787/payment-service/payments/$PAY/receipt          # 200
{"receipt":"eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJleHAiOjE3OTQ0MjM2NDEsInZjIjp7…"}
```

The sandbox settle call records the payment in an in-memory ledger. The receipt route checks that ledger itself before it signs anything. The receipt is a `PaymentReceiptCredential` for the payer that expires `RECEIPT_TTL_SECONDS` after settlement. It is signed once, and asking again returns the same JWT. Settling twice answers `409 payment_not_payable`, and so does settling after the payment request has expired, which also moves the payment to `failed`. For a Stripe payment the receipt route retrieves the PaymentIntent and signs only when it succeeded for the expected amount, currency and payment id; until then it answers `409 payment_not_settled`, and on a mismatch `409 settlement_mismatch`. A Stripe payment fails only when its PaymentIntent is canceled, its payment request expires unpaid or settlement could not be started. Once its client secret was issued, it moves to `failed` only after Stripe confirms the cancel of its PaymentIntent, and until then stays payable while the cancel is retried; one whose client secret was never issued fails at once and its cancel is retried afterwards ([stripe.md](stripe.md#when-a-payment-fails)). `POST /payment-service/webhooks/stripe` verifies the `Stripe-Signature` header, settles Stripe payments and logs declines; it answers `503 webhook_not_configured` while no webhook secret is configured ([stripe.md](stripe.md#the-webhook)).

### Approver routes

`GET /payment-service/approvals?status=pending` and `POST /payment-service/approvals/:id/decision` need `Authorization: Bearer <APPROVER_TOKEN>` and answer `401 unauthorized` without it. Approving calls the payment's settlement adapter once and moves it to `requires_payment`; rejecting moves it to `rejected`. Examples, the error codes and what expiry does are in [approvals.md](approvals.md).

## CORS

Only `CLIENT_ORIGIN` gets CORS headers. A preflight from any other origin is not answered as a preflight:

```
$ curl -si -X OPTIONS http://localhost:8787/api/resources/market-brief -H 'Origin: http://localhost:5173' \
    -H 'Access-Control-Request-Method: GET' -H 'Access-Control-Request-Headers: payment-receipt'
HTTP/1.1 204 No Content
access-control-allow-headers: Content-Type,Authorization,Payment-Receipt
access-control-allow-methods: GET,POST,OPTIONS
access-control-allow-origin: http://localhost:5173
access-control-max-age: 600

$ curl -si -X OPTIONS http://localhost:8787/api/resources/market-brief -H 'Origin: https://evil.example' …
HTTP/1.1 404 Not Found
vary: Origin
```

## Reading the log

One line per protocol event: the UTC time, the actor, the event, then `pr=` (payment request), `pay=` (payment) and the event's data. Tokens appear only as `…` and their last 8 characters. This is the real log of the paid request above (DIDs shortened):

```
18:50:41.362 server-agent     server.request.received         resource=market-brief receipt=false
18:50:41.362 server-agent     server.payment_required.issued  pr=pr_a405…29c resource=market-brief amount=$5.00 options=sandbox-usd expiresAt=2026-11-11T19:05:41.362Z token=…Wo-Uk6Aw
18:50:41.594 payment-service  ps.payment.initiated            payer=did:key:z6Mkkn7j… option=sandbox-usd initiation=…Oh9zW8Aw
18:50:41.596 payment-service  ps.policy.evaluated             pr=pr_a405…29c pay=pay_2c19…21d outcome=allow rule=within_limits amount=$5.00 payer=did:key:z6Mkkn7j… counterparty=did:key:z6MkuJMw…
18:50:41.596 payment-service  ps.settlement.started           pr=pr_a405…29c pay=pay_2c19…21d network=sandbox next=sandbox_settle
18:50:41.658 payment-service  ps.settlement.confirmed         pr=pr_a405…29c pay=pay_2c19…21d network=sandbox ref=sandbox_pay_2c19…21d amount=$5.00 settledAt=2026-11-11T18:50:41.658Z
18:50:41.667 payment-service  ps.receipt.issued               pr=pr_a405…29c pay=pay_2c19…21d payer=did:key:z6Mkkn7j… option=sandbox-usd expiresAt=2026-11-11T19:00:41.658Z receipt=…jrOGKYBQ
18:50:41.724 server-agent     server.request.received         resource=market-brief receipt=true
18:50:41.724 server-agent     server.receipt.presented        resource=market-brief receipt=…jrOGKYBQ
18:50:41.729 server-agent     server.receipt.verified         pr=pr_a405…29c resource=market-brief option=sandbox-usd
18:50:41.729 server-agent     server.resource.delivered       pr=pr_a405…29c resource=market-brief
```

1. Acme receives a request for `market-brief` with no receipt.
2. Acme answers 402 with a $5.00 payment request that offers one option and expires in 15 minutes.
3. The payment service receives a signed initiation from the payer for `sandbox-usd`.
4. The policy allows it: the payee (Acme) is on the allowlist and $5.00 is within the threshold. The payment gets its id.
5. The sandbox adapter starts settlement and tells the client to call the settle route.
6. The client settles. The payment service checks the ledger and marks the payment settled.
7. The payment service signs the receipt, valid for 10 minutes after settlement.
8. Acme receives the retry with a receipt.
9. Acme logs the receipt (by its tail) before checking it.
10. The receipt verifies, and its payment request was issued here for this resource.
11. Acme delivers the content and marks the request redeemed. Presenting the receipt again logs `server.receipt.rejected … code=receipt_already_redeemed`, and Acme issues a fresh payment request.

For a payment that needs a human, `ps.policy.evaluated` reads `outcome=needs_approval rule=amount_over_threshold`, then come `ps.approval.requested` and, once the approver decides, `ps.approval.decided` with the actor `human` ([approvals.md](approvals.md) shows the lines).

With `LOG_FORMAT=json` each line is the event as one JSON object: `name`, `actor`, `at`, `paymentRequestId`, `paymentId`, `data`.
