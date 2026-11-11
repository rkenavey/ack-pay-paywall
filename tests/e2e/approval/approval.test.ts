import * as v from "valibot"
import { afterEach, describe, expect, it, vi } from "vitest"
import { approvalListBodySchema } from "@paywall/protocol"
import { APPROVER_TOKEN, elapse } from "@paywall/testkit"
import { reach, resourceUrl, setupSystem } from "../support.ts"

afterEach(() => {
  vi.useRealTimers()
})

async function decidePending(fetch: typeof globalThis.fetch, decision: "approve" | "reject") {
  const headers = { Authorization: `Bearer ${APPROVER_TOKEN}` }
  const listed = await fetch(resourceUrl("/payment-service/approvals?status=pending"), { headers })
  expect(listed.status).toBe(200)
  const { approvals } = v.parse(approvalListBodySchema, await listed.json())
  expect(approvals).toHaveLength(1)
  const [approval] = approvals
  expect(approval?.description).toBe("Annual report")
  const decided = await fetch(resourceUrl(`/payment-service/approvals/${approval?.approvalId}/decision`), {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ decision }),
  })
  expect(decided.status).toBe(200)
}

describe("end to end with human approval", () => {
  it("E2E-5: annual-report waits, the approver approves, the payment completes, 200", async () => {
    const { client, fetch, log, clock } = setupSystem({ fakeTimers: true })
    const run = client.fetchPaid(resourceUrl("/api/resources/annual-report"))
    const waiting = await reach(client, "awaiting_approval")
    expect(waiting.payment?.status).toBe("pending_approval")

    await elapse(clock, 3000)
    await decidePending(fetch, "approve")
    await elapse(clock, 1000)
    const state = await run
    expect(state.status, JSON.stringify(state.failure)).toBe("delivered")
    expect(state.resource?.id).toBe("annual-report")

    const names = log.names()
    const order = ["ps.policy.evaluated", "ps.approval.requested", "client.approval.waiting", "ps.approval.decided", "ps.settlement.started", "server.resource.delivered"] as const
    const positions = order.map((name) => names.indexOf(name))
    expect(positions.every((p) => p >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    expect(log.one("ps.policy.evaluated").data).toMatchObject({ outcome: "needs_approval", rule: "amount_over_threshold" })
  })

  it("E2E-6: annual-report rejected: the client ends approval_rejected and the resource is never delivered", async () => {
    const { client, fetch, log, clock } = setupSystem({ fakeTimers: true })
    const run = client.fetchPaid(resourceUrl("/api/resources/annual-report"))
    await reach(client, "awaiting_approval")
    await decidePending(fetch, "reject")
    await elapse(clock, 1000)
    const state = await run
    expect(state.status).toBe("failed")
    expect(state.failure?.code).toBe("approval_rejected")
    expect(state.resource).toBeUndefined()
    const names = log.names()
    expect(names).not.toContain("ps.settlement.started")
    expect(names).not.toContain("server.resource.delivered")
  })
})
