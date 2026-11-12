import { createHash, timingSafeEqual } from "node:crypto"
import { Hono, type Context } from "hono"
import * as v from "valibot"
import {
  approvalDecisionBodySchema,
  type ApprovalListBody,
  type ApprovalView,
  type ErrorBody,
  type Network,
  type PaymentServiceErrorCode,
} from "@paywall/protocol"
import type { Approval, PaymentRecord, PaymentServiceDeps, SettlementAdapter } from "../types.ts"

/**
 * What the approver routes need from the payment service that mounts them:
 * its stores, clock, log and approver token, its settlement adapters, and its
 * ways of failing a payment and of releasing settlement it started.
 */
export interface ApproverRoutesContext {
  deps: Pick<PaymentServiceDeps, "payments" | "approvals" | "approverToken" | "clock" | "log">
  adapter(network: Network): SettlementAdapter | undefined
  /** Moves a payment that has not settled to `failed`, cancelling its PaymentIntent, and logs `ps.settlement.failed`. */
  fail(record: PaymentRecord, failure: string, reason: string): Promise<PaymentRecord>
  /** Cancels whatever settlement was started for a payment that is no longer payable. */
  release(record: PaymentRecord): Promise<void>
}

type Status = 400 | 401 | 404 | 409 | 410 | 500

const APPROVAL_STATUSES = ["pending", "approved", "rejected"] as const

/** SHA-256 first, so both sides are the same length and the comparison takes the same time whatever was sent. */
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest()

/**
 * True only when `header` is `Bearer <token>` with exactly the approver
 * token. An unset or empty token authorizes nobody.
 */
export function isApprover(header: string | undefined, approverToken: string): boolean {
  if (!approverToken || !header) return false
  const match = /^Bearer ([^\s]+)$/i.exec(header)
  if (!match?.[1]) return false
  return timingSafeEqual(digest(match[1]), digest(approverToken))
}

/**
 * Builds the human approver's routes, mounted at `/approvals` in the payment
 * service: `GET /` lists approvals (`?status=pending`) and
 * `POST /:id/decision` approves or rejects one.
 *
 * Every route requires `Authorization: Bearer <APPROVER_TOKEN>` and answers
 * `401 unauthorized` otherwise. A decision is final and applies once, even
 * under concurrent requests. Approving starts settlement with the payment's
 * adapter exactly once; rejecting moves the payment to `rejected`. Deciding
 * after the payment request expired fails the payment and answers `410`.
 * The decision is logged as `ps.approval.decided` with the actor `human`.
 */
