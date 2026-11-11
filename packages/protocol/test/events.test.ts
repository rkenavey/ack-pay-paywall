import { describe, expect, it } from "vitest"
import { actorOf, EVENT_LABELS, EVENT_NAMES, isEventName, randomIds, tokenTail } from "../src/index.ts"

describe("protocol events", () => {
  it("lists every step event of the sequence plus the three failure events, once each", () => {
    expect(new Set(EVENT_NAMES).size).toBe(EVENT_NAMES.length)
    expect(EVENT_NAMES).toHaveLength(26)
    for (const name of ["server.receipt.rejected", "ps.settlement.failed", "client.flow.failed"]) {
      expect(isEventName(name)).toBe(true)
    }
    expect(isEventName("client.coffee.made")).toBe(false)
  })

  it("has a readable label for every event and an actor from its prefix", () => {
    for (const name of EVENT_NAMES) expect(EVENT_LABELS[name].length).toBeGreaterThan(5)
    expect(actorOf("client.request.sent")).toBe("client-agent")
    expect(actorOf("server.resource.delivered")).toBe("server-agent")
    expect(actorOf("ps.receipt.issued")).toBe("payment-service")
  })

  it("refers to a token by its last 8 characters only", () => {
    const token = "eyJhbGciOiJFZERTQSJ9.eyJpc3MiOiJkaWQ6a2V5In0.c2lnbmF0dXJlLXNpZ25hdHVyZQ"
    expect(tokenTail(token)).toBe("…5hdHVyZQ")
    expect(tokenTail(token)).not.toContain(".")
  })

  it("random ids carry the prefix and 128 bits of hex", () => {
    const id = randomIds.next("pay")
    expect(id).toMatch(/^pay_[0-9a-f]{32}$/)
    expect(randomIds.next("pay")).not.toBe(id)
  })
})
