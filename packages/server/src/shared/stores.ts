import type { DidUri } from "@paywall/protocol"
import type { Approval, ApprovalStore, PaymentRecord, PaymentStore } from "../payment-service/types.ts"
import type { IssuedPaymentRequest, PaymentRequestStore } from "../server-agent/index.ts"

// Every store hands out and keeps copies, so a caller can never change a
// stored record except through the store. Each check-and-set runs without an
// `await` between the check and the write, which is what makes it atomic in
// a single Node process.

/** Creates an in-memory store of issued payment requests. Contents last as long as the process. */
export function createMemoryPaymentRequestStore(): PaymentRequestStore {
  const records = new Map<string, IssuedPaymentRequest>()
  return {
    async save(record) {
      records.set(record.id, structuredClone(record))
    },
    async get(id) {
      const record = records.get(id)
      return record && structuredClone(record)
    },
    async redeem(id, at) {
      const record = records.get(id)
      if (!record || record.redeemedAt) return false
      record.redeemedAt = new Date(at.getTime())
      return true
    },
  }
}

/**
 * Thrown by {@link createMemoryPaymentStore}'s `create` when a payment with
 * the same id, or the same payer, request and option, already exists.
 */
export class DuplicatePaymentError extends Error {
  constructor() {
    super("a payment for this payer, request and option already exists")
    this.name = "DuplicatePaymentError"
  }
}

/**
 * Creates an in-memory payment store. Contents last as long as the process.
 *
 * `create` rejects with {@link DuplicatePaymentError} when the payer already
 * has a payment for the request and option, so two concurrent initiations
 * cannot both create one. In a `transition` patch, a field set to
 * `undefined` is removed from the record.
 */
export function createMemoryPaymentStore(): PaymentStore {
  const records = new Map<string, PaymentRecord>()
  const byKey = new Map<string, string>()
  const keyOf = (payer: DidUri, paymentRequestId: string, paymentOptionId: string) =>
    JSON.stringify([payer, paymentRequestId, paymentOptionId])

  return {
    async create(record) {
      const key = keyOf(record.payer, record.paymentRequestId, record.paymentOptionId)
      if (records.has(record.id) || byKey.has(key)) throw new DuplicatePaymentError()
      records.set(record.id, structuredClone(record))
      byKey.set(key, record.id)
    },
    async get(id) {
      const record = records.get(id)
      return record && structuredClone(record)
    },
    async findByKey(payer, paymentRequestId, paymentOptionId) {
      const id = byKey.get(keyOf(payer, paymentRequestId, paymentOptionId))
      const record = id === undefined ? undefined : records.get(id)
      return record && structuredClone(record)
    },
    async transition(id, from, patch) {
      const record = records.get(id)
      if (!record || record.status !== from) return false
      const next: Record<string, unknown> = { ...record }
      for (const [field, value] of Object.entries(structuredClone(patch))) {
        if (field === "id") continue
        if (value === undefined) delete next[field]
        else next[field] = value
      }
      records.set(id, next as unknown as PaymentRecord)
      return true
    },
  }
}

/** Creates an in-memory approval store. Contents last as long as the process. `list` returns approvals oldest first. */
export function createMemoryApprovalStore(): ApprovalStore {
  const approvals = new Map<string, Approval>()
  return {
    async create(approval) {
      if (approvals.has(approval.id)) throw new Error("an approval with this id already exists")
      approvals.set(approval.id, structuredClone(approval))
    },
    async get(id) {
      const approval = approvals.get(id)
      return approval && structuredClone(approval)
    },
    async list(status) {
      return [...approvals.values()]
        .filter((approval) => status === undefined || approval.status === status)
        .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime())
        .map((approval) => structuredClone(approval))
    },
    async decide(id, status, at, note) {
      const approval = approvals.get(id)
      if (!approval || approval.status !== "pending") return false
      approval.status = status
      approval.decidedAt = new Date(at.getTime())
      if (note !== undefined) approval.note = note
      return true
    },
  }
}
