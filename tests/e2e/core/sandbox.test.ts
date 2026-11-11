import * as v from "valibot"
import { afterEach, describe, expect, it, vi } from "vitest"
import { paymentRequiredBodySchema, RECEIPT_HEADER } from "@paywall/protocol"
import { ACME_CATALOG } from "@paywall/server"
import { resourceUrl, SANDBOX_HAPPY_PATH, setupSystem } from "../support.ts"

afterEach(() => {
  vi.useRealTimers()
})

describe("end to end over the sandbox network", () => {
  it("E2E-1: market-brief over sandbox: 402, payment, receipt, 200, with the merged events in protocol order", async () => {
    const { client, log } = setupSystem()
    const state = await client.fetchPaid(resourceUrl("/api/resources/market-brief"))
    expect(state.status, JSON.stringify(state.failure)).toBe("delivered")
    expect(state.resource).toEqual({
      id: "market-brief",
      title: "Market brief",
      content: ACME_CATALOG.find((r) => r.id === "market-brief")?.content,
    })
    expect(state.selectedOption?.id).toBe("sandbox-usd")
    expect(state.payment?.policy).toEqual({ outcome: "allow", rule: "within_limits" })
    expect(log.names()).toEqual([...SANDBOX_HAPPY_PATH])
    // One payment request id threads through the server and payment service events.
    const ids = new Set(log.events.filter((e) => e.paymentRequestId).map((e) => e.paymentRequestId))
    expect(ids.size).toBe(1)
  })

  it("E2E-2: presenting the same receipt a second time is refused", async () => {
    const { client, fetch, log } = setupSystem()
    const state = await client.fetchPaid(resourceUrl("/api/resources/market-brief"))
    expect(state.status).toBe("delivered")

    const replay = await fetch(resourceUrl("/api/resources/market-brief"), { headers: { [RECEIPT_HEADER]: state.receipt as string } })
    expect(replay.status).toBe(402)
    const body = v.parse(paymentRequiredBodySchema, await replay.json())
    expect(body.error?.code).toBe("receipt_already_redeemed")
    expect(log.all("server.resource.delivered")).toHaveLength(1)
    expect(log.one("server.receipt.rejected").data?.code).toBe("receipt_already_redeemed")
  })

  it("E2E-3: partner-feed from Globex is denied by policy; nothing settles and nothing is delivered", async () => {
    const { client, log } = setupSystem()
    const state = await client.fetchPaid(resourceUrl("/partner/resources/partner-feed"))
    expect(state.status).toBe("failed")
    expect(state.failure?.code).toBe("policy_denied")
    expect(state.failure?.details).toMatchObject({ rule: "counterparty_not_allowed" })
    expect(state.resource).toBeUndefined()

    expect(log.one("ps.policy.evaluated").data).toMatchObject({ outcome: "deny", rule: "counterparty_not_allowed" })
    const names = log.names()
    for (const name of ["ps.settlement.started", "ps.settlement.confirmed", "ps.receipt.issued", "server.resource.delivered"] as const) {
      expect(names).not.toContain(name)
    }
    expect(names.at(-1)).toBe("client.flow.failed")
  })
})