export function createApproverRoutes(ctx: ApproverRoutesContext): Hono {
  const { payments, approvals, clock, log } = ctx.deps
  const app = new Hono()

  const refuse = (c: Context, status: Status, code: PaymentServiceErrorCode | "internal_error", message: string) =>
    c.json<ErrorBody>({ error: { code, message } }, status)

  app.onError((_error, c) => refuse(c, 500, "internal_error", "The approval could not be processed; no payment was made."))

  app.use("*", async (c, next) => {
    if (!isApprover(c.req.header("Authorization"), ctx.deps.approverToken)) {
      c.header("WWW-Authenticate", 'Bearer realm="approver"')
      return refuse(c, 401, "unauthorized", "The approver token is missing or wrong.")
    }
    await next()
  })

  app.get("/", async (c) => {
    const status = c.req.query("status")
    if (status !== undefined && !(APPROVAL_STATUSES as readonly string[]).includes(status)) {
      return refuse(c, 400, "invalid_request", `status must be one of ${APPROVAL_STATUSES.join(", ")}.`)
    }
    const listed = await approvals.list(status as Approval["status"] | undefined)
    const views: ApprovalView[] = []
    for (const approval of listed) {
      let payment = await payments.get(approval.paymentId)
      if (!payment) continue
      if (approval.status === "pending") {
        // A request that expired while it waited can no longer be paid: fail it so the client stops waiting.
        if (expired(payment)) payment = await ctx.fail(payment, "The payment request expired before a human decided.", "expired")
        if (payment.status !== "pending_approval") continue
      }
      views.push(toApprovalView(approval, payment))
    }
    return c.json<ApprovalListBody>({ approvals: views })
  })

  app.post("/:id/decision", async (c) => {
    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      return refuse(c, 400, "invalid_request", 'The body must be JSON: { "decision": "approve" | "reject", "note"?: string }.')
    }
    const body = v.safeParse(approvalDecisionBodySchema, raw)
    if (!body.success) return refuse(c, 400, "invalid_request", 'decision must be "approve" or "reject", and note a string.')
    const { decision, note } = body.output

    const approval = await approvals.get(c.req.param("id"))
    if (!approval) return refuse(c, 404, "approval_not_found", "No such approval.")
    const alreadyDecided = () => refuse(c, 409, "approval_already_decided", "This approval was already decided; a decision is final.")
    if (approval.status !== "pending") return alreadyDecided()
    const payment = await payments.get(approval.paymentId)
    if (!payment) return refuse(c, 500, "internal_error", "The approval has no payment.")

    if (expired(payment)) {
      await ctx.fail(payment, "The payment request expired before a human decided.", "expired")
      return refuse(c, 410, "payment_request_expired", "The payment request has expired; the payment failed.")
    }
    if (payment.status !== "pending_approval") return alreadyDecided()

    const now = clock.now()
    const status = decision === "approve" ? "approved" : "rejected"
    // The store applies only the first decision, so concurrent requests cannot both act.
    if (!(await approvals.decide(approval.id, status, now, note))) return alreadyDecided()
    log.emit({
      name: "ps.approval.decided",
      actor: "human",
      paymentRequestId: payment.paymentRequestId,
      paymentId: payment.id,
      data: { approvalId: approval.id, decision, outcome: status, noted: note !== undefined },
    })

    if (decision === "approve") await startSettlement(payment)
    else await payments.transition(payment.id, "pending_approval", { status: "rejected" })

    const decided = (await approvals.get(approval.id)) ?? { ...approval, status, decidedAt: now }
    return c.json(toApprovalView(decided, (await payments.get(payment.id)) ?? payment))
  })

  function expired(payment: PaymentRecord): boolean {
    return payment.expiresAt !== undefined && payment.expiresAt.getTime() <= clock.now().getTime()
  }

  /**
   * Calls the adapter's `begin` once and moves the payment to
   * `requires_payment` with its next action in one compare-and-set, so the
   * payment is never payable without one.
   */
  async function startSettlement(payment: PaymentRecord): Promise<void> {
    const adapter = ctx.adapter(payment.network)
    let next
    try {
      if (!adapter) throw new Error("no adapter")
      next = await adapter.begin(payment)
    } catch {
      await ctx.fail(payment, "Settlement could not be started.", "failed")
      return
    }
    if (await payments.transition(payment.id, "pending_approval", { status: "requires_payment", next })) {
      log.emit({
        name: "ps.settlement.started",
        actor: "payment-service",
        paymentRequestId: payment.paymentRequestId,
        paymentId: payment.id,
        data: { network: payment.network, next: next.type },
      })
    } else {
      // The payment failed while settlement was starting; nothing may stay payable for it.
      await ctx.release(payment)
    }
  }

  return app
}

/** The approver's view of an approval and the payment it holds. */
function toApprovalView(approval: Approval, payment: PaymentRecord): ApprovalView {
  return {
    approvalId: approval.id,
    paymentId: approval.paymentId,
    status: approval.status,
    payer: payment.payer,
    payee: payment.payee,
    amount: { ...payment.amount },
    ...(payment.description === undefined ? {} : { description: payment.description }),
    requestedAt: approval.requestedAt.toISOString(),
    ...(approval.decidedAt === undefined ? {} : { decidedAt: approval.decidedAt.toISOString() }),
    ...(approval.note === undefined ? {} : { note: approval.note }),
  }
}
