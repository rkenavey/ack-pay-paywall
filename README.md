# ACK-Pay HTTP 402 paywall

A TypeScript implementation of an HTTP 402 paywall that follows the [ACK-Pay server-initiated sequence](https://www.agentcommercekit.com/ack-pay/server-initiated-sequence.md), built on the [Agent Commerce Kit](https://www.agentcommercekit.com) packages (`agentcommercekit` 0.11.0).

- **Server agents** (Acme at `/api`, Globex at `/partner`) answer paywalled routes with `402 Payment Required` and an ACK payment request, and deliver the resource when the retry carries a valid ACK receipt.
- **The payment service** (`/payment-service`) takes the client's payment for a payment option, applies a spend policy (an allowlist of payees, and a human approver above $50), settles it on a sandbox network or Stripe test mode, and signs the receipt.
- **The client agent** is a small React page that calls the API, receives the 402, pays, verifies the receipt and retries, showing every step.

The wire contract is in [docs/protocol.md](docs/protocol.md).

## What works today

- The workspace: install, typecheck, lint and the test runner.
- The wire contract package `@paywall/protocol`: types and schemas for every body, the protocol events, money helpers, and the clock and id interfaces. Its tests pass.
- The test suite for every part of the system, and the testkit it uses. Only the protocol tests pass so far; the others fail until the code they test is built.
- The server and client packages exist with their interfaces in place; their behaviour is not built yet, so neither the server nor the page runs.

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
| `pnpm build` | Builds the client bundle with Vite. |
| `pnpm dev` | Starts the server and the client together. |
| `pnpm setup:env` | Writes a `.env` with fresh keys. |

Until the server is built, `pnpm setup:env` stops with a "not implemented yet" error, and `pnpm dev` starts only the Vite dev server (the server process exits because there is no `.env` yet). `.env.example` documents every configuration variable.

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
- [docs/testing.md](docs/testing.md): running the tests, how they are organised, the acceptance IDs and the testkit.
- [docs/decisions.md](docs/decisions.md): choices made along the way and why.
