import { createJwt } from "agentcommercekit"
import * as v from "valibot"
import { afterEach, describe, expect, it, vi } from "vitest"
import { approvalListBodySchema, approvalViewSchema, type ApprovalView } from "@paywall/protocol"
import { APPROVER_TOKEN, fixtures, PAYMENT_SERVICE_URL } from "@paywall/testkit"
import { expectError, expectView, setupPaymentService, usd } from "../payment-service/harness.ts"

afterEach(() => {
  vi.useRealTimers()
})

const auth = (token = APPROVER_TOKEN) => ({ Authorization: `Bearer ${token}` })

async function pendingPayment(ps: ReturnType<typeof setupPaymentService>, o: { expiresInMs?: number } = {}) {
  const { paymentRequestToken } = await ps.request({ amount: 7500, description: "Annual report", ...o })
  const view = await expectView(await ps.initiate(paymentRequestToken), 202)
  return { view, paymentRequestToken, approvalId: view.approvalId as string }
}

function decide(ps: ReturnType<typeof setupPaymentService>, approvalId: string, decision: "approve" | "reject", headers: Record<string, string> = auth(), note?: string) {
  return ps.post(`/approvals/${approvalId}/decision`, { decision, ...(note ? { note } : {}) }, headers)
}

async function expectApproval(response: Response, status = 200): Promise<ApprovalView> {
  const raw = await response.json()
  expect(response.status, JSON.stringify(raw)).toBe(status)
  return v.parse(approvalViewSchema, raw)
}

