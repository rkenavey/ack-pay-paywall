import { getDidResolver, verifyJwt, verifyPaymentReceipt, type PaymentRequest } from "agentcommercekit"
import { afterEach, describe, expect, it, vi } from "vitest"
import { RECEIPT_HEADER } from "@paywall/protocol"
import { BASE_URL, buildPaymentRequest, fixtures, PAYMENT_SERVICE_URL } from "@paywall/testkit"
import { FAKE_RESOURCES, resourceUrl } from "../support/fake-paywall.ts"
import { setupClient } from "../support/client.ts"

afterEach(() => {
  vi.useRealTimers()
})

const URL_BRIEF = resourceUrl("market-brief")

describe("client agent flow", () => {
  it("CL-1: a 200 on the first request returns the resource and contacts no payment service", async () => {
    const { client, paywall } = setupClient()
    paywall.free = true
    const state = await client.fetchPaid(URL_BRIEF)
    expect(state.status).toBe("delivered")
    expect(state.resource).toEqual({ id: "market-brief", title: "Market brief", content: FAKE_RESOURCES[0]?.content })
    expect(state.receipt).toBeUndefined()
    expect(paywall.paymentServiceCalls()).toHaveLength(0)
    expect(paywall.resourceCalls()).toHaveLength(1)
  })

  it("CL-2: on a 402 the client verifies the token and keeps the verified request and its issuer", async () => {
    const { client, paywall } = setupClient()
    const state = await client.fetchPaid(URL_BRIEF)
    expect(state.status).toBe("delivered")
    expect(state.payee).toBe(fixtures.acme.did)
    expect(state.paymentRequired?.paymentRequest).toEqual(paywall.issued[0]?.paymentRequest)
    expect(state.paymentRequired?.paymentRequestToken).toBe(paywall.issued[0]?.paymentRequestToken)
  })

  it("CL-2: a body whose unsigned request differs from the token fails payment_request_mismatch and pays nothing", async () => {
    type Alter = (request: PaymentRequest) => PaymentRequest
    const alterations: Alter[] = [
      (r) => ({ ...r, paymentOptions: r.paymentOptions.map((o) => ({ ...o, amount: 1 })) as PaymentRequest["paymentOptions"] }),
      (r) => ({
        ...r,
        paymentOptions: r.paymentOptions.map((o) => ({ ...o, paymentService: "http://evil.example/payment-service" })) as PaymentRequest["paymentOptions"],
      }),
      (r) => ({ ...r, description: "Something else" }),
    ]
    for (const alter of alterations) {
      vi.useRealTimers()
      const { client, paywall } = setupClient()
      paywall.alterUnsignedRequest = alter
      const state = await client.fetchPaid(URL_BRIEF)
      expect(state.status).toBe("failed")
      expect(state.failure?.code).toBe("payment_request_mismatch")
      expect(paywall.paymentServiceCalls()).toHaveLength(0)
    }
  })

  it("CL-3: a token with a bad signature fails payment_request_invalid and pays nothing", async () => {
    const { client, paywall } = setupClient()
    paywall.forgeTokenWith = fixtures.untrusted
    const state = await client.fetchPaid(URL_BRIEF)
    expect(state.status).toBe("failed")
    expect(state.failure?.code).toBe("payment_request_invalid")
    expect(paywall.paymentServiceCalls()).toHaveLength(0)
  })

  it("CL-3: a 402 body that is not a payment-required body fails payment_request_invalid", async () => {
    const { client, paywall } = setupClient()
    // spec-fix(T4): the FakePaywall's /api/resources/:id route shadowed this stub (FetchStub is first-match), so the client saw a 404, not the malformed 402 this test is about
    const brokenUrl = `${BASE_URL}/broken/resources/broken`
    paywall.stub.on("GET", brokenUrl, () => Response.json({ paymentRequest: { id: "x" }, paymentRequestToken: "nope" }, { status: 402 }))
    const state = await client.fetchPaid(brokenUrl)
    expect(state.status).toBe("failed")
    expect(state.failure?.code).toBe("payment_request_invalid")
    expect(paywall.paymentServiceCalls()).toHaveLength(0)
  })

  it("CL-4: an expired request fails payment_request_expired and pays nothing", async () => {
    const { client, paywall } = setupClient()
    paywall.expiresInMs = -1000
    const state = await client.fetchPaid(URL_BRIEF)
    expect(state.status).toBe("failed")
    expect(state.failure?.code).toBe("payment_request_expired")
    expect(paywall.paymentServiceCalls()).toHaveLength(0)
  })

  it("CL-6: the initiation is a JWT signed by the client with the option's paymentService as audience, at most 300 s to expiry", async () => {
    const { client, paywall } = setupClient()
    await client.fetchPaid(URL_BRIEF)
    expect(paywall.initiations).toHaveLength(1)
    const verified = await verifyJwt(paywall.initiations[0] as string, { resolver: getDidResolver(), audience: PAYMENT_SERVICE_URL })
    expect(verified.issuer).toBe(fixtures.client.did)
    const payload = verified.payload as Record<string, unknown> & { iat: number; exp: number }
    expect(payload.aud).toBe(PAYMENT_SERVICE_URL)
    expect(payload.paymentRequestToken).toBe(paywall.issued[0]?.paymentRequestToken)
    expect(payload.paymentOptionId).toBe("sandbox-usd")
    expect(payload.exp - payload.iat).toBeGreaterThan(0)
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(300)
    // The initiation went to the option's payment service, in the documented body.
    const post = paywall.stub.calls("POST", "/payment-service/payments")
    expect(post).toHaveLength(1)
    expect(JSON.parse(post[0]?.body ?? "{}")).toEqual({ initiation: paywall.initiations[0] })
  })

  it("CL-7: the sandbox happy path ends delivered with the resource and the receipt, retrying exactly once with the header", async () => {
    const { client, paywall } = setupClient()
    const state = await client.fetchPaid(URL_BRIEF)
    expect(state.status).toBe("delivered")
    expect(state.resource?.content).toBe(FAKE_RESOURCES[0]?.content)
    expect(state.selectedOption?.id).toBe("sandbox-usd")
    expect(state.payment?.paymentId).toBe("pay_0001")
    expect(state.receipt).toBe(paywall.receipts[0])

    const gets = paywall.resourceCalls()
    expect(gets).toHaveLength(2)
    expect(gets[0]?.headers.get(RECEIPT_HEADER)).toBeNull()
    expect(gets[1]?.headers.get(RECEIPT_HEADER)).toBe(paywall.receipts[0])
    expect(paywall.stub.calls("POST", "/payment-service/payments/pay_0001/sandbox/settle")).toHaveLength(1)
    expect(paywall.stub.calls("POST", "/payment-service/payments/pay_0001/receipt")).toHaveLength(1)

    const verified = await verifyPaymentReceipt(state.receipt as string, {
      resolver: getDidResolver(),
      trustedReceiptIssuers: [fixtures.paymentService.did],
    })
    expect(verified.receipt.credentialSubject.id).toBe(fixtures.client.did)
  })

  it("CL-8: a receipt from another issuer fails receipt_invalid and is not presented", async () => {
    const { client, paywall } = setupClient()
    paywall.receiptIssuer = fixtures.untrusted
    const state = await client.fetchPaid(URL_BRIEF)
    expect(state.status).toBe("failed")
    expect(state.failure?.code).toBe("receipt_invalid")
    expect(paywall.resourceCalls()).toHaveLength(1)
  })

  it("CL-8: a receipt for another payment request token fails receipt_invalid and is not presented", async () => {
    const { client, paywall, clock } = setupClient()
    const other = await buildPaymentRequest({ now: clock.now(), id: "pr_other" })
    paywall.receiptToken = other.paymentRequestToken
    const state = await client.fetchPaid(URL_BRIEF)
    expect(state.status).toBe("failed")
    expect(state.failure?.code).toBe("receipt_invalid")
    expect(paywall.resourceCalls()).toHaveLength(1)
  })

  it("CL-8: a receipt issued to another subject fails receipt_invalid and is not presented", async () => {
    const { client, paywall } = setupClient()
    paywall.receiptSubject = fixtures.untrusted.did
    const state = await client.fetchPaid(URL_BRIEF)
    expect(state.status).toBe("failed")
    expect(state.failure?.code).toBe("receipt_invalid")
    expect(paywall.resourceCalls()).toHaveLength(1)
  })

  it("CL-10: a 403 policy_denied fails policy_denied with the rule in the details", async () => {
    const { client, paywall } = setupClient()
    paywall.mode = "deny"
    const state = await client.fetchPaid(URL_BRIEF)
    expect(state.status).toBe("failed")
    expect(state.failure?.code).toBe("policy_denied")
    expect(state.failure?.details).toMatchObject({ rule: "counterparty_not_allowed" })
    expect(paywall.stub.requests.filter((r) => r.path.includes("/settle") || r.path.includes("/receipt"))).toHaveLength(0)
  })

  it("CL-11: a 402 on the retry fails payment_not_accepted and never initiates a second payment", async () => {
    const { client, paywall } = setupClient()
    paywall.acceptReceipts = false
    const state = await client.fetchPaid(URL_BRIEF)
    expect(state.status).toBe("failed")
    expect(state.failure?.code).toBe("payment_not_accepted")
    expect(paywall.stub.calls("POST", "/payment-service/payments")).toHaveLength(1)
    expect(paywall.resourceCalls()).toHaveLength(2)
  })

  it("CL-11: a failed executor fails payment_failed and asks for no receipt", async () => {
    const { client, paywall } = setupClient({
      executors: () => [
        {
          network: "sandbox",
          execute: async () => {
            throw new Error("card declined")
          },
        },
      ],
    })
    const state = await client.fetchPaid(URL_BRIEF)
    expect(state.status).toBe("failed")
    expect(state.failure?.code).toBe("payment_failed")
    expect(paywall.stub.requests.filter((r) => r.path.endsWith("/receipt"))).toHaveLength(0)
  })

  it("CL-11: an unexpected HTTP error resolves failed http_error instead of rejecting", async () => {
    const { client, paywall } = setupClient()
    paywall.receiptStatus = 500
    const state = await client.fetchPaid(URL_BRIEF)
    expect(state.status).toBe("failed")
    expect(state.failure?.code).toBe("http_error")
  })

  it("CL-12: the happy path emits the client events in order and subscribe observes each status in order", async () => {
    const { client, log, statuses } = setupClient()
    await client.fetchPaid(URL_BRIEF)
    expect(log.names()).toEqual([
      "client.request.sent",
      "client.payment_required.received",
      "client.payment_request.verified",
      "client.option.selected",
      "client.payment.initiated",
      "client.payment.executing",
      "client.receipt.received",
      "client.receipt.verified",
      "client.request.retried",
      "client.resource.received",
    ])
    for (const event of log.events) expect(event.actor).toBe("client-agent")
    expect(statuses().filter((s) => s !== "idle")).toEqual([
      "requesting",
      "verifying_request",
      "selecting_option",
      "initiating",
      "paying",
      "fetching_receipt",
      "retrying",
      "delivered",
    ])
  })

  it("CL-12: a failed run emits client.flow.failed with the failure code", async () => {
    const { client, paywall, log } = setupClient()
    paywall.mode = "deny"
    await client.fetchPaid(URL_BRIEF)
    expect(log.names().at(-1)).toBe("client.flow.failed")
    expect(log.one("client.flow.failed").data).toMatchObject({ code: "policy_denied" })
  })

  it("CL-12: no client event contains a complete JWT", async () => {
    const { client, log, paywall } = setupClient()
    await client.fetchPaid(URL_BRIEF)
    const serialized = JSON.stringify(log.events)
    expect(serialized).not.toContain(paywall.receipts[0])
    expect(serialized).not.toContain(paywall.issued[0]?.paymentRequestToken)
    expect(serialized).not.toContain(paywall.initiations[0])
  })
})
