import { afterEach, describe, expect, it, vi } from "vitest"
import { elapse } from "@paywall/testkit"
import { resourceUrl } from "../support/fake-paywall.ts"
import { reach, setupClient } from "../support/client.ts"

afterEach(() => {
  vi.useRealTimers()
})

const URL_REPORT = resourceUrl("annual-report")
const POLL = { intervalMs: 1000, timeoutMs: 5000 }

function setupWaiting() {
  const setup = setupClient({ approvalPoll: POLL, fakeTimers: true })
  const polls = () => setup.paywall.stub.calls("GET", "/payment-service/payments/pay_0001").length
  return { ...setup, polls }
}

describe("waiting for approval", () => {
  it("CL-9: pending_approval is polled at the configured interval and approval continues to payment", async () => {
    const { client, paywall, clock, polls, log } = setupWaiting()
    const run = client.fetchPaid(URL_REPORT)
    const waiting = await reach(client, "awaiting_approval")
    expect(waiting.payment?.status).toBe("pending_approval")
    expect(log.names()).toContain("client.approval.waiting")

    await elapse(clock, 999)
    expect(polls()).toBe(0)
    await elapse(clock, 1)
    expect(polls()).toBe(1)
    await elapse(clock, 2000)
    expect(polls()).toBe(3)

    paywall.approve()
    await elapse(clock, 1000)
    const state = await run
    expect(state.status).toBe("delivered")
    expect(state.resource?.id).toBe("annual-report")
    expect(polls()).toBe(4)
    expect(paywall.stub.calls("POST", "/payment-service/payments")).toHaveLength(1)
  })

  it("CL-9: rejection fails approval_rejected and pays nothing", async () => {
    const { client, paywall, clock } = setupWaiting()
    const run = client.fetchPaid(URL_REPORT)
    await reach(client, "awaiting_approval")
    paywall.reject()
    await elapse(clock, 1000)
    const state = await run
    expect(state.status).toBe("failed")
    expect(state.failure?.code).toBe("approval_rejected")
    expect(paywall.stub.requests.filter((r) => r.path.endsWith("/settle") || r.path.endsWith("/receipt"))).toHaveLength(0)
  })

  it("CL-9: the poll timeout fails approval_timeout", async () => {
    const { client, paywall, clock, polls } = setupWaiting()
    let settled = false
    const run = client.fetchPaid(URL_REPORT).then((s) => {
      settled = true
      return s
    })
    await reach(client, "awaiting_approval")
    await elapse(clock, 4000)
    expect(settled).toBe(false)
    await elapse(clock, 1000)
    const state = await run
    expect(state.status).toBe("failed")
    expect(state.failure?.code).toBe("approval_timeout")
    expect(polls()).toBeLessThanOrEqual(5)
    expect(paywall.stub.requests.filter((r) => r.path.endsWith("/settle"))).toHaveLength(0)
  })

  it("CL-9: subscribe observes awaiting_approval between initiating and paying", async () => {
    const { client, paywall, clock, statuses } = setupWaiting()
    const run = client.fetchPaid(URL_REPORT)
    await reach(client, "awaiting_approval")
    paywall.approve()
    await elapse(clock, 1000)
    await run
    expect(statuses().filter((s) => s !== "idle")).toEqual([
      "requesting",
      "verifying_request",
      "selecting_option",
      "initiating",
      "awaiting_approval",
      "paying",
      "fetching_receipt",
      "retrying",
      "delivered",
    ])
  })

  it("CL-13: aborting the signal stops polling and fails aborted", async () => {
    const { client, clock, polls } = setupWaiting()
    const controller = new AbortController()
    const run = client.fetchPaid(URL_REPORT, { signal: controller.signal })
    await reach(client, "awaiting_approval")
    await elapse(clock, 2000)
    expect(polls()).toBe(2)

    controller.abort()
    const state = await run
    expect(state.status).toBe("failed")
    expect(state.failure?.code).toBe("aborted")
    await elapse(clock, 10_000)
    expect(polls()).toBe(2)
  })

  it("CL-13: a signal aborted before the call fails aborted without paying", async () => {
    const { client, paywall } = setupWaiting()
    const controller = new AbortController()
    controller.abort()
    const state = await client.fetchPaid(resourceUrl("market-brief"), { signal: controller.signal })
    expect(state.status).toBe("failed")
    expect(state.failure?.code).toBe("aborted")
    expect(paywall.paymentServiceCalls()).toHaveLength(0)
  })
})
