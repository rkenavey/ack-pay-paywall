// A scripted server agent and payment service for the client tests. It signs
// real ACK artifacts with the fixture identities, and each knob makes it
// misbehave in one way.
import { getDidResolver, verifyJwt, type PaymentRequest } from "agentcommercekit"
import {
  RECEIPT_HEADER,
  type DidUri,
  type Network,
  type PaymentView,
  type PolicyDecision,
  type ResourceSummary,
} from "@paywall/protocol"
import {
  BASE_URL,
  buildPaymentRequest,
  buildReceipt,
  FetchStub,
  fixtures,
  json,
  paymentOption,
  PAYMENT_SERVICE_URL,
  type FixedClock,
  type FixtureIdentity,
} from "@paywall/testkit"

/** The policy outcome the fake payment service answers with. */
export type FakeMode = "allow" | "approval" | "deny"

interface FakeResource extends ResourceSummary {
  agent: "api" | "partner"
  content: string
}

/** The resources the fake sells, mirroring the demo catalog. */
export const FAKE_RESOURCES: readonly FakeResource[] = [
  { agent: "api", id: "market-brief", title: "Market brief", price: { amount: 500, decimals: 2, currency: "USD" }, content: "The market brief content." },
  { agent: "api", id: "annual-report", title: "Annual report", price: { amount: 7500, decimals: 2, currency: "USD" }, content: "The annual report content." },
  { agent: "partner", id: "partner-feed", title: "Partner feed", price: { amount: 500, decimals: 2, currency: "USD" }, content: "The partner feed content." },
]

/** The URL of a resource on the fake server agent at `/api` or `/partner`. */
export const resourceUrl = (id: string, agent: "api" | "partner" = "api") => `${BASE_URL}/${agent}/resources/${id}`

/** A scripted server agent and payment service on a fixed clock; set its public fields to make it misbehave one way. */
export class FakePaywall {
  readonly stub = new FetchStub()
  readonly fetch = this.stub.fetch
  readonly clock: FixedClock

  /** Networks offered, in order. */
  networks: Network[] = ["stripe", "sandbox"]
  /** Policy outcome; by default annual-report needs approval, partner-feed is denied, the rest is allowed. */
  mode: FakeMode | undefined
  /** Answer 200 without asking for payment. */
  free = false
  /** Never accept a receipt. */
  acceptReceipts = true
  /** How long issued requests live. Negative issues an already-expired request. */
  expiresInMs = 900_000
  /** Sign payment request tokens with this key instead of the server agent's own. */
  forgeTokenWith: FixtureIdentity | undefined
  /** Change the unsigned copy of the request in the 402 body. */
  alterUnsignedRequest: ((request: PaymentRequest) => PaymentRequest) | undefined
  /** Who signs receipts. */
  receiptIssuer: FixtureIdentity = fixtures.paymentService
  /** Whom receipts are issued to; defaults to the payer of the initiation. */
  receiptSubject: DidUri | undefined
  /** Put this token in receipts instead of the one paid for. */
  receiptToken: string | undefined
  /** Answer the receipt route with this status instead. */
  receiptStatus: number | undefined

  readonly issued: Array<{ paymentRequest: PaymentRequest; paymentRequestToken: string; resourceId: string }> = []
  readonly initiations: string[] = []
  readonly payments = new Map<string, PaymentView>()
  readonly receipts: string[] = []
  #count = 0

