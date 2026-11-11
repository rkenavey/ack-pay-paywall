# Decisions

Choices that were left open, newest last.

**TypeScript 6.0, not 7.0.** typescript-eslint 8.72, the current release, declares support for TypeScript below 6.1 only. TypeScript 6.0.3 is the newest version it accepts. Rejected: TypeScript 7 with a linter that does not support it.

**valibot 1.4.1, not 1.5.0.** The ACK packages depend on valibot 1.4.1 exactly. Using the same version keeps one copy, so our schemas and the ACK schemas compose without two valibot runtimes. Rejected: the latest valibot with a second copy under ACK.

**@testing-library/user-event 14.6.8.** 14.6.9 was published the day the workspace was set up; the previous release was taken instead of excluding it from the package manager's release-age check.

**TypeScript runs from source.** Node 22.18 and later strip types, so the server runs `src/main.ts` directly and workspace packages export their `src/index.ts`. The code uses only erasable syntax and `.ts` import extensions. `pnpm build` builds the client bundle; the server has no build step. Rejected: compiling every package to `dist/`.

**Shared runtime interfaces live in the protocol package.** `AgentIdentity`, `Clock`, `IdGenerator`, the system clock and random ids, and `PolicyDecision` are used by both the server and the client, and the client cannot import the server. The protocol package holds them; the server re-exports the types `AgentIdentity`, `Clock` and `IdGenerator` from its server-agent module and `PolicyDecision` from its policy module. The system clock and random ids are the only code that reads the time or randomness.

**The testkit and the server depend on each other.** The fake Stripe gateway implements the server's `StripeGateway` type, and the server's tests use the testkit. The import from the server is type-only, so nothing loads in a cycle, but `pnpm -r` refuses the cycle; the root `build` script therefore filters to the client.

**Tests freeze the system clock.** ACK stamps and checks credentials and JWTs with the system time, not an injected clock. `useFixedTime` fakes `Date` at the injected clock's instant so a receipt "expired by the fixed clock" is expired for ACK too.

**Node's typed arrays in jsdom.** jsdom installs typed-array constructors from its own realm, and the multiformats code under ACK rejects bytes from the other realm. The jsdom setup restores Node's `Uint8Array` and `ArrayBuffer`. Real browsers are not affected.

**The page's accessible structure is part of the contract.** The page tests find regions, lists and the live region by role and name (see the testing guide), so the page is free in its look but not in that structure.

**`buildApp(config, overrides?)`.** The whole server is built from an `AppConfig`; `overrides` replaces the clock, ids, event log, DID resolver or Stripe gateway. Tests pass a fixed clock, sequential ids, a memory log and a fake gateway; the process entry point passes nothing. Rejected: reading the environment inside `buildApp`, which would make it untestable without process state.

**`parseConfig(env)` and `AppConfig`.** Configuration is parsed once from an environment-style record into a typed `AppConfig` (private JWKs, policy, approver token, TTLs, sandbox switch, optional Stripe keys, log format). Errors name the variable and never contain its value. Rejected: passing raw environment strings around.

**`createConsoleEventLog({ format, clock, write })`.** The log sink takes its clock and an optional `write` for each line, defaulting to standard output, so tests can capture lines and check them for secrets.

**`SandboxAdapter.markPaid(payment, at)`.** The settlement adapter interface has only `begin` and `verify`; the sandbox adapter adds `markPaid`, which the sandbox settle route calls to record the payment in the in-memory ledger that `verify` then reads.

**`createStripeCheckout({ returnUrl })` and `StripePaymentForm`.** The browser Stripe executor is split into a checkout object, whose `executor` the client agent runs, and a React component that renders the Payment Element for it. The executor resolves when `confirmPayment` succeeds in the component, so the agent core stays free of React and Stripe.

**`ApproverPanel({ paymentServiceUrl, fetch })`.** The approver panel is a self-contained component with its own "Human approver" region; it keeps the approver token in component state and calls the approver routes with it.

