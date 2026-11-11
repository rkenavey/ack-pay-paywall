import { afterEach, describe, expect, it, vi } from "vitest"
import type { DidUri, Money } from "@paywall/protocol"
import { fixtures } from "@paywall/testkit"
import { evaluateSpend, type SpendPolicyConfig, type SpendRequest } from "../../src/policy/index.ts"

const usd = (amount: number): Money => ({ amount, decimals: 2, currency: "USD" })
const threshold = usd(5000)
const config: SpendPolicyConfig = { allowedCounterparties: [fixtures.acme.did], approvalThreshold: threshold }

function request(overrides: Partial<SpendRequest> = {}): SpendRequest {
  return {
    payer: fixtures.client.did,
    counterparty: fixtures.acme.did,
    amount: usd(500),
    paymentRequestId: "pr_0001",
    description: "Market brief",
    ...overrides,
  }
}

const allow = { outcome: "allow", rule: "within_limits" }
const needsApproval = { outcome: "needs_approval", rule: "amount_over_threshold", threshold }
const deny = (rule: string) => ({ outcome: "deny", rule })

afterEach(() => {
  vi.useRealTimers()
})

describe("evaluateSpend", () => {
  it("POL-1: an allowlisted counterparty under the threshold is allowed", () => {
    expect(evaluateSpend(request(), config)).toEqual(allow)
    expect(evaluateSpend(request({ amount: usd(1) }), config)).toEqual(allow)
    expect(evaluateSpend(request({ amount: usd(4999) }), config)).toEqual(allow)
  })

  it("POL-1: a counterparty anywhere on a longer allowlist is allowed", () => {
    const wide: SpendPolicyConfig = { ...config, allowedCounterparties: [fixtures.globex.did, fixtures.acme.did] }
    expect(evaluateSpend(request(), wide)).toEqual(allow)
    expect(evaluateSpend(request({ counterparty: fixtures.globex.did }), wide)).toEqual(allow)
  })

  it("POL-2: exactly the threshold is allowed and one minor unit more needs approval, with the threshold in the decision", () => {
    expect(evaluateSpend(request({ amount: usd(5000) }), config)).toEqual(allow)
    expect(evaluateSpend(request({ amount: usd(5001) }), config)).toEqual(needsApproval)
    expect(evaluateSpend(request({ amount: usd(7500) }), config)).toEqual(needsApproval)
    expect(evaluateSpend(request({ amount: usd(Number.MAX_SAFE_INTEGER) }), config)).toEqual(needsApproval)
  })

  it("POL-2: the threshold comes from the configuration", () => {
    const higher: SpendPolicyConfig = { ...config, approvalThreshold: usd(10000) }
    expect(evaluateSpend(request({ amount: usd(7500) }), higher)).toEqual(allow)
    expect(evaluateSpend(request({ amount: usd(10001) }), higher)).toEqual({ ...needsApproval, threshold: usd(10000) })
  })

  it("POL-3: a counterparty off the list is denied at any amount, including above the threshold", () => {
    for (const amount of [1, 500, 5000, 5001, 7500, 1_000_000]) {
      expect(evaluateSpend(request({ counterparty: fixtures.globex.did, amount: usd(amount) }), config)).toEqual(
        deny("counterparty_not_allowed"),
      )
    }
  })

  it("POL-3: the payer being allowlisted does not make the counterparty allowed", () => {
    const payerListed: SpendPolicyConfig = { ...config, allowedCounterparties: [fixtures.client.did] }
    expect(evaluateSpend(request(), payerListed)).toEqual(deny("counterparty_not_allowed"))
  })

  it("POL-4: an empty allowlist denies everything", () => {
    const empty: SpendPolicyConfig = { ...config, allowedCounterparties: [] }
    for (const counterparty of [fixtures.acme.did, fixtures.globex.did]) {
      for (const amount of [1, 5000, 5001]) {
        expect(evaluateSpend(request({ counterparty, amount: usd(amount) }), empty)).toEqual(deny("counterparty_not_allowed"))
      }
    }
  })

  it("POL-5: another currency or another number of decimals is denied currency_not_supported", () => {
    expect(evaluateSpend(request({ amount: { amount: 500, decimals: 2, currency: "EUR" } }), config)).toEqual(
      deny("currency_not_supported"),
    )
    expect(evaluateSpend(request({ amount: { amount: 500, decimals: 2, currency: "usd" } }), config)).toEqual(
      deny("currency_not_supported"),
    )
    expect(evaluateSpend(request({ amount: { amount: 500, decimals: 3, currency: "USD" } }), config)).toEqual(
      deny("currency_not_supported"),
    )
    expect(evaluateSpend(request({ amount: { amount: 500, decimals: 0, currency: "USD" } }), config)).toEqual(
      deny("currency_not_supported"),
    )
  })

  it("POL-5: zero, negative, fractional, unsafe and non-number amounts are denied invalid_amount", () => {
    const bad: unknown[] = [0, -0, -1, -5000, 1.5, 5000.01, Number.MAX_SAFE_INTEGER + 1, 2 ** 60, Number.NaN, Number.POSITIVE_INFINITY, "500", null, undefined, 500n, {}]
    for (const amount of bad) {
      const money = { amount, decimals: 2, currency: "USD" } as unknown as Money
      expect(evaluateSpend(request({ amount: money }), config)).toEqual(deny("invalid_amount"))
    }
  })

  it("POL-5: the rules apply in order: invalid amount, then currency, then counterparty, then threshold", () => {
    const offList = fixtures.globex.did
    // invalid amount beats currency and counterparty
    expect(evaluateSpend(request({ counterparty: offList, amount: { amount: 0, decimals: 2, currency: "EUR" } }), config)).toEqual(
      deny("invalid_amount"),
    )
    // currency beats counterparty
    expect(evaluateSpend(request({ counterparty: offList, amount: { amount: 500, decimals: 2, currency: "EUR" } }), config)).toEqual(
      deny("currency_not_supported"),
    )
    // currency beats the threshold
    expect(evaluateSpend(request({ amount: { amount: 9000, decimals: 2, currency: "EUR" } }), config)).toEqual(
      deny("currency_not_supported"),
    )
    // counterparty beats the threshold
    expect(evaluateSpend(request({ counterparty: offList, amount: usd(9000) }), config)).toEqual(deny("counterparty_not_allowed"))
  })

  it("POL-6: the same input gives a deep-equal decision across repeated calls", () => {
    const inputs = [request(), request({ amount: usd(5001) }), request({ counterparty: fixtures.globex.did })]
    for (const input of inputs) {
      const first = evaluateSpend(input, config)
      for (let i = 0; i < 20; i += 1) expect(evaluateSpend(structuredClone(input), config)).toEqual(first)
    }
  })

  it("POL-6: the decision does not change with the system clock", () => {
    const inputs = [request(), request({ amount: usd(5001) }), request({ counterparty: fixtures.globex.did })]
    vi.useFakeTimers({ toFake: ["Date"] })
    const decisions = ["2026-01-01T00:00:00Z", "2030-06-15T12:00:00Z", "1999-12-31T23:59:59Z"].map((at) => {
      vi.setSystemTime(new Date(at))
      return inputs.map((input) => evaluateSpend(input, config))
    })
    expect(decisions[1]).toEqual(decisions[0])
    expect(decisions[2]).toEqual(decisions[0])
    expect(decisions[0]).toEqual([allow, needsApproval, deny("counterparty_not_allowed")])
  })

  it("POL-6: DID comparison is exact and case-sensitive", () => {
    const did = fixtures.acme.did
    const variants = [did.toUpperCase(), did.toLowerCase(), `${did} `, ` ${did}`, `${did}#key-1`, did.replace("did:key:", "did:KEY:")]
    for (const counterparty of variants) {
      if (counterparty === did) continue
      expect(evaluateSpend(request({ counterparty: counterparty as DidUri }), config)).toEqual(deny("counterparty_not_allowed"))
    }
  })

  it("POL-6: malformed requests and configurations get a decision instead of an exception", () => {
    const broken: unknown[] = [
      { ...request(), amount: undefined },
      { ...request(), amount: null },
      { ...request(), counterparty: undefined },
      { ...request(), counterparty: 42 },
      {},
      null,
      undefined,
    ]
    for (const input of broken) {
      let decision: unknown
      expect(() => {
        decision = evaluateSpend(input as SpendRequest, config)
      }).not.toThrow()
      expect(decision).toMatchObject({ outcome: "deny" })
    }
    const brokenConfigs: unknown[] = [{ allowedCounterparties: undefined, approvalThreshold: threshold }, { allowedCounterparties: [fixtures.acme.did] }, null]
    for (const bad of brokenConfigs) {
      let decision: unknown
      expect(() => {
        decision = evaluateSpend(request(), bad as SpendPolicyConfig)
      }).not.toThrow()
      expect(decision).toMatchObject({ outcome: "deny" })
    }
  })

  it("POL-6: the policy does not modify its inputs", () => {
    const input = request({ amount: usd(5001) })
    const snapshot = structuredClone(input)
    const configSnapshot = structuredClone(config)
    evaluateSpend(input, config)
    expect(input).toEqual(snapshot)
    expect(config).toEqual(configSnapshot)
  })
})
