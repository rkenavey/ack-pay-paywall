import {
  createSignedPaymentRequest,
  CredentialExpiredError,
  UntrustedIssuerError,
  verifyPaymentReceipt,
  type PaymentOption,
  type Resolvable,
} from "agentcommercekit"
import { Hono, type Context } from "hono"
import {
  formatMoney,
  RECEIPT_HEADER,
  tokenTail,
  type AgentIdentity,
  type Clock,
  type DidUri,
  type ErrorBody,
  type EventLog,
  type IdGenerator,
  type Network,
  type PaymentRequiredBody,
  type ReceiptErrorCode,
  type ResourceBody,
  type ResourceListBody,
  type ResourceSummary,
} from "@paywall/protocol"

/** A paywalled resource: its catalog summary plus the content delivered once it is paid for. */
export interface CatalogEntry extends ResourceSummary {
  content: string
}

/**
 * What a server agent remembers about a payment request it issued.
 *
 * The resource binding lives here and not in the token, because the ACK
 * payment request schema drops unknown fields.
 */
export interface IssuedPaymentRequest {
  id: string
  resourceId: string
  expiresAt: Date
  redeemedAt?: Date
}

/** Storage for issued payment requests. */
export interface PaymentRequestStore {
  save(record: IssuedPaymentRequest): Promise<void>
  get(id: string): Promise<IssuedPaymentRequest | undefined>
  /** Marks the request redeemed. Atomic: resolves true for the first caller only. */
  redeem(id: string, at: Date): Promise<boolean>
}

/**
 * Everything a server agent needs.
 *
 * `paymentService` says where clients pay (`url`), whose receipts are trusted
 * (`did`) and which networks to offer, one payment option per network, in
 * this order.
 */
export interface ServerAgentDeps {
  identity: AgentIdentity
  catalog: readonly CatalogEntry[]
  store: PaymentRequestStore
  paymentService: { url: string; did: DidUri; networks: readonly Network[] }
  paymentRequestTtlSeconds: number
  resolver: Resolvable
  clock: Clock
  ids: IdGenerator
  log: EventLog
}

const RECEIPT_MESSAGES: Readonly<Record<ReceiptErrorCode, string>> = {
  receipt_invalid: "The receipt is not a valid payment receipt for a payment request issued here.",
  receipt_untrusted_issuer: "The receipt was not issued by the trusted payment service.",
  receipt_expired: "The receipt has expired.",
  receipt_wrong_resource: "The receipt pays for another resource.",
  receipt_already_redeemed: "The receipt has already been redeemed.",
}

type ReceiptCheck = { ok: true; paymentRequestId: string; paymentOptionId: string } | { ok: false; code: ReceiptErrorCode; paymentRequestId?: string }

/**
 * Builds a server agent: `GET /resources` lists the catalog for free, and
 * `GET /resources/:id` answers `402` with a signed ACK payment request until
 * the request carries a valid, unredeemed receipt in the `Payment-Receipt`
 * header. Each receipt is delivered once.
 *
 * Mount the returned app under a prefix such as `/api`. A failure inside the
 * agent answers `500` and delivers nothing.
 */