**The policy fails closed on malformed input with an existing rule.** `evaluateSpend` must never throw, and the decision type has no "malformed" rule. A request without a usable amount is denied `invalid_amount`, a configuration without a usable threshold `currency_not_supported` (no denomination can match it), one without an allowlist `counterparty_not_allowed`; anything else that throws is caught and denied `invalid_amount`. Rejected: adding a rule name to the shared decision type.

**Policy configuration parsing is lenient on whitespace, strict on values.** Whitespace around allowlist entries and empty entries (a trailing comma) are ignored, and an empty threshold variable means the default, so a blank line copied from `.env.example` works. DIDs must match the DID syntax `did:<method>:<id>`, and the threshold must be a whole number of cents; zero is refused, because the threshold is a `Money` and amounts are positive. Rejected: treating an empty entry or an empty threshold as an error, and allowing a zero threshold.

**Entry points check `process.argv[1]`, not `import.meta.main`.** `import.meta.main` exists only from Node 24.2, and the stated minimum is Node 22.18. `src/main.ts` and `scripts/setup-env.ts` run when the real path of `process.argv[1]` equals `import.meta.filename`, which works on both. Rejected: raising the minimum to Node 24.2 for one guard.

**CORS answers only the client origin.** A request whose `Origin` is not `CLIENT_ORIGIN` passes through with no CORS headers at all. A preflight from another origin is not answered as one (it falls through to `404`), so no allowed methods or headers leak to it either. Every response varies on `Origin`. Rejected: Hono's `cors` on its own, which still sends the allowed methods and headers to any origin's preflight.

**The sandbox settle route refuses an expired request.** In the sandbox no money has moved before the settle call, so a payment whose request has expired is moved to `failed` and the call answers `409 payment_not_payable`. The receipt route does not apply the expiry: once settlement is verified, the payer has paid and gets the receipt. Rejected: failing paid payments on expiry.

**A repeated initiation must come from the same payee.** Payment request ids are unique only per issuer. When a payer's earlier payment for the same request id and option was for another payee, the initiation answers `400 payment_request_invalid` instead of returning that payment. Rejected: trusting the id alone.

**`ps.payment.initiated` is emitted once the initiation verifies.** Its data is the payer, the option and the initiation's tail. Bodies that are not a valid initiation emit nothing: there is no verified payer to attribute them to.

**Failures inside the payment service fail closed.** A policy that throws or returns something unknown answers `500` with nothing stored. An adapter whose `begin` throws moves the payment to `failed`, emits `ps.settlement.failed` and answers `500 internal_error`; a repeated initiation then answers `200` with the failed payment. An adapter whose `verify` throws counts as not settled. A settlement mismatch leaves the payment in `requires_payment`, emits `ps.settlement.failed` with `reason=mismatch` and answers `409 settlement_mismatch`.

**Receipts are signed once per payment, even under concurrent requests.** Concurrent receipt calls for the same payment share one signing, and the stored JWT is returned from then on, so exactly one `ps.receipt.issued` is emitted. Rejected: signing per call, which would give each caller a different JWT.

**The payment store refuses duplicate payments.** `create` rejects a second payment for the same payer, request and option. Two concurrent initiations therefore cannot both create one, and the loser answers `200` with the winner's payment.

**The console log uses UTC and redacts defensively.** Pretty lines show the UTC time of day, so the log matches the ISO `at` field. Values that contain spaces are quoted. The sink shortens anything shaped like a JWT to its tail and replaces anything shaped like a Stripe secret, whatever the emitter passed. Startup and shutdown notices go to standard error, so standard output holds only events.

**Configuration is strict where a mistake would be silent.** The three private keys must differ, because the server agents trust the payment service only by its DID. `SANDBOX_NETWORK=off` without Stripe keys is refused, because the server would offer no way to pay. `STRIPE_WEBHOOK_SECRET` without the key pair is refused. Rejected: starting and failing at the first request.

**`pnpm setup:env` generates Ed25519 keys and quotes the JWKs.** All three identities are Ed25519 `did:key`s. Each JWK is written in single quotes so `node --env-file` reads the JSON verbatim. The file is created with mode 600, and the script refuses to overwrite an existing `.env`.

