import { getDidResolver, verifyPaymentRequestToken } from "agentcommercekit"
import * as v from "valibot"
import { afterEach, describe, expect, it, vi } from "vitest"
import { paymentRequiredBodySchema, resourceBodySchema, resourceListBodySchema } from "@paywall/protocol"
import {
  buildOtherCredential,
  buildPaymentRequest,
  buildReceipt,
  fixtures,
  paymentOption,
  PAYMENT_SERVICE_URL,
  tamperSignature,
} from "@paywall/testkit"
import { catalog, expectError, expectRejected, setupServerAgent, TTL_SECONDS } from "./harness.ts"

afterEach(() => {
  vi.useRealTimers()
})

describe("issuing the 402", () => {
  it("SA-1: a paywalled route without a receipt answers 402 with a PaymentRequiredBody and Cache-Control: no-store", async () => {
    const { get } = setupServerAgent()
    const response = await get("market-brief")
    expect(response.status).toBe(402)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("content-type")).toMatch(/application\/json/)
    const raw = await response.json()
    const parsed = v.safeParse(paymentRequiredBodySchema, raw)
    expect(parsed.issues).toBeUndefined()
    expect(raw).not.toHaveProperty("error")
  })

  it("SA-2: the token verifies, is issued by the server agent and its payload equals the body's paymentRequest", async () => {
    const { paymentRequired, identity } = setupServerAgent()
    const body = await paymentRequired()
    const verified = await verifyPaymentRequestToken(body.paymentRequestToken, { resolver: getDidResolver() })
    expect(verified.parsed.issuer).toBe(identity.did)
    expect(verified.paymentRequest).toEqual(body.paymentRequest)
  })

  it("SA-3: each 402 has a new id, expiresAt of now plus the TTL, the title as description and one option per network", async () => {
    const { paymentRequired, clock, store, identity } = setupServerAgent({ networks: ["stripe", "sandbox"] })
    const first = await paymentRequired("market-brief")
    const second = await paymentRequired("market-brief")
    expect(second.paymentRequest.id).not.toBe(first.paymentRequest.id)

    const { paymentRequest } = first
    expect(paymentRequest.expiresAt).toBe(new Date(clock.now().getTime() + TTL_SECONDS * 1000).toISOString())
    expect(paymentRequest.description).toBe("Market brief")
    expect(paymentRequest.paymentOptions).toEqual([
      {
        id: "stripe-usd",
        amount: 500,
        decimals: 2,
        currency: "USD",
        recipient: identity.did,
        network: "stripe",
        paymentService: PAYMENT_SERVICE_URL,
        receiptService: fixtures.paymentService.did,
      },
      {
        id: "sandbox-usd",
        amount: 500,
        decimals: 2,
        currency: "USD",
        recipient: identity.did,
        network: "sandbox",
        paymentService: PAYMENT_SERVICE_URL,
        receiptService: fixtures.paymentService.did,
      },
    ])

    // The resource binding is saved before the response.
    await expect(store.get(paymentRequest.id)).resolves.toMatchObject({
      id: paymentRequest.id,
      resourceId: "market-brief",
      expiresAt: new Date(clock.now().getTime() + TTL_SECONDS * 1000),
    })
  })

  it("SA-3: the options follow the configured networks and the catalog price", async () => {
    const { paymentRequired } = setupServerAgent({ networks: ["sandbox"] })
    const body = await paymentRequired("annual-report")
    expect(body.paymentRequest.description).toBe("Annual report")
    expect(body.paymentRequest.paymentOptions.map((o) => [o.id, o.network, o.amount, o.decimals, o.currency])).toEqual([
      ["sandbox-usd", "sandbox", 7500, 2, "USD"],
    ])
  })
})

