import type { Resolvable } from "agentcommercekit"
import type { Hono } from "hono"
import { NotImplementedError, type Clock, type EventLog, type IdGenerator } from "@paywall/protocol"
import type { StripeGateway } from "./payment-service/types.ts"
import type { AppConfig } from "./shared/config.ts"

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

/**
 * Builds the whole server: the Acme server agent at `/api`, the Globex server
 * agent at `/partner` and the payment service at `/payment-service`, each
 * with its own identity, with CORS limited to `config.clientOrigin`.
 */
export function buildApp(config: AppConfig, overrides?: AppOverrides): Hono {
  void config
  void overrides
  throw new NotImplementedError("T3")
}
