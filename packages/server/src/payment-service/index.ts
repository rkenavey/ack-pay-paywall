import type { Hono } from "hono"
import { NotImplementedError } from "@paywall/protocol"
import type { PaymentServiceDeps, SandboxAdapter } from "./types.ts"

/** The payment service types: payments, stores, settlement adapters, the Stripe gateway seam and approvals. */
export type * from "./types.ts"

/**
 * Builds the payment service, which is also the receipt service.
 *
 * It verifies signed payment initiations, applies the spend policy before any
 * money moves, holds payments that need a human, drives settlement through
 * the adapters, and signs a `PaymentReceiptCredential` only after it has
 * verified settlement itself. Mount the returned app under `/payment-service`.
 */
export function createPaymentService(deps: PaymentServiceDeps): Hono {
  void deps
  throw new NotImplementedError("T3")
}

/**
 * Creates the sandbox settlement adapter: `begin` asks the client to call the
 * sandbox settle route, and `verify` reads an in-memory ledger. No real money
 * moves.
 */
export function createSandboxAdapter(): SandboxAdapter {
  throw new NotImplementedError("T3")
}