describe("verifying a receipt", () => {
  it("SA-4: a valid receipt in Payment-Receipt answers 200 with the resource", async () => {
    const { get, paymentRequired, receiptFor } = setupServerAgent()
    const body = await paymentRequired("market-brief")
    const response = await get("market-brief", await receiptFor(body))
    expect(response.status).toBe(200)
    const resource = v.parse(resourceBodySchema, await response.json())
    expect(resource).toEqual({ id: "market-brief", title: "Market brief", content: catalog[0]?.content })
  })

  it("SA-4: a receipt for the stripe option is accepted too", async () => {
    const { get, paymentRequired, receiptFor } = setupServerAgent()
    const body = await paymentRequired("market-brief")
    const response = await get("market-brief", await receiptFor(body, { optionId: "stripe-usd" }))
    expect(response.status).toBe(200)
  })

  it("SA-5: a receipt signed by an untrusted issuer answers 402 receipt_untrusted_issuer with a fresh request", async () => {
    const { get, paymentRequired, receiptFor } = setupServerAgent()
    const body = await paymentRequired()
    const receipt = await receiptFor(body, { issuer: fixtures.untrusted })
    await expectRejected(await get("market-brief", receipt), "receipt_untrusted_issuer", body)
  })

  it("SA-6: a tampered receipt answers 402 receipt_invalid", async () => {
    const { get, paymentRequired, receiptFor } = setupServerAgent()
    const body = await paymentRequired()
    const receipt = tamperSignature(await receiptFor(body))
    await expectRejected(await get("market-brief", receipt), "receipt_invalid", body)
  })

  it("SA-6: a value that is not a JWT answers 402 receipt_invalid", async () => {
    const { get, paymentRequired } = setupServerAgent()
    const body = await paymentRequired()
    for (const value of ["not-a-jwt", "a.b", "Bearer x.y.z"]) {
      await expectRejected(await get("market-brief", value), "receipt_invalid", body)
    }
  })

  it("SA-6: a credential of another type answers 402 receipt_invalid", async () => {
    const { get, paymentRequired, clock } = setupServerAgent()
    const body = await paymentRequired()
    const credential = await buildOtherCredential({
      paymentRequestToken: body.paymentRequestToken,
      paymentOptionId: "sandbox-usd",
      expirationDate: new Date(clock.now().getTime() + 600_000),
    })
    await expectRejected(await get("market-brief", credential), "receipt_invalid", body)
  })

  it("SA-6: a bare payment request token presented as a receipt answers 402 receipt_invalid", async () => {
    const { get, paymentRequired } = setupServerAgent()
    const body = await paymentRequired()
    await expectRejected(await get("market-brief", body.paymentRequestToken), "receipt_invalid", body)
  })

  it("SA-7: an expired receipt answers 402 receipt_expired", async () => {
    const { get, paymentRequired, receiptFor, clock } = setupServerAgent()
    const body = await paymentRequired()
    const receipt = await receiptFor(body, { expirationDate: new Date(clock.now().getTime() + 60_000) })
    clock.advanceSeconds(61)
    await expectRejected(await get("market-brief", receipt), "receipt_expired", body)
  })

  it("SA-8: a valid receipt for another resource answers 402 receipt_wrong_resource", async () => {
    const { get, paymentRequired, receiptFor } = setupServerAgent()
    const forBrief = await paymentRequired("market-brief")
    const receipt = await receiptFor(forBrief)
    await expectRejected(await get("annual-report", receipt), "receipt_wrong_resource")
    // The rejection did not redeem it: it still buys the resource it was issued for.
    expect((await get("market-brief", receipt)).status).toBe(200)
  })

  it("SA-9: a receipt whose payment request token was signed by another server agent answers 402 receipt_invalid", async () => {
    const { get, paymentRequired, clock } = setupServerAgent()
    const body = await paymentRequired()
    // Globex signs a request reusing Acme's request id; the payment service issues a valid receipt for it.
    const foreign = await buildPaymentRequest({
      now: clock.now(),
      issuer: fixtures.globex,
      id: body.paymentRequest.id,
      paymentOptions: [paymentOption({ network: "sandbox", recipient: fixtures.globex.did })],
    })
    const receipt = await buildReceipt({
      paymentRequestToken: foreign.paymentRequestToken,
      paymentOptionId: "sandbox-usd",
      expirationDate: new Date(clock.now().getTime() + 600_000),
    })
    await expectRejected(await get("market-brief", receipt), "receipt_invalid", body)
  })

  it("SA-9: a receipt for a request id never issued here answers 402 receipt_invalid", async () => {
    const { get, clock, identity } = setupServerAgent()
    const neverIssued = await buildPaymentRequest({
      now: clock.now(),
      issuer: identity,
      id: "pr_never_issued",
      paymentOptions: [paymentOption({ network: "sandbox", recipient: identity.did })],
    })
    const receipt = await buildReceipt({
      paymentRequestToken: neverIssued.paymentRequestToken,
      paymentOptionId: "sandbox-usd",
      expirationDate: new Date(clock.now().getTime() + 600_000),
    })
    await expectRejected(await get("market-brief", receipt), "receipt_invalid")
  })

  it("SA-10: a receipt is delivered once; the second presentation answers 402 receipt_already_redeemed", async () => {
    const { get, paymentRequired, receiptFor } = setupServerAgent()
    const body = await paymentRequired()
    const receipt = await receiptFor(body)
    expect((await get("market-brief", receipt)).status).toBe(200)
    await expectRejected(await get("market-brief", receipt), "receipt_already_redeemed", body)
    await expectRejected(await get("market-brief", receipt), "receipt_already_redeemed", body)
  })

  it("SA-10: two concurrent presentations of one receipt deliver exactly once", async () => {
    const { get, paymentRequired, receiptFor } = setupServerAgent()
    const body = await paymentRequired()
    const receipt = await receiptFor(body)
    const responses = await Promise.all([get("market-brief", receipt), get("market-brief", receipt), get("market-brief", receipt)])
    const statuses = responses.map((r) => r.status).sort()
    expect(statuses).toEqual([200, 402, 402])
    for (const response of responses.filter((r) => r.status === 402)) {
      await expectRejected(response, "receipt_already_redeemed")
    }
  })

  it("SA-11: a receipt naming an option id that is not in its payment request answers 402 receipt_invalid", async () => {
    const { get, paymentRequired, receiptFor } = setupServerAgent({ networks: ["sandbox"] })
    const body = await paymentRequired()
    for (const optionId of ["stripe-usd", "lightning-usd", ""]) {
      await expectRejected(await get("market-brief", await receiptFor(body, { optionId })), "receipt_invalid", body)
    }
    // None of those redeemed the request.
    expect((await get("market-brief", await receiptFor(body))).status).toBe(200)
  })
})

describe("free routes", () => {
  it("SA-12: an unknown resource answers 404 resource_not_found", async () => {
    const { get } = setupServerAgent()
    await expectError(await get("no-such-thing"), 404, "resource_not_found")
  })

  it("SA-12: the catalog route answers 200 without payment and never includes the content", async () => {
    const { app } = setupServerAgent()
    const response = await app.request("/resources")
    expect(response.status).toBe(200)
    const raw = (await response.json()) as { resources: unknown[] }
    const body = v.parse(resourceListBodySchema, raw)
    expect(body.resources).toEqual([
      { id: "market-brief", title: "Market brief", price: { amount: 500, decimals: 2, currency: "USD" } },
      { id: "annual-report", title: "Annual report", price: { amount: 7500, decimals: 2, currency: "USD" } },
    ])
    for (const resource of raw.resources) expect(resource).not.toHaveProperty("content")
  })
})
