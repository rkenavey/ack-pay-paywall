import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  compareMoney,
  formatAmount,
  formatMoney,
  isPositiveSafeInteger,
  moneyEquals,
  moneyFromOption,
  sameDenomination,
  type Money,
} from "../src/index.ts"

const usd = (amount: number): Money => ({ amount, decimals: 2, currency: "USD" })

describe("money helpers", () => {
  it('PRO-4: 5000 minor units formats as "$50.00"', () => {
    expect(formatMoney(usd(5000))).toBe("$50.00")
    expect(formatAmount(usd(5000))).toBe("50.00")
  })

  it("PRO-4: formatting handles small, large and non-USD amounts exactly", () => {
    expect(formatMoney(usd(1))).toBe("$0.01")
    expect(formatMoney(usd(10))).toBe("$0.10")
    expect(formatMoney(usd(500))).toBe("$5.00")
    expect(formatMoney(usd(5001))).toBe("$50.01")
    expect(formatMoney(usd(123456789))).toBe("$1,234,567.89")
    // The largest safe integer: a float division would round the last digits.
    expect(formatMoney(usd(Number.MAX_SAFE_INTEGER))).toBe("$90,071,992,547,409.91")
    expect(formatMoney({ amount: 1234, decimals: 0, currency: "JPY" })).toBe("1,234 JPY")
    expect(formatMoney({ amount: 1, decimals: 3, currency: "KWD" })).toBe("0.001 KWD")
    expect(formatMoney({ amount: 7, decimals: 2, currency: "EUR" })).toBe("0.07 EUR")
  })

  it("PRO-4: comparison uses integer minor units and refuses mixed denominations", () => {
    expect(compareMoney(usd(5000), usd(5000))).toBe(0)
    expect(compareMoney(usd(5000), usd(5001))).toBeLessThan(0)
    expect(compareMoney(usd(5001), usd(5000))).toBeGreaterThan(0)
    expect(compareMoney(usd(Number.MAX_SAFE_INTEGER), usd(Number.MAX_SAFE_INTEGER - 1))).toBeGreaterThan(0)
    expect(moneyEquals(usd(5000), usd(5000))).toBe(true)
    expect(moneyEquals(usd(5000), { amount: 5000, decimals: 2, currency: "EUR" })).toBe(false)
    expect(sameDenomination(usd(1), { amount: 1, decimals: 3, currency: "USD" })).toBe(false)
    expect(() => compareMoney(usd(1), { amount: 1, decimals: 2, currency: "EUR" })).toThrow(TypeError)
    expect(() => compareMoney(usd(1), { amount: 1, decimals: 3, currency: "USD" })).toThrow(TypeError)
  })

  it("PRO-4: only positive safe integers of type number are amounts", () => {
    for (const ok of [1, 500, Number.MAX_SAFE_INTEGER]) expect(isPositiveSafeInteger(ok)).toBe(true)
    for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY, "500", null, undefined, 500n]) {
      expect(isPositiveSafeInteger(bad)).toBe(false)
    }
    expect(moneyFromOption({ amount: 500, decimals: 2, currency: "USD" })).toEqual(usd(500))
    expect(moneyFromOption({ amount: "500", decimals: 2, currency: "USD" })).toBeUndefined()
    expect(moneyFromOption({ amount: 5.5, decimals: 2, currency: "USD" })).toBeUndefined()
  })

  it("PRO-4: the money helpers contain no floating-point arithmetic", () => {
    const source = readFileSync(new URL("../src/money.ts", import.meta.url), "utf8")
    expect(source).not.toMatch(/parseFloat|toFixed|Math\.round|\/\s*10\s*\*\*|\*\s*0\.0?1\b|Intl\.NumberFormat/)
  })
})
