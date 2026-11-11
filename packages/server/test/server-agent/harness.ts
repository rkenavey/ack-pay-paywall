import * as v from "valibot"
import { expect } from "vitest"
import {
  errorBodySchema,
  paymentRequiredBodySchema,
  RECEIPT_HEADER,
  type Network,
  type PaymentRequiredBody,
  type ReceiptErrorCode,
} from "@paywall/protocol"
import {
  buildReceipt,
  fixtureResolver,
  fixtures,
  MemoryEventLog,
  PAYMENT_SERVICE_URL,
  SequenceIds,
  useFixedTime,
  type FixtureIdentity,
} from "@paywall/testkit"
import { createMemoryPaymentRequestStore, createServerAgent, type CatalogEntry } from "../../src/index.ts"

/** The catalog the server agent tests sell. */
export const catalog: readonly CatalogEntry[] = [
  { id: "market-brief", title: "Market brief", price: { amount: 500, decimals: 2, currency: "USD" }, content: "brief content" },
  { id: "annual-report", title: "Annual report", price: { amount: 7500, decimals: 2, currency: "USD" }, content: "report content" },
]

/** The payment request lifetime the server agent tests configure, in seconds. */
export const TTL_SECONDS = 900
/** How long the test receipts live, in milliseconds. */
export const RECEIPT_TTL_MS = 600_000

/** A server agent for Acme on a fixed clock, with the stores and log it was given. */
export function setupServerAgent(options: { networks?: readonly Network[]; identity?: FixtureIdentity } = {}) {
  const clock = useFixedTime()
  const ids = new SequenceIds()
  const log = new MemoryEventLog(clock)
  const store = createMemoryPaymentRequestStore()
  const identity = options.identity ?? fixtures.acme
  const app = createServerAgent({
    identity,
    catalog,
    store,
    paymentService: { url: PAYMENT_SERVICE_URL, did: fixtures.paymentService.did, networks: options.networks ?? ["stripe", "sandbox"] },
    paymentRequestTtlSeconds: TTL_SECONDS,
    resolver: fixtureResolver(),
    clock,
    ids,
    log,
  })

  async function get(resourceId: string, receipt?: string): Promise<Response> {
    return app.request(`/resources/${resourceId}`, { headers: receipt === undefined ? {} : { [RECEIPT_HEADER]: receipt } })
  }

  /** Requests a resource without a receipt and returns the validated 402 body. */
  async function paymentRequired(resourceId = "market-brief"): Promise<PaymentRequiredBody> {
    const response = await get(resourceId)
    expect(response.status).toBe(402)
    return v.parse(paymentRequiredBodySchema, await response.json())
  }

  /** A receipt for a 402 body, signed by the payment service unless another issuer is given. */
  async function receiptFor(
    body: PaymentRequiredBody,
    overrides: { optionId?: string; issuer?: FixtureIdentity; expirationDate?: Date } = {},
  ): Promise<string> {
    return buildReceipt({
      paymentRequestToken: body.paymentRequestToken,
      paymentOptionId: overrides.optionId ?? "sandbox-usd",
      issuer: overrides.issuer ?? fixtures.paymentService,
      payer: fixtures.client.did,
      expirationDate: overrides.expirationDate ?? new Date(clock.now().getTime() + RECEIPT_TTL_MS),
      metadata: { paymentId: "pay_test" },
    })
  }

  return { app, clock, ids, log, store, identity, get, paymentRequired, receiptFor }
}

/**
 * Asserts a rejected receipt: 402, the given code, no-store, and a fresh
 * payment request that differs from `previous`.
 */
export async function expectRejected(response: Response, code: ReceiptErrorCode, previous?: PaymentRequiredBody): Promise<PaymentRequiredBody> {
  expect(response.status).toBe(402)
  expect(response.headers.get("cache-control")).toBe("no-store")
  const raw = await response.json()
  const body = v.parse(paymentRequiredBodySchema, raw)
  expect(body.error?.code).toBe(code)
  expect(typeof body.error?.message).toBe("string")
  if (previous) {
    expect(body.paymentRequest.id).not.toBe(previous.paymentRequest.id)
    expect(body.paymentRequestToken).not.toBe(previous.paymentRequestToken)
  }
  return body
}

/** Asserts an error body with the given status and code. */
export async function expectError(response: Response, status: number, code: string): Promise<Record<string, unknown> | undefined> {
  expect(response.status).toBe(status)
  const body = v.parse(errorBodySchema, await response.json())
  expect(body.error.code).toBe(code)
  return body.error.details
}
