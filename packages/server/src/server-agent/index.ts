import type { Resolvable } from "agentcommercekit"
import type { Hono } from "hono"
import {
  NotImplementedError,
  type AgentIdentity,
  type Clock,
  type DidUri,
  type EventLog,
  type IdGenerator,
  type Network,
  type ResourceSummary,
} from "@paywall/protocol"

/** A paywalled resource: its catalog summary plus the content delivered once it is paid for. */
export interface CatalogEntry extends ResourceSummary {
  content: string
}

/**
 * What a server agent remembers about a payment request it issued.
 *
 * The resource binding lives here and not in the token, because the ACK
 * payment request schema drops unknown fields.
 */
export interface IssuedPaymentRequest {
  id: string
  resourceId: string
  expiresAt: Date
  redeemedAt?: Date
}

/** Storage for issued payment requests. */
export interface PaymentRequestStore {
  save(record: IssuedPaymentRequest): Promise<void>
  get(id: string): Promise<IssuedPaymentRequest | undefined>
  /** Marks the request redeemed. Atomic: resolves true for the first caller only. */
  redeem(id: string, at: Date): Promise<boolean>
}

/**
 * Everything a server agent needs.
 *
 * `paymentService` says where clients pay (`url`), whose receipts are trusted
 * (`did`) and which networks to offer, one payment option per network, in
 * this order.
 */
export interface ServerAgentDeps {
  identity: AgentIdentity
  catalog: readonly CatalogEntry[]
  store: PaymentRequestStore
  paymentService: { url: string; did: DidUri; networks: readonly Network[] }
  paymentRequestTtlSeconds: number
  resolver: Resolvable
  clock: Clock
  ids: IdGenerator
  log: EventLog
}

/**
 * Builds a server agent: `GET /resources` lists the catalog for free, and
 * `GET /resources/:id` answers `402` with a signed ACK payment request until
 * the request carries a valid, unredeemed receipt in the `Payment-Receipt`
 * header. Each receipt is delivered once.
 *
 * Mount the returned app under a prefix such as `/api`.
 */
export function createServerAgent(deps: ServerAgentDeps): Hono {
  void deps
  throw new NotImplementedError("T3")
}

/** The identity, clock and id interfaces the server agent depends on, defined in the protocol package. */
export type { AgentIdentity, Clock, IdGenerator } from "@paywall/protocol"
