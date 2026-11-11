import { NotImplementedError } from "@paywall/protocol"
import type { ApprovalStore, PaymentStore } from "../payment-service/types.ts"
import type { PaymentRequestStore } from "../server-agent/index.ts"

/** Creates an in-memory store of issued payment requests. Contents last as long as the process. */
export function createMemoryPaymentRequestStore(): PaymentRequestStore {
  throw new NotImplementedError("T3")
}

/** Creates an in-memory payment store. Contents last as long as the process. */
export function createMemoryPaymentStore(): PaymentStore {
  throw new NotImplementedError("T3")
}

/** Creates an in-memory approval store. Contents last as long as the process. */
export function createMemoryApprovalStore(): ApprovalStore {
  throw new NotImplementedError("T3")
}
