# Testing

The test suite was written before the implementation and defines when each part is done. Every acceptance criterion has an ID, and at least one test whose title starts with it, for example `SA-10: a receipt is delivered once; ...`.

## Running the tests

From the repository root:

```sh
pnpm test                                    # every offline test
pnpm exec vitest run packages/protocol/test  # one directory
pnpm exec vitest run packages/server/test/policy packages/server/test/server-agent
pnpm test:stripe-live                        # real Stripe test mode; needs STRIPE_* in .env
```

`pnpm test` runs the Vitest projects in `vitest.config.ts`. `pnpm test:stripe-live` uses `vitest.live.config.ts`, reads only the `STRIPE_*` variables from `.env`, and fails when they are missing. It is never part of `pnpm test`.

Every offline test passes, and so does the live Stripe check:

```
$ pnpm exec vitest run packages/protocol/test
 Test Files  4 passed (4)
      Tests  84 passed (84)

$ pnpm exec vitest run packages/server/test/policy
 Test Files  2 passed (2)
      Tests  21 passed (21)

$ pnpm exec vitest run packages/server/test/server-agent packages/server/test/payment-service
 Test Files  4 passed (4)
      Tests  56 passed (56)

$ pnpm exec vitest run packages/client/test/agent packages/client/test/ui tests/e2e/core
 Test Files  5 passed (5)
      Tests  39 passed (39)

$ pnpm exec vitest run packages/server/test/stripe packages/client/test/stripe tests/e2e/stripe
 Test Files  6 passed (6)
      Tests  37 passed (37)

$ pnpm exec vitest run packages/server/test/approvals packages/client/test/approvals tests/e2e/approval
 Test Files  4 passed (4)
      Tests  18 passed (18)

$ pnpm exec vitest run tests/e2e/http
 Test Files  1 passed (1)
      Tests  3 passed (3)

$ pnpm test
 Test Files  26 passed (26)
      Tests  258 passed (258)

$ pnpm test:stripe-live
 Test Files  1 passed (1)
      Tests  1 passed (1)
```

## Layout

| Directory | IDs | What it covers |
| :- | :- | :- |
| `packages/protocol/test` | PRO-1 to PRO-4 | Wire schemas, the ACK behaviour the paywall relies on, money helpers, events. |
| `packages/server/test/policy` | POL-1 to POL-7 | The spend policy and its configuration. |
| `packages/server/test/server-agent` | SA-1 to SA-14 | 402 issuance, receipt verification, single use, CORS, server events. |
| `packages/server/test/payment-service` | PS-1 to PS-13 | Initiation, policy enforcement, sandbox settlement, receipts, payment service events. |
| `packages/server/test/stripe` | STR-1 to STR-8 | The Stripe adapter, webhook, configuration guards, secrets in logs, and out-of-order webhook events. |
| `packages/server/test/approvals` | APR-1 to APR-7 | The approver routes and decisions. |
| `packages/client/test/agent` | CL-1 to CL-13 | The client agent core. |
| `packages/client/test/ui` | UI-1 to UI-5 | The page, rendered in jsdom. |
| `packages/client/test/stripe` | STR-9 | The Payment Element executor, with Stripe.js mocked, and its abort and processing paths. |
| `packages/client/test/approvals` | UI-6, UI-7 | The approver panel and the agent run while it waits. |
| `tests/e2e/core`, `stripe`, `approval` | E2E-1 to E2E-6 | The real client core against the real server, in process. |
| `tests/e2e/http` | E2E-7 | The server on a real ephemeral port, with real `fetch` and CORS. |
| `tests/stripe-live` | STR-10 | Stripe test mode, live. |

The ID prefixes: PRO protocol, POL policy, SA server agent, PS payment service, STR Stripe, APR approvals, CL client agent, UI page, E2E end to end.

## How the tests are written

