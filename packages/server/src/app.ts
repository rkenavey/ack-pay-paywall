import { getDidResolver, type Resolvable } from "agentcommercekit"
import { Hono, type MiddlewareHandler } from "hono"
import { cors } from "hono/cors"
import { randomIds, RECEIPT_HEADER, systemClock, type Clock, type ErrorBody, type EventLog, type IdGenerator } from "@paywall/protocol"
import { createPaymentService, createSandboxAdapter } from "./payment-service/index.ts"
import { createStripeAdapter, createStripeGateway } from "./payment-service/stripe/index.ts"
import type { PaymentServiceDeps, SettlementAdapter, StripeGateway } from "./payment-service/types.ts"
import { evaluateSpend } from "./policy/index.ts"
import { createServerAgent } from "./server-agent/index.ts"
import { ACME_CATALOG, GLOBEX_CATALOG } from "./shared/catalog.ts"
import type { AppConfig } from "./shared/config.ts"
import { identityFromJwk } from "./shared/identity.ts"
import { createConsoleEventLog } from "./shared/log.ts"
import { createMemoryApprovalStore, createMemoryPaymentRequestStore, createMemoryPaymentStore } from "./shared/stores.ts"

/**
 * Replacements for the parts of the app that touch the outside world. Tests
 * pass a fixed clock, sequential ids, a memory event log or a fake Stripe
 * gateway; production passes nothing.
 */
export interface AppOverrides {
  clock?: Clock
  ids?: IdGenerator
  log?: EventLog
  resolver?: Resolvable
  stripeGateway?: StripeGateway
}

/** The path the payment service is mounted at, below `publicBaseUrl`. */
const PAYMENT_SERVICE_PATH = "/payment-service"

/**
 * CORS for the one client origin. A request from any other origin, or with no
 * origin, passes through with no CORS headers at all, so the browser grants
 * nothing; a preflight from another origin is not answered as one.
 */
function corsFor(clientOrigin: string): MiddlewareHandler {
  const grant = cors({
    origin: clientOrigin,
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", RECEIPT_HEADER],
    maxAge: 600,
  })
  return async (c, next) => {
    if (c.req.header("Origin") === clientOrigin) return grant(c, next)
    await next()
    c.header("Vary", "Origin", { append: true })
  }
}

/**
 * Builds the whole server: the Acme server agent at `/api`, the Globex server
 * agent at `/partner` and the payment service at `/payment-service`, each
 * with its own identity, with CORS limited to `config.clientOrigin`.
 *
 * Without overrides it uses the system clock, random ids, the console event
 * log in `config.logFormat`, a `did:key` resolver and, when `config.stripe`
 * is set, the real Stripe gateway. Stripe is offered only with keys. Throws when no payment
 * network can be offered.
 */
export function buildApp(config: AppConfig, overrides: AppOverrides = {}): Hono {
  const clock = overrides.clock ?? systemClock
  const ids = overrides.ids ?? randomIds
  const log = overrides.log ?? createConsoleEventLog({ format: config.logFormat, clock })
  const resolver = overrides.resolver ?? getDidResolver()

  const acme = identityFromJwk(config.acmeAgentJwk)
  const globex = identityFromJwk(config.globexAgentJwk)
  const paymentServiceIdentity = identityFromJwk(config.paymentServiceJwk)
  const paymentServiceUrl = `${config.publicBaseUrl}${PAYMENT_SERVICE_PATH}`

  const adapters: SettlementAdapter[] = []
  if (config.sandboxNetwork) adapters.push(createSandboxAdapter())
  let stripe: PaymentServiceDeps["stripe"]
  if (config.stripe) {
    const gateway =
      overrides.stripeGateway ??
      createStripeGateway({
        secretKey: config.stripe.secretKey,
        ...(config.stripe.webhookSecret === undefined ? {} : { webhookSecret: config.stripe.webhookSecret }),
      })
    adapters.push(createStripeAdapter({ gateway, publishableKey: config.stripe.publishableKey, clock }))
    stripe = { gateway, webhookConfigured: config.stripe.webhookSecret !== undefined }
  }
  const networks = adapters.map((adapter) => adapter.network)
  if (networks.length === 0) throw new Error("no payment network is available: set SANDBOX_NETWORK=on or the Stripe keys")

  const agent = (identity: typeof acme, catalog: typeof ACME_CATALOG) =>
    createServerAgent({
      identity,
      catalog,
      store: createMemoryPaymentRequestStore(),
      paymentService: { url: paymentServiceUrl, did: paymentServiceIdentity.did, networks },
      paymentRequestTtlSeconds: config.paymentRequestTtlSeconds,
      resolver,
      clock,
      ids,
      log,
    })

  const paymentService = createPaymentService({
    identity: paymentServiceIdentity,
    publicUrl: paymentServiceUrl,
    policy: (request) => evaluateSpend(request, config.policy),
    adapters,
    payments: createMemoryPaymentStore(),
    approvals: createMemoryApprovalStore(),
    approverToken: config.approverToken,
    receiptTtlSeconds: config.receiptTtlSeconds,
    ...(stripe === undefined ? {} : { stripe }),
    resolver,
    clock,
    ids,
    log,
  })

  const app = new Hono()
  app.use("*", corsFor(config.clientOrigin))
  app.route("/api", agent(acme, ACME_CATALOG))
  app.route("/partner", agent(globex, GLOBEX_CATALOG))
  app.route(PAYMENT_SERVICE_PATH, paymentService)
  app.notFound((c) => c.json<ErrorBody>({ error: { code: "not_found", message: "No such route." } }, 404))
  app.onError((_error, c) => c.json<ErrorBody>({ error: { code: "internal_error", message: "The server failed." } }, 500))
  return app
}
