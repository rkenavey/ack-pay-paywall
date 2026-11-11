# Decisions

Choices that were left open, newest last.

**TypeScript 6.0, not 7.0.** typescript-eslint 8.72, the current release, declares support for TypeScript below 6.1 only. TypeScript 6.0.3 is the newest version it accepts. Rejected: TypeScript 7 with a linter that does not support it.

**valibot 1.4.1, not 1.5.0.** The ACK packages depend on valibot 1.4.1 exactly. Using the same version keeps one copy, so our schemas and the ACK schemas compose without two valibot runtimes. Rejected: the latest valibot with a second copy under ACK.

**@testing-library/user-event 14.6.8.** 14.6.9 was published the day the workspace was set up; the previous release was taken instead of excluding it from the package manager's release-age check.

**TypeScript runs from source.** Node 22.18 and later strip types, so the server runs `src/main.ts` directly and workspace packages export their `src/index.ts`. The code uses only erasable syntax and `.ts` import extensions. `pnpm build` builds the client bundle; the server has no build step. Rejected: compiling every package to `dist/`.

**Shared runtime interfaces live in the protocol package.** `AgentIdentity`, `Clock`, `IdGenerator`, the system clock and random ids, and `PolicyDecision` are used by both the server and the client, and the client cannot import the server. The protocol package holds them; the server re-exports the types `AgentIdentity`, `Clock` and `IdGenerator` from its server-agent module and `PolicyDecision` from its policy module. The system clock and random ids are the only code that reads the time or randomness.

**The policy module has its own stub error.** The policy may import only types from the protocol package, so its placeholder error class is local rather than the shared `NotImplementedError`.

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
