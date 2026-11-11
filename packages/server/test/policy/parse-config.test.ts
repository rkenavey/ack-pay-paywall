import { describe, expect, it } from "vitest"
import { fixtures } from "@paywall/testkit"
import { DEFAULT_APPROVAL_THRESHOLD, parseSpendPolicyConfig } from "../../src/policy/index.ts"

describe("parseSpendPolicyConfig", () => {
  it("POL-7: applies the default threshold of $50.00 when none is set", () => {
    const config = parseSpendPolicyConfig({ POLICY_ALLOWED_COUNTERPARTIES: fixtures.acme.did })
    expect(config).toEqual({
      allowedCounterparties: [fixtures.acme.did],
      approvalThreshold: { amount: 5000, decimals: 2, currency: "USD" },
    })
    expect(DEFAULT_APPROVAL_THRESHOLD).toEqual({ amount: 5000, decimals: 2, currency: "USD" })
  })

  it("POL-7: reads a comma-separated allowlist and a threshold in minor units", () => {
    const config = parseSpendPolicyConfig({
      POLICY_ALLOWED_COUNTERPARTIES: `${fixtures.acme.did},${fixtures.globex.did}`,
      POLICY_APPROVAL_THRESHOLD_MINOR: "12500",
    })
    expect(config.allowedCounterparties).toEqual([fixtures.acme.did, fixtures.globex.did])
    expect(config.approvalThreshold).toEqual({ amount: 12500, decimals: 2, currency: "USD" })
  })

  it("POL-7: an empty allowlist variable is valid and means an empty list", () => {
    expect(parseSpendPolicyConfig({ POLICY_ALLOWED_COUNTERPARTIES: "" }).allowedCounterparties).toEqual([])
  })

  it("POL-7: throws, naming the variable, when the allowlist variable is missing", () => {
    expect(() => parseSpendPolicyConfig({})).toThrow(/POLICY_ALLOWED_COUNTERPARTIES/)
    expect(() => parseSpendPolicyConfig({ POLICY_APPROVAL_THRESHOLD_MINOR: "5000" })).toThrow(/POLICY_ALLOWED_COUNTERPARTIES/)
  })

  it("POL-7: throws, naming the variable, on a malformed DID", () => {
    for (const bad of ["acme", "did:key", "did::z6Mk", "https://acme.example", `${fixtures.acme.did},not-a-did`]) {
      expect(() => parseSpendPolicyConfig({ POLICY_ALLOWED_COUNTERPARTIES: bad })).toThrow(/POLICY_ALLOWED_COUNTERPARTIES/)
    }
  })

  it("POL-7: throws, naming the variable, on a negative, fractional, unsafe or non-numeric threshold", () => {
    for (const bad of ["-1", "-5000", "50.5", "fifty", "9007199254740993", " "]) {
      expect(() =>
        parseSpendPolicyConfig({ POLICY_ALLOWED_COUNTERPARTIES: fixtures.acme.did, POLICY_APPROVAL_THRESHOLD_MINOR: bad }),
      ).toThrow(/POLICY_APPROVAL_THRESHOLD_MINOR/)
    }
  })
})
