import { NotImplementedError } from "@paywall/protocol"
import type { PaymentExecutor } from "./types.ts"

/**
 * Creates the executor for the sandbox network: it asks the payment service
 * to settle the payment in its sandbox ledger. Throws when that call fails.
 */
export function createSandboxExecutor(): PaymentExecutor {
  throw new NotImplementedError("T4")
}