- **Public interfaces only.** Hono apps are driven with `app.request(...)`, factories through their exports, the page through what it renders.
- **Real ACK cryptography.** `agentcommercekit` is never mocked. Negative cases use real artifacts that are wrong in one way: signed by another key, expired by the clock, issued for another resource.
- **Deterministic.** A fixed clock, sequential ids, fixture keys and fake timers for polling. ACK reads the system time when it stamps and checks credentials, so `useFixedTime` freezes the system `Date` at the same instant as the injected clock. The one exception is E2E-7, which runs the real server with the real clock and polls every 25 ms.
- **Stripe** is replaced at the `StripeGateway` seam on the server and by mocking `@stripe/stripe-js` and `@stripe/react-stripe-js` in the browser tests.
- **Events** are checked as ordered names in a `MemoryEventLog`. The end-to-end tests share one log between client and server, so the merged order is checked too.
- No test is focused, skipped or marked todo. A test that has to change because it contradicts the specification carries a `// spec-fix(T<n>): <reason>` comment.

The client tests talk to `FakePaywall` (`packages/client/test/support`), a scripted server agent and payment service that signs real ACK artifacts and can misbehave one way at a time: a forged token, an altered unsigned request, a receipt from the wrong issuer, a receipt refused on retry. The jsdom setup (`packages/client/test/setup-dom.ts`) puts Node's `Uint8Array` back on the global object, because jsdom's typed arrays come from another realm and the multiformats code under ACK rejects them.

The page tests rely on this page structure:

- Regions named "Catalog" and "Agent run". Each catalog item is a list item with a Fetch button.
- In the agent run: a `status` live region (`aria-live="polite"`) showing the flow status, a list named "Timeline" with one item per event carrying its label, a region named "Payment request" with a list named "Payment options" (the selected option's item has `aria-current="true"`), a region named "Receipt" showing the receipt's expiry as the credential's ISO 8601 `expirationDate`, and a Reset button.
- While a payment waits for approval, the agent run says it is "waiting for a human" (or "waiting for human").
- The approver panel is its own region named "Human approver", with a field labelled "Approver token", a "Load approvals" button, one list item per pending approval with Approve and Reject buttons, and errors in an `alert`.

## The testkit

`@paywall/testkit` (`packages/testkit`) is imported only by tests.

| Export | What it is |
| :- | :- |
| `FixedClock`, `useFixedTime`, `elapse`, `FIXED_START` | A clock that moves only when told; `useFixedTime` also freezes the system `Date` (and optionally the timers) in step with it; `elapse` runs due timers and moves both. Tests start at 2026-11-10T14:02:00.000Z. |
| `SequenceIds` | Ids `pr_0001`, `pay_0001`, ... with a counter per prefix. |
| `MemoryEventLog`, `teeEventLog`, `eventStrings`, `JWT_PATTERN` | An in-memory event log with `names()`, `one()` and `all()`, a fan-out log, and helpers for leak checks. |
| `fixtures`, `fixtureIdentity`, `identityFromPrivateJwk`, `fixtureResolver` | Deterministic `did:key` identities for Acme, Globex, the payment service (secp256k1), the client and an untrusted issuer, derived from readable test-only seeds. |
| `buildPaymentRequest`, `paymentOption`, `buildInitiation`, `buildReceipt`, `buildOtherCredential`, `tamperSignature` | Builders for signed ACK artifacts, made with the ACK functions, and a way to break a signature. |
| `inProcessFetch`, `FetchStub`, `json` | A `fetch` over an in-process app, and a scripted `fetch` that records requests. |
| `FakeStripeGateway`, `FAKE_STRIPE_KEYS` | A Stripe stand-in behind the `StripeGateway` seam whose PaymentIntents a test can succeed or alter, with HMAC-signed webhooks. |
| `fixtureEnv`, `fixtureStripeEnv`, constants | Environment variables for the server built from the fixtures, and the URLs, origin and approver token the tests use. |
