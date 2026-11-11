import { createJwt, verifyPaymentReceipt, verifyPaymentRequestToken, type PaymentRequest } from "agentcommercekit"
import * as v from "valibot"
import {
  actorOf,
  didSchema,
  errorBodySchema,
  paymentRequiredBodySchema,
  paymentViewSchema,
  receiptBodySchema,
  RECEIPT_HEADER,
  resourceBodySchema,
  tokenTail,
  MAX_INITIATION_LIFETIME_SECONDS,
  type DidUri,
  type EventName,
  type JwtString,
  type Network,
  type PaymentOption,
  type PaymentView,
  type ProtocolEvent,
  type ResourceBody,
} from "@paywall/protocol"
import type { FlowFailure, FlowState, PaywallClient, PaywallClientDeps } from "./types.ts"

/** A protocol failure that ends the run; `fetchPaid` turns it into a `failed` state. */
class FlowError extends Error {
  readonly code: FlowFailure
  readonly details: Record<string, unknown> | undefined

  constructor(code: FlowFailure, message: string, details?: Record<string, unknown>) {
    super(message)
    this.code = code
    this.details = details
  }
}

/** Deep equality for JSON values, independent of key order. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => sameJson(item, b[i]))
  const ra = a as Record<string, unknown>
  const rb = b as Record<string, unknown>
  const keys = Object.keys(ra).filter((k) => ra[k] !== undefined)
  const otherKeys = Object.keys(rb).filter((k) => rb[k] !== undefined)
  return keys.length === otherKeys.length && keys.every((k) => sameJson(ra[k], rb[k]))
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

/** The error code and message of an `ErrorBody`, or the status when the body is something else. */
function describeError(status: number, body: unknown): { code?: string; message: string; details?: Record<string, unknown> } {
  const parsed = v.safeParse(errorBodySchema, body)
  if (!parsed.success) return { message: `unexpected HTTP ${status}` }
  const { code, message, details } = parsed.output.error
  return { code, message, ...(details ? { details } : {}) }
}

function httpError(step: string, response: Response, body: unknown): FlowError {
  const error = describeError(response.status, body)
  return new FlowError("http_error", `${step} answered HTTP ${response.status}: ${error.message}`, {
    status: response.status,
    ...(error.code ? { code: error.code } : {}),
  })
}

/**
 * Creates the client agent. On a 402 it verifies the payment request token,
 * selects an option, sends a signed initiation to the option's payment
 * service, waits for a human when asked to, runs the executor for the
 * network, verifies the receipt and retries the request once with it.
 */
