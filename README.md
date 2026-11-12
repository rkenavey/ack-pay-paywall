# ACK-Pay HTTP 402 paywall

A TypeScript implementation of an HTTP 402 paywall that follows the [ACK-Pay server-initiated sequence](https://www.agentcommercekit.com/ack-pay/server-initiated-sequence.md), built on the [Agent Commerce Kit](https://www.agentcommercekit.com) packages (`agentcommercekit` 0.11.0).

- **Server agents** (Acme at `/api`, Globex at `/partner`) answer paywalled routes with `402 Payment Required` and an ACK payment request, and deliver the resource when the retry carries a valid ACK receipt.
- **The payment service** (`/payment-service`) takes the client's payment for a payment option, applies a spend policy (an allowlist of payees, and a human approver above $50), settles it on a sandbox network or Stripe test mode, and signs the receipt.
- **The client agent** is a small React page that calls the API, receives the 402, pays, verifies the receipt and retries, showing every step.

The wire contract is in [docs/protocol.md](docs/protocol.md).

## What works today

- The wire contract package `@paywall/protocol`: types and schemas for every body, the protocol events, money helpers, and the clock and id interfaces. See [docs/protocol.md](docs/protocol.md).
- The spend policy: an allowlist of payees and a human-approval threshold, with its configuration parser. See [docs/policy.md](docs/policy.md).
- The server: the Acme and Globex server agents answer `402` with signed ACK payment requests and deliver each resource once for a valid receipt; the payment service verifies signed initiations, applies the spend policy, holds payments above $50 for a human, settles on the sandbox network or Stripe test mode and signs ACK receipts. It logs one line per protocol event. See [docs/server.md](docs/server.md).
- The client: the client agent verifies the `402`, signs a payment initiation, pays, verifies the receipt and retries once; it waits while a payment needs approval. The page lists both catalogs, shows every step of a run with the decoded payment request and receipt, and writes each event to the browser console. See [docs/client.md](docs/client.md) and [docs/architecture.md](docs/architecture.md).
- Human approval: the approver routes, guarded by the approver token, and a *Human approver* panel on the page. See [docs/approvals.md](docs/approvals.md).
- Stripe test mode: with test-mode keys in `.env`, payment requests also offer `stripe-usd`, paid with Stripe's Payment Element; the payment service checks the PaymentIntent with Stripe before it signs a receipt, a signed Stripe webhook can settle payments, a declined card can be retried, and a Stripe payment that fails has its PaymentIntent cancelled. See [docs/stripe.md](docs/stripe.md).
- The test suite for every part of the system, and the testkit it uses. Every offline test passes, and so does the live Stripe check. See [docs/testing.md](docs/testing.md).

## Prerequisites

- Node.js 22.18 or later (the server runs TypeScript directly). Developed on Node 26.
- pnpm 12.
- Google Chrome or another current browser for the page.
- Optional: a Stripe account for test-mode keys.

## Quickstart

From a fresh clone:

```sh
git clone https://github.com/rkenavey/ack-pay-paywall.git
cd ack-pay-paywall
pnpm install
pnpm setup:env   # writes .env: three fresh keys, the Acme DID on the allowlist, a random approver token
pnpm test        # every offline test
pnpm dev         # server on http://localhost:8787, page on http://localhost:5173
```

`pnpm setup:env` prints the three public DIDs and leaves the Stripe lines blank, so only the sandbox network is offered until you add keys. It refuses to overwrite an existing `.env`; delete the file to start over. `.env` is readable only by you and git ignores it. `.env.example` documents every variable.

Open http://localhost:5173. The page shows the client agent's DID (a fresh Ed25519 `did:key` kept in the browser's `localStorage`, which is demo-grade key storage), the *Catalog*, the *Agent run* and the *Human approver* panel. Stop `pnpm dev` with Ctrl-C.

## Demo scenarios

Each Fetch starts one run of the client agent. The status line, the timeline and the browser console show every step; Reset clears the page.

### 1. Paid and delivered: Market brief ($5.00, Acme)

1. Press Fetch on **Market brief**.
2. The run goes `requesting`, `verifying_request`, `selecting_option`, `initiating`, `paying`, `fetching_receipt`, `retrying`, `delivered`.
3. *Payment request* shows the payee (Acme's DID), the description, $5.00 and the options, with the one the agent chose marked. Without Stripe keys that is `sandbox-usd`, which settles at once.
4. *Receipt* shows the issuer (the payment service's DID), the payer (the agent's DID), the option and the expiry; below it is the content.

With Stripe keys the agent chooses `stripe-usd`: while the run is `paying`, *Card payment (Stripe test mode)* appears. Enter `4242 4242 4242 4242`, any future expiry, any CVC and any postal code, and press Pay. The run continues to `delivered` and the receipt's option is `stripe-usd`.

### 2. Waiting for a human: Annual report ($75.00, Acme)

1. Press Fetch on **Annual report**. It is over the $50.00 approval threshold, so the run stops at `awaiting_approval (waiting for a human to approve the payment)`.
2. In *Human approver*, paste the value of `APPROVER_TOKEN` from `.env` into *Approver token* and press *Load approvals*.
3. The waiting payment shows its amount, description, payer and payee. Press *Approve*.
4. Within a second the run continues: it pays (on Stripe, enter the test card as above), fetches the receipt and ends `delivered`.

Press *Reject* instead and the run ends `approval_rejected`; nothing is paid. If nobody decides within five minutes the run ends `approval_timeout`. See [docs/approvals.md](docs/approvals.md).

### 3. Refused by policy: Partner feed ($5.00, Globex)

1. Press Fetch on **Partner feed**.
2. The run gets Globex's `402`, verifies it and initiates a payment, then ends `failed` with `policy_denied` and rule `counterparty_not_allowed`: Globex's DID is not on `POLICY_ALLOWED_COUNTERPARTIES`. The payment service refuses before any money moves and stores nothing. See [docs/policy.md](docs/policy.md).

## Adding Stripe test-mode keys

1. In the Stripe Dashboard, in test mode, open **Developers → API keys**.
2. Put the keys in `.env`, and nowhere else:

   ```sh
   STRIPE_SECRET_KEY=sk_test_your_secret_key
   STRIPE_PUBLISHABLE_KEY=pk_test_your_publishable_key
   ```

3. Restart `pnpm dev`. The server's startup notice now reads `Networks: sandbox, stripe (test mode)`, and every payment request offers `stripe-usd`. Live-mode keys stop the server.
4. `pnpm test:stripe-live` checks the integration against the real test-mode API.

The secret key never leaves the server. A webhook secret is optional; [docs/stripe.md](docs/stripe.md) covers it, the test cards and what the server checks before it signs a receipt.

## Reading the logs

The server writes one line per protocol event to standard output (startup notices go to standard error). Four lines of a sandbox purchase, with ids shortened and some data cut:

```
00:08:44.170 server-agent     server.request.received         resource=market-brief receipt=false
00:08:44.193 server-agent     server.payment_required.issued  pr=pr_d91bda19… resource=market-brief amount=$5.00 options=sandbox-usd …
00:08:44.219 payment-service  ps.policy.evaluated             pr=pr_d91bda19… pay=pay_983df437… outcome=allow rule=within_limits amount=$5.00 …
00:08:44.231 server-agent     server.resource.delivered       pr=pr_d91bda19… resource=market-brief
```

Each line is the UTC time, the actor (`server-agent`, `payment-service` or `human`), the event, then `pr=` (the payment request id), `pay=` (the payment id) and the event's data. Follow one purchase by its `pr=` id. Tokens appear only as their last 8 characters; keys, client secrets and the approver token never appear. Under `pnpm dev` each line is prefixed `[server]`, and the ellipsis before a token tail prints as `...`. `LOG_FORMAT=json` writes one JSON object per event instead. The page's timeline and the browser console (`[paywall] …`) show the client agent's events. [docs/server.md](docs/server.md#reading-the-log) explains a full log line by line.

## Scripts

| Command | What it does |
| :- | :- |
| `pnpm typecheck` | Type-checks every package and test with `tsc`. |
| `pnpm lint` | ESLint, including the import boundaries between modules. |
| `pnpm test` | Every offline test (Vitest). See [docs/testing.md](docs/testing.md). |
| `pnpm test:stripe-live` | The live check against Stripe test mode; needs Stripe test keys in `.env`. |
| `pnpm build` | Builds the client bundle with Vite into `packages/client/dist`. |
| `pnpm dev` | Starts the server and the client together, restarting on change. |
| `pnpm setup:env` | Writes a `.env` with fresh keys. |

`pnpm --filter @paywall/server start` starts the server alone on port 8787 ([docs/server.md](docs/server.md) shows it in use with `curl`). To try the built page, run `pnpm build` and then `pnpm --filter @paywall/client exec vite preview --port 5173` beside the server.

## Repository layout

```
docs/                      documentation
packages/
  protocol/                @paywall/protocol: the wire contract, events, money helpers
  testkit/                 @paywall/testkit: test doubles and fixtures, used by tests only
  server/                  @paywall/server
    src/policy/            the spend policy
    src/server-agent/      the paywalled API
    src/payment-service/   payments, settlement adapters, receipts; stripe/ and approvals/
    src/shared/            identity, configuration, logging, in-memory stores, demo catalog
    src/app.ts, main.ts    the whole server and the process entry point
  client/                  @paywall/client
    src/agent/             the client agent core (no React, no DOM, no Stripe)
    src/ui/                the React page
    src/stripe/            the Stripe Payment Element executor
    src/approver/          the human approver panel
tests/e2e/                 whole-system tests: core, stripe, approval, http
tests/stripe-live/         the live Stripe test-mode check
```

## Documentation

- [docs/protocol.md](docs/protocol.md): every route, body, error code and event.
- [docs/policy.md](docs/policy.md): the spend policy's rules, examples and configuration.
- [docs/server.md](docs/server.md): the server agents and the payment service, their routes, configuration and log.
- [docs/client.md](docs/client.md): the client agent's flow, the page, and how the agent's identity is stored.
- [docs/approvals.md](docs/approvals.md): the human approver, the approver routes and the panel.
- [docs/stripe.md](docs/stripe.md): Stripe test-mode keys, the Payment Element, what is checked before a receipt, the webhook, test cards and the live test.
- [docs/architecture.md](docs/architecture.md): the roles, who holds which key, and the sequence mapped to code and events.
- [docs/testing.md](docs/testing.md): running the tests, how they are organised, the acceptance IDs and the testkit.
- [docs/decisions.md](docs/decisions.md): choices made along the way and why.

## License

MIT. See [LICENSE](LICENSE).