  constructor(clock: FixedClock) {
    this.clock = clock
    for (const agent of ["api", "partner"] as const) {
      this.stub.on("GET", `${BASE_URL}/${agent}/resources`, () =>
        json({ resources: FAKE_RESOURCES.filter((r) => r.agent === agent).map(({ id, title, price }) => ({ id, title, price })) }),
      )
      this.stub.on("GET", `${BASE_URL}/${agent}/resources/:id`, (request, { id }) => this.#resource(agent, id ?? "", request.headers))
    }
    this.stub.on("POST", `${PAYMENT_SERVICE_URL}/payments`, (request) => this.#initiate(request.body))
    this.stub.on("GET", `${PAYMENT_SERVICE_URL}/payments/:id`, (_request, { id }) => this.#view(id ?? ""))
    this.stub.on("POST", `${PAYMENT_SERVICE_URL}/payments/:id/sandbox/settle`, (_request, { id }) => this.#settle(id ?? ""))
    this.stub.on("POST", `${PAYMENT_SERVICE_URL}/payments/:id/receipt`, (_request, { id }) => this.#receipt(id ?? ""))
  }

  /** The requests made to the payment service. */
  paymentServiceCalls() {
    return this.stub.requests.filter((r) => r.url.startsWith(PAYMENT_SERVICE_URL))
  }

  /** GETs of a resource URL, with or without a receipt. */
  resourceCalls(id = "market-brief", agent: "api" | "partner" = "api") {
    return this.stub.calls("GET", `/${agent}/resources/${id}`)
  }

  /** The only payment so far. */
  payment(): PaymentView {
    const [only] = [...this.payments.values()]
    if (!only || this.payments.size !== 1) throw new Error(`expected one payment, found ${this.payments.size}`)
    return only
  }

  /** Approves the waiting payment, as the human would. */
  approve(): void {
    const payment = this.payment()
    this.payments.set(payment.paymentId, { ...payment, status: "requires_payment", next: this.#next(payment.network) })
  }

  /** Rejects the waiting payment. */
  reject(): void {
    const payment = this.payment()
    this.payments.set(payment.paymentId, { ...payment, status: "rejected" })
  }

  #modeFor(resourceId: string): FakeMode {
    if (this.mode) return this.mode
    if (resourceId === "annual-report") return "approval"
    if (resourceId === "partner-feed") return "deny"
    return "allow"
  }

  #next(network: Network): PaymentView["next"] {
    return network === "stripe"
      ? { type: "stripe_payment_element", clientSecret: `pi_fake_${this.#count}_secret_x`, publishableKey: "pk_test_fake" }
      : { type: "sandbox_settle" }
  }

  async #resource(agent: "api" | "partner", id: string, headers: Headers): Promise<Response> {
    const resource = FAKE_RESOURCES.find((r) => r.id === id && r.agent === agent)
    if (!resource) return json({ error: { code: "resource_not_found", message: "no such resource" } }, 404)
    const presented = headers.get(RECEIPT_HEADER)
    if (this.free || (presented !== null && this.acceptReceipts && this.receipts.includes(presented))) {
      return json({ id: resource.id, title: resource.title, content: resource.content })
    }
    const issuer = agent === "api" ? fixtures.acme : fixtures.globex
    const signed = await buildPaymentRequest({
      now: this.clock.now(),
      issuer: this.forgeTokenWith ? { ...issuer, signer: this.forgeTokenWith.signer, alg: this.forgeTokenWith.alg } : issuer,
      id: `pr_${String(this.issued.length + 1).padStart(4, "0")}`,
      description: resource.title,
      expiresAt: new Date(this.clock.now().getTime() + this.expiresInMs),
      paymentOptions: this.networks.map((network) =>
        paymentOption({ network, amount: resource.price.amount, recipient: issuer.did }),
      ),
    })
    this.issued.push({ ...signed, resourceId: resource.id })
    const paymentRequest = this.alterUnsignedRequest ? this.alterUnsignedRequest(structuredClone(signed.paymentRequest)) : signed.paymentRequest
    const error = presented === null ? {} : { error: { code: "receipt_invalid", message: "receipt not accepted" } }
    return json({ paymentRequest, paymentRequestToken: signed.paymentRequestToken, ...error }, 402, { "Cache-Control": "no-store" })
  }

  async #initiate(body: string): Promise<Response> {
    const { initiation } = JSON.parse(body) as { initiation: string }
    this.initiations.push(initiation)
    const verified = await verifyJwt(initiation, { resolver: getDidResolver(), audience: PAYMENT_SERVICE_URL })
    const claims = verified.payload as { paymentRequestToken: string; paymentOptionId: string }
    const issued = this.issued.find((i) => i.paymentRequestToken === claims.paymentRequestToken)
    const option = issued?.paymentRequest.paymentOptions.find((o) => o.id === claims.paymentOptionId)
    if (!issued || !option) return json({ error: { code: "payment_option_unknown", message: "unknown option" } }, 400)
    const mode = this.#modeFor(issued.resourceId)
    if (mode === "deny") {
      return json({ error: { code: "policy_denied", message: "counterparty not allowed", details: { rule: "counterparty_not_allowed" } } }, 403)
    }
    this.#count += 1
    const policy: PolicyDecision =
      mode === "approval"
        ? { outcome: "needs_approval", rule: "amount_over_threshold", threshold: { amount: 5000, decimals: 2, currency: "USD" } }
        : { outcome: "allow", rule: "within_limits" }
    const network = option.network as Network
    const view: PaymentView = {
      paymentId: `pay_${String(this.#count).padStart(4, "0")}`,
      status: mode === "approval" ? "pending_approval" : "requires_payment",
      paymentRequestId: issued.paymentRequest.id,
      paymentOptionId: option.id,
      network,
      amount: { amount: option.amount as number, decimals: option.decimals, currency: option.currency },
      ...(issued.paymentRequest.description ? { description: issued.paymentRequest.description } : {}),
      payer: verified.issuer as DidUri,
      payee: (issued.resourceId === "partner-feed" ? fixtures.globex : fixtures.acme).did,
      policy,
      ...(mode === "approval" ? { approvalId: `apr_${String(this.#count).padStart(4, "0")}` } : { next: this.#next(network) }),
    }
    this.payments.set(view.paymentId, view)
    return json(view, mode === "approval" ? 202 : 201)
  }

  #view(id: string): Response {
    const view = this.payments.get(id)
    return view ? json(view) : json({ error: { code: "payment_not_found", message: "no such payment" } }, 404)
  }

  #settle(id: string): Response {
    const view = this.payments.get(id)
    if (!view) return json({ error: { code: "payment_not_found", message: "no such payment" } }, 404)
    if (view.status !== "requires_payment" || view.network !== "sandbox") {
      return json({ error: { code: "payment_not_payable", message: "not payable" } }, 409)
    }
    const { next: _next, ...rest } = view
    void _next
    const settled: PaymentView = { ...rest, status: "settled" }
    this.payments.set(id, settled)
    return json(settled)
  }

  /** Marks a Stripe payment settled, as if the PaymentIntent had succeeded. */
  settleStripe(id: string): void {
    const view = this.payments.get(id)
    if (!view) throw new Error("no such payment")
    const { next: _next, ...rest } = view
    void _next
    this.payments.set(id, { ...rest, status: "settled" })
  }

  async #receipt(id: string): Promise<Response> {
    if (this.receiptStatus) return json({ error: { code: "payment_not_settled", message: "scripted" } }, this.receiptStatus)
    const view = this.payments.get(id)
    if (!view) return json({ error: { code: "payment_not_found", message: "no such payment" } }, 404)
    if (view.status !== "settled") return json({ error: { code: "payment_not_settled", message: "not settled" } }, 409)
    const issued = this.issued.find((i) => i.paymentRequest.id === view.paymentRequestId)
    const receipt = await buildReceipt({
      paymentRequestToken: this.receiptToken ?? issued?.paymentRequestToken ?? "",
      paymentOptionId: view.paymentOptionId,
      issuer: this.receiptIssuer,
      payer: this.receiptSubject ?? view.payer,
      expirationDate: new Date(this.clock.now().getTime() + 600_000),
      metadata: { paymentId: view.paymentId },
    })
    this.receipts.push(receipt)
    return json({ receipt })
  }
}