describe("approver routes", () => {
  it("APR-1: the approver routes answer 401 without the bearer token, with a wrong token, and with a client-signed JWT", async () => {
    const ps = setupPaymentService()
    const { approvalId } = await pendingPayment(ps)
    const clientJwt = await createJwt(
      { aud: PAYMENT_SERVICE_URL, role: "approver" },
      { issuer: fixtures.client.did, signer: fixtures.client.signer, expiresIn: 300 },
      { alg: fixtures.client.alg },
    )
    const badHeaders: Array<Record<string, string>> = [
      {},
      auth("wrong-token-wrong-token-wrong"),
      auth(`${APPROVER_TOKEN}x`),
      auth(APPROVER_TOKEN.slice(0, -1)),
      auth(clientJwt),
      { Authorization: APPROVER_TOKEN },
      { Authorization: `Basic ${APPROVER_TOKEN}` },
    ]
    for (const headers of badHeaders) {
      await expectError(await ps.app.request("/approvals?status=pending", { headers }), 401, "unauthorized")
      await expectError(await decide(ps, approvalId, "approve", headers), 401, "unauthorized")
    }
    expect((await expectView(await ps.getPayment((await ps.approvals.get(approvalId))?.paymentId as string), 200)).status).toBe(
      "pending_approval",
    )
    expect(ps.beginCalls()).toBe(0)
  })

  it("APR-2: the pending list shows each waiting payment with payer, payee, amount and description", async () => {
    const ps = setupPaymentService()
    const { view, approvalId } = await pendingPayment(ps)
    const response = await ps.app.request("/approvals?status=pending", { headers: auth() })
    expect(response.status).toBe(200)
    const { approvals } = v.parse(approvalListBodySchema, await response.json())
    expect(approvals).toEqual([
      {
        approvalId,
        paymentId: view.paymentId,
        status: "pending",
        payer: fixtures.client.did,
        payee: fixtures.acme.did,
        amount: usd(7500),
        description: "Annual report",
        requestedAt: ps.clock.now().toISOString(),
      },
    ])
  })

  it("APR-2: decided approvals leave the pending list", async () => {
    const ps = setupPaymentService()
    const { approvalId } = await pendingPayment(ps)
    await expectApproval(await decide(ps, approvalId, "reject"))
    const { approvals } = v.parse(approvalListBodySchema, await (await ps.app.request("/approvals?status=pending", { headers: auth() })).json())
    expect(approvals).toEqual([])
  })

  it("APR-3: approving moves the payment to requires_payment, calls begin once, sets next, and logs decided then started", async () => {
    const ps = setupPaymentService()
    const { view, approvalId } = await pendingPayment(ps)
    ps.clock.advanceSeconds(30)
    const approval = await expectApproval(await decide(ps, approvalId, "approve", auth(), "fine by me"))
    expect(approval).toMatchObject({ approvalId, status: "approved", decidedAt: ps.clock.now().toISOString(), note: "fine by me" })

    const payment = await expectView(await ps.getPayment(view.paymentId), 200)
    expect(payment.status).toBe("requires_payment")
    expect(payment.next).toEqual({ type: "sandbox_settle" })
    expect(ps.beginCalls()).toBe(1)

    const names = ps.log.names("ps.")
    expect(names).toEqual(["ps.payment.initiated", "ps.policy.evaluated", "ps.approval.requested", "ps.approval.decided", "ps.settlement.started"])
    expect(JSON.stringify(ps.log.one("ps.approval.decided").data)).toMatch(/approve/)

    // The approved payment then settles and gets its receipt.
    await expectView(await ps.settle(view.paymentId), 200)
    expect((await ps.receipt(view.paymentId)).status).toBe(200)
  })

  it("APR-4: rejecting moves the payment to rejected; the settle and receipt routes then answer 409", async () => {
    const ps = setupPaymentService()
    const { view, approvalId } = await pendingPayment(ps)
    expect((await expectApproval(await decide(ps, approvalId, "reject"))).status).toBe("rejected")
    expect((await expectView(await ps.getPayment(view.paymentId), 200)).status).toBe("rejected")
    await expectError(await ps.settle(view.paymentId), 409, "payment_not_payable")
    await expectError(await ps.receipt(view.paymentId), 409, "payment_not_settled")
    expect(ps.beginCalls()).toBe(0)
    expect(JSON.stringify(ps.log.one("ps.approval.decided").data)).toMatch(/reject/)
  })

  it("APR-5: a second decision answers 409 approval_already_decided and changes nothing", async () => {
    const ps = setupPaymentService()
    const { view, approvalId } = await pendingPayment(ps)
    const first = await expectApproval(await decide(ps, approvalId, "approve"))
    ps.clock.advanceSeconds(10)
    await expectError(await decide(ps, approvalId, "reject"), 409, "approval_already_decided")
    await expectError(await decide(ps, approvalId, "approve"), 409, "approval_already_decided")
    expect((await expectView(await ps.getPayment(view.paymentId), 200)).status).toBe("requires_payment")
    await expect(ps.approvals.get(approvalId)).resolves.toMatchObject({ status: "approved", decidedAt: new Date(first.decidedAt as string) })
    expect(ps.beginCalls()).toBe(1)
    expect(ps.log.all("ps.approval.decided")).toHaveLength(1)
  })

  it("APR-5: concurrent decisions on one approval apply exactly one", async () => {
    const ps = setupPaymentService()
    const { approvalId } = await pendingPayment(ps)
    const responses = await Promise.all([decide(ps, approvalId, "approve"), decide(ps, approvalId, "reject"), decide(ps, approvalId, "approve")])
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409, 409])
    expect(ps.log.all("ps.approval.decided")).toHaveLength(1)
    expect(ps.beginCalls()).toBeLessThanOrEqual(1)
  })

  it("APR-5: deciding an unknown approval answers 404 approval_not_found", async () => {
    const ps = setupPaymentService()
    await expectError(await decide(ps, "apr_unknown", "approve"), 404, "approval_not_found")
  })

  it("APR-6: deciding after the payment request expired answers 410 and the payment is failed", async () => {
    const ps = setupPaymentService()
    const { view, approvalId } = await pendingPayment(ps, { expiresInMs: 60_000 })
    ps.clock.advanceSeconds(61)
    await expectError(await decide(ps, approvalId, "approve"), 410, "payment_request_expired")
    const failed = await expectView(await ps.getPayment(view.paymentId), 200)
    expect(failed.status).toBe("failed")
    expect(failed.failure).toEqual(expect.any(String))
    expect(ps.beginCalls()).toBe(0)
    await expectError(await ps.settle(view.paymentId), 409, "payment_not_payable")
  })

  it("APR-7: initiating again after a rejection returns the same rejected payment and creates no new approval", async () => {
    const ps = setupPaymentService()
    const { view, approvalId, paymentRequestToken } = await pendingPayment(ps)
    await expectApproval(await decide(ps, approvalId, "reject"))
    const again = await expectView(await ps.initiate(paymentRequestToken), 200)
    expect(again).toMatchObject({ paymentId: view.paymentId, status: "rejected", approvalId })
    await expect(ps.approvals.list()).resolves.toHaveLength(1)
    expect(ps.beginCalls()).toBe(0)
  })
})