export function createServerAgent(deps: ServerAgentDeps): Hono {
  const { identity, catalog, store, paymentService, clock, ids, log } = deps
  if (paymentService.networks.length === 0) throw new Error("a server agent needs at least one payment network to offer")
  const emit = (event: Parameters<EventLog["emit"]>[0]) => log.emit(event)
  const app = new Hono()

  app.onError((_error, c) => c.json<ErrorBody>({ error: { code: "internal_error", message: "The server agent failed." } }, 500))

  app.get("/resources", (c) => {
    const resources = catalog.map(({ id, title, price }) => ({ id, title, price: { ...price } }))
    return c.json<ResourceListBody>({ resources })
  })

  app.get("/resources/:id", async (c) => {
    const resourceId = c.req.param("id")
    const presented = c.req.header(RECEIPT_HEADER)
    emit({ name: "server.request.received", actor: "server-agent", data: { resource: resourceId, receipt: presented !== undefined } })

    const entry = catalog.find((candidate) => candidate.id === resourceId)
    if (!entry) {
      return c.json<ErrorBody<"resource_not_found">>({ error: { code: "resource_not_found", message: `No resource "${resourceId}".` } }, 404)
    }
    if (presented === undefined) return paymentRequired(c, entry)

    emit({ name: "server.receipt.presented", actor: "server-agent", data: { resource: entry.id, receipt: tokenTail(presented) } })
    const check = await checkReceipt(presented, entry)
    if (!check.ok) {
      emit({
        name: "server.receipt.rejected",
        actor: "server-agent",
        ...(check.paymentRequestId === undefined ? {} : { paymentRequestId: check.paymentRequestId }),
        data: { resource: entry.id, code: check.code },
      })
      return paymentRequired(c, entry, check.code)
    }

    emit({
      name: "server.receipt.verified",
      actor: "server-agent",
      paymentRequestId: check.paymentRequestId,
      data: { resource: entry.id, option: check.paymentOptionId },
    })
    emit({ name: "server.resource.delivered", actor: "server-agent", paymentRequestId: check.paymentRequestId, data: { resource: entry.id } })
    // Paid content is for this caller only.
    c.header("Cache-Control", "no-store")
    return c.json<ResourceBody>({ id: entry.id, title: entry.title, content: entry.content })
  })

  async function paymentRequired(c: Context, entry: CatalogEntry, code?: ReceiptErrorCode): Promise<Response> {
    const id = ids.next("pr")
    const expiresAt = new Date(clock.now().getTime() + deps.paymentRequestTtlSeconds * 1000)
    const options: PaymentOption[] = paymentService.networks.map((network) => ({
      id: `${network}-usd`,
      amount: entry.price.amount,
      decimals: entry.price.decimals,
      currency: entry.price.currency,
      recipient: identity.did,
      network,
      paymentService: paymentService.url,
      receiptService: paymentService.did,
    }))
    const [first, ...rest] = options
    if (!first) throw new Error("no payment network to offer")
    const { paymentRequest, paymentRequestToken } = await createSignedPaymentRequest(
      { id, description: entry.title, expiresAt, paymentOptions: [first, ...rest] },
      { issuer: identity.did, signer: identity.signer, algorithm: identity.alg },
    )
    await store.save({ id, resourceId: entry.id, expiresAt })
    emit({
      name: "server.payment_required.issued",
      actor: "server-agent",
      paymentRequestId: id,
      data: {
        resource: entry.id,
        amount: formatMoney(entry.price),
        options: options.map((option) => option.id).join(","),
        expiresAt: expiresAt.toISOString(),
        token: tokenTail(paymentRequestToken),
      },
    })
    const body: PaymentRequiredBody = {
      paymentRequest,
      paymentRequestToken,
      ...(code === undefined ? {} : { error: { code, message: RECEIPT_MESSAGES[code] } }),
    }
    c.header("Cache-Control", "no-store")
    return c.json(body, 402)
  }

  async function checkReceipt(presented: string, entry: CatalogEntry): Promise<ReceiptCheck> {
    let verified: Awaited<ReturnType<typeof verifyPaymentReceipt>>
    try {
      verified = await verifyPaymentReceipt(presented, {
        resolver: deps.resolver,
        trustedReceiptIssuers: [paymentService.did],
        paymentRequestIssuer: identity.did,
      })
    } catch (error) {
      if (error instanceof UntrustedIssuerError) return { ok: false, code: "receipt_untrusted_issuer" }
      if (error instanceof CredentialExpiredError) return { ok: false, code: "receipt_expired" }
      return { ok: false, code: "receipt_invalid" }
    }

    // From here on only the values verifyPaymentReceipt returned are read.
    const { receipt, paymentRequest } = verified
    if (!paymentRequest) return { ok: false, code: "receipt_invalid" }
    const paymentRequestId = paymentRequest.id
    const issued = await store.get(paymentRequestId)
    if (!issued) return { ok: false, code: "receipt_invalid", paymentRequestId }
    if (issued.resourceId !== entry.id) return { ok: false, code: "receipt_wrong_resource", paymentRequestId }

    const subject: unknown = receipt.credentialSubject
    const paymentOptionId = typeof subject === "object" && subject !== null ? (subject as Record<string, unknown>).paymentOptionId : undefined
    if (typeof paymentOptionId !== "string" || !paymentRequest.paymentOptions.some((option) => option.id === paymentOptionId)) {
      return { ok: false, code: "receipt_invalid", paymentRequestId }
    }

    if (!(await store.redeem(paymentRequestId, clock.now()))) return { ok: false, code: "receipt_already_redeemed", paymentRequestId }
    return { ok: true, paymentRequestId, paymentOptionId }
  }

  return app
}

/** The identity, clock and id interfaces the server agent depends on, defined in the protocol package. */
export type { AgentIdentity, Clock, IdGenerator } from "@paywall/protocol"
