# ACK-Pay HTTP 402 paywall

A TypeScript implementation of an HTTP 402 paywall that follows the [ACK-Pay server-initiated sequence](https://www.agentcommercekit.com/ack-pay/server-initiated-sequence.md), built on the [Agent Commerce Kit](https://www.agentcommercekit.com) packages (`agentcommercekit` 0.11.0).

- **Server agents** (Acme at `/api`, Globex at `/partner`) answer paywalled routes with `402 Payment Required` and an ACK payment request, and deliver the resource when the retry carries a valid ACK receipt.
- **The payment service** (`/payment-service`) takes the client's payment for a payment option, applies a spend policy (an allowlist of payees, and a human approver above $50), settles it on a sandbox network or Stripe test mode, and signs the receipt.
- **The client agent** is a small React page that calls the API, receives the 402, pays, verifies the receipt and retries, showing every step.

The wire contract is in [docs/protocol.md](docs/protocol.md).

## What works today

- The workspace: install, typecheck, lint and the test runner.
- The wire contract package `@paywall/protocol`: types and schemas for every body, the protocol events, money helpers, and the clock and id interfaces. Its tests pass.
- The spend policy (`packages/server/src/policy`): an allowlist of payees and a human-approval threshold, with its configuration parser. Its tests pass. See [docs/policy.md](docs/policy.md).
- The server (`packages/server`): the Acme and Globex server agents answer `402` with signed ACK payment requests and deliver each resource once for a valid receipt; the payment service verifies signed initiations, applies the spend policy, holds payments above $50 for a human, settles on the sandbox network and signs ACK receipts. `pnpm setup:env` writes a working `.env`, and the server logs one line per protocol event. Its tests pass. See [docs/server.md](docs/server.md).
- The client (`packages/client`): the client agent verifies the `402`, signs a payment initiation, pays on the sandbox network, verifies the receipt and retries once; it waits while a payment needs approval. The page lists both catalogs, shows every step of a run with the decoded payment request and receipt, and writes each event to the browser console. Its identity is an Ed25519 `did:key` kept in `localStorage`. See [docs/client.md](docs/client.md) and [docs/architecture.md](docs/architecture.md).
- Human approval: the approver routes on the payment service, guarded by the approver token, and a *Human approver* panel on the page that lists waiting payments and approves or rejects them. Approving starts settlement and the waiting run completes; rejecting ends it `approval_rejected`. See [docs/approvals.md](docs/approvals.md).
- The test suite for every part of the system, and the testkit it uses. The protocol, policy, server, client agent, page, approval and in-process end-to-end tests pass; the Stripe tests fail until the Stripe option is built, and the over-HTTP sandbox case fails only its count of responses.

## Prerequisites

- Node.js 22.18 or later (the server runs TypeScript directly). Developed on Node 26.
- pnpm 12.

## Install

```sh
pnpm install
```

## Scripts

| Command | What it does |
| :- | :- |
| `pnpm typecheck` | Type-checks every package and test with `tsc`. |
| `pnpm lint` | ESLint, including the import boundaries between modules. |
| `pnpm test` | Every offline test (Vitest). See [docs/testing.md](docs/testing.md). |
| `pnpm test:stripe-live` | The live check against Stripe test mode; needs Stripe test keys in `.env`. |
| `pnpm build` | Builds the client bundle with Vite into `packages/client/dist`. |
| `pnpm dev` | Starts the server and the client together. |
| `pnpm setup:env` | Writes a `.env` with fresh keys. |

Run `pnpm setup:env` once before starting the server; it refuses to overwrite an existing `.env`. `pnpm --filter @paywall/server start` starts the server alone on port 8787 ([docs/server.md](docs/server.md) shows it in use with `curl`). `.env.example` documents every configuration variable.

## Sandbox demo

```sh
pnpm install
pnpm setup:env   # once: writes .env with fresh keys and the Acme DID on the allowlist
pnpm dev         # server on http://localhost:8787, page on http://localhost:5173
```

Open http://localhost:5173. The page shows the client agent's DID and the catalog of both server agents. Press Fetch on:

- **Market brief** ($5.00, Acme). The run goes `requesting`, `verifying_request`, `selecting_option`, `initiating`, `paying`, `fetching_receipt`, `retrying`, `delivered`. The page shows the payment request (payee, amount, the `sandbox-usd` option marked as selected), the verified receipt (issuer, payer, option, expiry) and the content.
- **Partner feed** ($5.00, Globex). Globex is not on the allowlist, so the payment service refuses before anything is paid: the run fails `policy_denied` with rule `counterparty_not_allowed`.
- **Annual report** ($75.00, Acme). Over the $50 approval threshold: the run stops at `awaiting_approval`, waiting for a human. In the *Human approver* panel, paste `APPROVER_TOKEN` from `.env`, press *Load approvals*, and press *Approve*: the run pays and ends `delivered`. Press *Reject* instead and it ends `approval_rejected`. Nobody deciding within five minutes ends it `approval_timeout`. See [docs/approvals.md](docs/approvals.md).

The timeline lists every client event; the browser console shows the same events, and the server terminal prints the server agent and payment service events for the same payment request id ([docs/server.md](docs/server.md) explains the lines).

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
- [docs/architecture.md](docs/architecture.md): the roles, who holds which key, and the sequence mapped to code and events.
- [docs/testing.md](docs/testing.md): running the tests, how they are organised, the acceptance IDs and the testkit.
- [docs/decisions.md](docs/decisions.md): choices made along the way and why.
