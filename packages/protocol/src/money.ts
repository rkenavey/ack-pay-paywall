import type { PaymentOption } from "agentcommercekit"

/**
 * An amount of money in minor units, the way payment options carry it.
 *
 * `amount` is a positive safe integer count of minor units (cents for USD) and
 * `decimals` says how many of its digits are after the decimal point, so
 * `{ amount: 5000, decimals: 2, currency: "USD" }` is fifty dollars.
 */
export interface Money {
  amount: number
  decimals: number
  currency: string
}

/**
 * Tells whether a value is a positive safe integer of type number.
 *
 * This is the only shape of `Money.amount` the paywall accepts: it rules out
 * strings, zero, negatives, fractions, `NaN`, infinities and integers too
 * large to represent exactly.
 */
export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

/**
 * Tells whether two amounts share a currency and a number of decimals, which
 * is what makes them comparable.
 */
export function sameDenomination(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.decimals === b.decimals
}

/**
 * Compares two amounts of the same denomination: negative when `a` is
 * smaller, zero when equal, positive when `a` is larger.
 *
 * Throws a `TypeError` when the currencies or decimals differ, because such
 * amounts have no meaningful order.
 */
export function compareMoney(a: Money, b: Money): number {
  if (!sameDenomination(a, b)) {
    throw new TypeError(`cannot compare ${a.currency}/${a.decimals} with ${b.currency}/${b.decimals}`)
  }
  return a.amount === b.amount ? 0 : a.amount < b.amount ? -1 : 1
}

/** Tells whether two amounts are the same amount of the same denomination. */
export function moneyEquals(a: Money, b: Money): boolean {
  return sameDenomination(a, b) && a.amount === b.amount
}

/**
 * Formats the amount as a decimal string without a currency, such as `"50.00"`.
 *
 * Works on the decimal digits of the integer, never on a floating-point
 * quotient, so every safe integer formats exactly.
 */
export function formatAmount(money: Money): string {
  const { amount, decimals } = money
  if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(decimals) || decimals < 0) {
    throw new TypeError("amount and decimals must be safe integers, decimals at least 0")
  }
  const negative = amount < 0
  const digits = String(Math.abs(amount)).padStart(decimals + 1, "0")
  const whole = digits.slice(0, digits.length - decimals)
  const fraction = digits.slice(digits.length - decimals)
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  return `${negative ? "-" : ""}${grouped}${decimals > 0 ? `.${fraction}` : ""}`
}

/**
 * Formats an amount for people: `"$50.00"` for US dollars and
 * `"50.00 EUR"` for any other currency code.
 */
export function formatMoney(money: Money): string {
  const text = formatAmount(money)
  if (money.currency === "USD") {
    return text.startsWith("-") ? `-$${text.slice(1)}` : `$${text}`
  }
  return `${text} ${money.currency}`
}

/**
 * Reads the amount of an ACK payment option as `Money`.
 *
 * Returns `undefined` when the option's amount is not a positive safe integer
 * of type number (ACK also allows strings), so callers can fail closed.
 */
export function moneyFromOption(option: Pick<PaymentOption, "amount" | "decimals" | "currency">): Money | undefined {
  if (!isPositiveSafeInteger(option.amount)) return undefined
  return { amount: option.amount, decimals: option.decimals, currency: option.currency }
}