**Paid responses are not cached.** The `200` with a resource carries `Cache-Control: no-store`, like the `402`, because the content was paid for by one caller.

**The client compares the unsigned request after schema parsing.** The `402` body is parsed with the ACK payment request schema, then compared with the verified token payload as JSON, ignoring key order and absent keys. Any other difference (an amount, a payment service URL, the description) fails `payment_request_mismatch` before anything is paid. Rejected: comparing raw JSON text, which fails on harmless key order.

**The approval wait is counted in poll intervals.** The client sleeps `intervalMs` between polls and gives up once the intervals add up to `timeoutMs`, rather than reading the clock; the timers are what an abort cancels, so polling stops at once. Rejected: comparing clock readings, which ties the timeout to how the clock and the timers are driven.

**The client checks that the payment service answers about its own payment.** A `PaymentView` for another option, request, payer or network is `http_error`. A repeated initiation that finds the payment `settled` goes straight to the receipt; `failed` ends the run `payment_failed`. A receipt route that answers anything but `200` is `http_error`; the client does not retry it.

**The page's receipt panel shows what the agent verified.** `client.receipt.verified` carries the issuer, payer, option and expiry that `verifyPaymentReceipt` returned, and the page renders the receipt from that event. The panel therefore appears in the same update as the run's progress, and shows only checked values. Rejected: decoding the JWT again in the page, which would be asynchronous and unchecked.

**One client agent per run.** Each Fetch builds a new `PaywallClient` with its own event log, so a run's timeline holds only its own events. Fetch buttons are disabled while a run is in progress; Reset aborts the run and clears the page. The browser identity is loaded once at startup.

**The browser bundle needs no polyfill.** `vite build` bundles `agentcommercekit` 0.11.0 and its key, DID and JWT libraries for the browser without `Buffer` or `process` shims; the built page completes a sandbox purchase in Chrome. The bundle is about 540 kB (176 kB gzipped), over Vite's 500 kB advisory limit; it is left as one chunk because the page needs the ACK code before it can do anything. Rejected: code splitting for no load-time gain.

**A stored client key that is not an Ed25519 private JWK is replaced.** The page then generates a new identity rather than failing to start; the old DID is lost, which costs nothing because no state is tied to it.

**`ps.approval.decided` has the actor `human`.** The person holding the approver token made the decision; the payment service only records it. The event keeps its `ps.` name because the payment service emits it, and the log line reads `human ps.approval.decided`. Rejected: `payment-service` as the actor, which would hide who decided.

**The approver token is compared as SHA-256 digests with `timingSafeEqual`.** Hashing first makes both sides the same length, so the comparison takes the same time whatever was sent, including its length. The header must be exactly `Bearer <token>`; an empty configured token authorizes nobody. A `WWW-Authenticate: Bearer` header goes with every `401`.

**Malformed approver input answers `400 invalid_request`.** The contract named no code for a decision body that is not `approve` or `reject`, or a `status` filter that is not an approval status, so one code was added to the payment service error codes. Rejected: treating a bad body as `approve`, or silently ignoring an unknown filter.

**Approving calls `begin` before changing the status.** The approval's atomic decide ensures only one request gets this far; the adapter's `begin` then runs once while the payment is still `pending_approval`, and one compare-and-set moves it to `requires_payment` with its `next`. A payment is therefore never `requires_payment` without a next action. If `begin` throws, the payment fails and the decision stays recorded.

**An approval whose request expired is failed, not decided.** Approvals have no `expired` status, so a decision after expiry answers `410` and fails the payment, leaving the approval `pending` but unlisted; listing pending approvals fails and hides any whose request has expired, so the waiting client stops on its next poll. Rejected: recording a "rejected" decision nobody made.

**The approver panel is part of the page but not of the agent.** The page renders it as its own *Human approver* region, pointed at `<API base URL>/payment-service`; it keeps the token in component state, refreshes its list every three seconds once loaded, and drops the token when the server answers `401`. The `client.approval.waiting` label became "Client paused until the approver decides", so the timeline does not keep saying the run is waiting for a human after the human has decided.