export function createPaywallClient(deps: PaywallClientDeps): PaywallClient {
  const { identity, resolver, log } = deps
  const listeners = new Set<(state: FlowState) => void>()
  const supported: Network[] = deps.executors.map((executor) => executor.network)

  function publish(state: FlowState): void {
    for (const listener of [...listeners]) listener({ ...state })
  }

  async function fetchPaid(url: string, init: { signal?: AbortSignal } = {}): Promise<FlowState> {
    const signal = init.signal ?? new AbortController().signal
    let state: FlowState = { status: "idle" }
    const update = (patch: Partial<FlowState>): void => {
      state = { ...state, ...patch }
      publish(state)
    }
    const emit = (name: EventName, data?: ProtocolEvent["data"]): void => {
      const event: Omit<ProtocolEvent, "at"> = { name, actor: actorOf(name) }
      const paymentRequestId = state.paymentRequired?.paymentRequest.id
      if (paymentRequestId) event.paymentRequestId = paymentRequestId
      if (state.payment) event.paymentId = state.payment.paymentId
      if (data) event.data = data
      log.emit(event)
    }
    const checkAborted = (): void => {
      if (signal.aborted) throw new FlowError("aborted", "The run was aborted.")
    }
    const send = async (input: string, request: RequestInit = {}): Promise<Response> => {
      checkAborted()
      try {
        return await deps.fetch(input, { ...request, signal })
      } catch (error) {
        checkAborted()
        throw new FlowError("http_error", `The request to ${input} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    try {
      checkAborted()
      update({ status: "requesting" })
      emit("client.request.sent", { url })
      const first = await send(url)
      if (first.status === 200) return deliver(await readResource(first))
      const firstBody = await readJson(first)
      if (first.status !== 402) throw httpError("The resource", first, firstBody)

      // Step 2: the payment request. Only the verified token is trusted.
      emit("client.payment_required.received", { status: 402 })
      update({ status: "verifying_request" })
      const body = v.safeParse(paymentRequiredBodySchema, firstBody)
      if (!body.success) throw new FlowError("payment_request_invalid", "The 402 body is not a payment-required body.")
      const paymentRequestToken = body.output.paymentRequestToken
      let paymentRequest: PaymentRequest
      let payee: DidUri
      try {
        const verified = await verifyPaymentRequestToken(paymentRequestToken, { resolver })
        if (!v.is(didSchema, verified.parsed.issuer)) throw new Error("issuer is not a DID")
        paymentRequest = verified.paymentRequest
        payee = verified.parsed.issuer
      } catch {
        throw new FlowError("payment_request_invalid", "The payment request token does not verify.")
      }
      checkAborted()
      update({
        paymentRequired: { ...body.output, paymentRequest, paymentRequestToken },
        payee,
      })
      if (!sameJson(body.output.paymentRequest, paymentRequest)) {
        throw new FlowError("payment_request_mismatch", "The unsigned payment request in the body differs from the signed token.")
      }
      if (paymentRequest.expiresAt !== undefined) {
        const expiresAt = new Date(paymentRequest.expiresAt).getTime()
        if (Number.isNaN(expiresAt) || expiresAt <= deps.clock.now().getTime()) {
          throw new FlowError("payment_request_expired", "The payment request has expired.", { expiresAt: paymentRequest.expiresAt })
        }
      }
      emit("client.payment_request.verified", { payee, token: tokenTail(paymentRequestToken), options: paymentRequest.paymentOptions.length })

      // Step 3: choose an option and contact its payment service.
      update({ status: "selecting_option" })
      const option = deps.selectOption(paymentRequest.paymentOptions, supported)
      const executor = option ? deps.executors.find((candidate) => candidate.network === option.network) : undefined
      if (!option || !executor || typeof option.paymentService !== "string") {
        throw new FlowError("no_supported_option", "No payment option is on a network this client can pay on.", {
          offered: paymentRequest.paymentOptions.map((o) => o.network ?? "unknown").join(","),
          supported: supported.join(","),
        })
      }
      update({ selectedOption: option })
      emit("client.option.selected", { option: option.id, network: executor.network })
      const paymentServiceUrl = option.paymentService

      update({ status: "initiating" })
      const initiation = await createJwt(
        { aud: paymentServiceUrl, paymentRequestToken, paymentOptionId: option.id },
        { issuer: identity.did, signer: identity.signer, expiresIn: MAX_INITIATION_LIFETIME_SECONDS },
        { alg: identity.alg },
      )
      checkAborted()
      emit("client.payment.initiated", { option: option.id, paymentService: paymentServiceUrl, initiation: tokenTail(initiation) })
      const initiated = await send(`${paymentServiceUrl}/payments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initiation }),
      })
      const initiatedBody = await readJson(initiated)
      if (initiated.status === 403) {
        const error = describeError(403, initiatedBody)
        if (error.code === "policy_denied") throw new FlowError("policy_denied", error.message, error.details ?? {})
      }
      if (initiated.status === 410) {
        throw new FlowError("payment_request_expired", describeError(410, initiatedBody).message)
      }
      if (![200, 201, 202].includes(initiated.status)) throw httpError("The payment service", initiated, initiatedBody)
      let payment = readPayment(initiatedBody, option, paymentRequest.id)
      update({ payment })

      // Step 4: a human decides.
      if (payment.status === "pending_approval") {
        update({ status: "awaiting_approval" })
        emit("client.approval.waiting", { approvalId: payment.approvalId ?? null })
        payment = await waitForDecision(payment, paymentServiceUrl, option, paymentRequest.id)
        update({ payment })
      }
      if (payment.status === "rejected") throw new FlowError("approval_rejected", "The human approver rejected the payment.")
      if (payment.status === "failed") throw new FlowError("payment_failed", payment.failure ?? "The payment failed.")

      // Step 5: pay, unless a repeated initiation found the payment already settled.
      if (payment.status === "requires_payment") {
        const next = payment.next
        if (!next) throw new FlowError("http_error", "The payment service sent no next action.")
        update({ status: "paying" })
        emit("client.payment.executing", { network: executor.network, next: next.type })
        try {
          await executor.execute({ payment, next, paymentServiceUrl, fetch: deps.fetch, signal })
        } catch (error) {
          checkAborted()
          throw new FlowError("payment_failed", error instanceof Error ? error.message : "The payment did not complete.")
        }
      }

      // Steps 6 and 7: the receipt, verified before it is presented.
      checkAborted()
      update({ status: "fetching_receipt" })
      const receiptResponse = await send(`${paymentServiceUrl}/payments/${encodeURIComponent(payment.paymentId)}/receipt`, { method: "POST" })
      const receiptJson = await readJson(receiptResponse)
      if (receiptResponse.status !== 200) throw httpError("The receipt route", receiptResponse, receiptJson)
      const receiptBody = v.safeParse(receiptBodySchema, receiptJson)
      if (!receiptBody.success) throw new FlowError("receipt_invalid", "The receipt route did not answer with a receipt.")
      const receipt: JwtString = receiptBody.output.receipt
      emit("client.receipt.received", { receipt: tokenTail(receipt) })
      const receiptInfo = await verifyReceipt(receipt, option, payee, paymentRequestToken)
      checkAborted()
      update({ receipt })
      emit("client.receipt.verified", {
        issuer: receiptInfo.issuer,
        payer: receiptInfo.payer,
        option: receiptInfo.option,
        expires: receiptInfo.expirationDate ?? null,
      })

      // Step 8: present it, once.
      update({ status: "retrying" })
      emit("client.request.retried", { receipt: tokenTail(receipt) })
      const retried = await send(url, { headers: { [RECEIPT_HEADER]: receipt } })
      if (retried.status === 200) return deliver(await readResource(retried))
      const retriedBody = await readJson(retried)
      if (retried.status === 402) {
        const refused = v.safeParse(paymentRequiredBodySchema, retriedBody)
        const code = refused.success ? refused.output.error?.code : undefined
        throw new FlowError("payment_not_accepted", "The server refused the receipt.", code ? { code } : {})
      }
      throw httpError("The resource", retried, retriedBody)
    } catch (error) {
      const failure =
        signal.aborted
          ? new FlowError("aborted", "The run was aborted.")
          : error instanceof FlowError
            ? error
            : new FlowError("http_error", error instanceof Error ? error.message : "The run failed unexpectedly.")
      update({
        status: "failed",
        failure: { code: failure.code, message: failure.message, ...(failure.details ? { details: failure.details } : {}) },
      })
      const data: ProtocolEvent["data"] = { code: failure.code }
      const rule = failure.details?.rule
      if (typeof rule === "string") data.rule = rule
      emit("client.flow.failed", data)
      return state
    }

    function deliver(resource: ResourceBody): FlowState {
      update({ status: "delivered", resource })
      emit("client.resource.received", { resource: resource.id })
      return state
    }

    async function readResource(response: Response): Promise<ResourceBody> {
      const parsed = v.safeParse(resourceBodySchema, await readJson(response))
      if (!parsed.success) throw new FlowError("http_error", "The resource body is not a resource.")
      return parsed.output
    }

    /** Validates a payment view and checks it is the payment this run asked for. */
    function readPayment(raw: unknown, option: PaymentOption, paymentRequestId: string): PaymentView {
      const parsed = v.safeParse(paymentViewSchema, raw)
      if (!parsed.success) throw new FlowError("http_error", "The payment service answered with something that is not a payment.")
      const view = parsed.output
      if (view.paymentOptionId !== option.id || view.paymentRequestId !== paymentRequestId || view.payer !== identity.did || view.network !== option.network) {
        throw new FlowError("http_error", "The payment service answered with another payment.")
      }
      return view
    }

    /** Polls the payment until a human has decided, the poll times out or the run is aborted. */
    async function waitForDecision(initial: PaymentView, paymentServiceUrl: string, option: PaymentOption, paymentRequestId: string): Promise<PaymentView> {
      const { intervalMs, timeoutMs } = deps.approvalPoll
      let waited = 0
      let payment = initial
      while (payment.status === "pending_approval") {
        if (waited >= timeoutMs) throw new FlowError("approval_timeout", "No human decided on the payment in time.", { timeoutMs })
        const delay = Math.max(0, Math.min(intervalMs, timeoutMs - waited))
        await sleep(delay, signal)
        waited += delay
        const response = await send(`${paymentServiceUrl}/payments/${encodeURIComponent(payment.paymentId)}`)
        const raw = await readJson(response)
        if (response.status !== 200) throw httpError("The payment status route", response, raw)
        payment = readPayment(raw, option, paymentRequestId)
      }
      return payment
    }

    /** Step 6: the receipt is from the option's receipt service, for this token, this option and this client. */
    async function verifyReceipt(receipt: JwtString, option: PaymentOption, payee: DidUri, paymentRequestToken: JwtString) {
      if (typeof option.receiptService !== "string") throw new FlowError("receipt_invalid", "The payment option names no receipt service.")
      let verified: Awaited<ReturnType<typeof verifyPaymentReceipt>>
      try {
        verified = await verifyPaymentReceipt(receipt, {
          resolver,
          trustedReceiptIssuers: [option.receiptService],
          paymentRequestIssuer: payee,
        })
      } catch (error) {
        throw new FlowError("receipt_invalid", `The receipt does not verify: ${error instanceof Error ? error.message : "unknown error"}`)
      }
      const subject: unknown = verified.receipt.credentialSubject
      const claims = typeof subject === "object" && subject !== null ? (subject as Record<string, unknown>) : {}
      if (verified.paymentRequestToken !== paymentRequestToken) throw new FlowError("receipt_invalid", "The receipt is for another payment request.")
      if (claims.id !== identity.did) throw new FlowError("receipt_invalid", "The receipt was issued to someone else.")
      if (claims.paymentOptionId !== option.id) throw new FlowError("receipt_invalid", "The receipt is for another payment option.")
      const rawIssuer: unknown = verified.receipt.issuer
      const issuer = typeof rawIssuer === "string" ? rawIssuer : typeof rawIssuer === "object" && rawIssuer !== null ? (rawIssuer as { id?: unknown }).id : undefined
      if (typeof issuer !== "string") throw new FlowError("receipt_invalid", "The receipt names no issuer.")
      const expirationDate = verified.receipt.expirationDate
      // Everything returned is read from the verified credential, after the checks above.
      return {
        issuer,
        payer: claims.id,
        option: claims.paymentOptionId,
        expirationDate: typeof expirationDate === "string" ? expirationDate : undefined,
      }
    }
  }

  return {
    fetchPaid,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/** Waits `ms` milliseconds, or rejects as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new FlowError("aborted", "The run was aborted."))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(new FlowError("aborted", "The run was aborted."))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}
