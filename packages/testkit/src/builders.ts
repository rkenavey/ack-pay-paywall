import {
  createCredential,
  createJwt,
  createPaymentReceipt,
  createSignedPaymentRequest,
  signCredential,
  type DidUri,
  type JwtString,
  type PaymentOption,
  type PaymentRequest,
} from "agentcommercekit"
import type { AgentIdentity, Network } from "@paywall/protocol"
import { fixtures } from "./identities.ts"

/** The base URL the tests serve the whole app on. */
export const BASE_URL = "http://localhost:8787"

/** The payment service URL the tests use; payment options name it as their `paymentService`. */
export const PAYMENT_SERVICE_URL = `${BASE_URL}/payment-service`

/** The browser origin the tests allow through CORS. */
export const CLIENT_ORIGIN = "http://localhost:5173"

/** The approver bearer token the tests configure. Test-only. */
export const APPROVER_TOKEN = "test-approver-token-0123456789abcdef"

/** A payment option as the server agents issue it: id `<network>-usd`. */
export function paymentOption(options: {
  network: Network | string
  amount?: number | string
  decimals?: number
  currency?: string
  recipient?: DidUri
  paymentService?: string
  receiptService?: string
  id?: string
}): PaymentOption {
  return {
    id: options.id ?? `${options.network}-usd`,
    amount: options.amount ?? 500,
    decimals: options.decimals ?? 2,
    currency: options.currency ?? "USD",
    recipient: options.recipient ?? fixtures.acme.did,
    network: options.network,
    paymentService: options.paymentService ?? PAYMENT_SERVICE_URL,
    receiptService: options.receiptService ?? fixtures.paymentService.did,
  }
}

/**
 * Signs a payment request with `issuer` (Acme by default) using the ACK
 * functions. By default it offers a sandbox option of $5.00 and expires 900
 * seconds after `now`.
 */
export async function buildPaymentRequest(options: {
  now: Date
  issuer?: AgentIdentity
  id?: string
  description?: string
  expiresAt?: Date
  paymentOptions?: PaymentOption[]
}): Promise<{ paymentRequest: PaymentRequest; paymentRequestToken: JwtString }> {
  const issuer = options.issuer ?? fixtures.acme
  const paymentOptions = options.paymentOptions ?? [paymentOption({ network: "sandbox", recipient: issuer.did })]
  const [first, ...rest] = paymentOptions
  if (!first) throw new Error("a payment request needs at least one option")
  return createSignedPaymentRequest(
    {
      id: options.id ?? "pr_fixture",
      description: options.description ?? "Market brief",
      expiresAt: options.expiresAt ?? new Date(options.now.getTime() + 900_000),
      paymentOptions: [first, ...rest],
    },
    { issuer: issuer.did, signer: issuer.signer, algorithm: issuer.alg },
  )
}

/**
 * Signs a payment initiation JWT as `payer` (the client by default) with the
 * ACK `createJwt`. `claims` replace or add private claims; pass `undefined`
 * for a claim to leave it out. `expiresIn` defaults to 300 seconds; `null`
 * leaves `exp` out.
 */
export async function buildInitiation(options: {
  paymentRequestToken?: string
  paymentOptionId?: string
  audience?: string | null
  payer?: AgentIdentity
  signer?: AgentIdentity
  expiresIn?: number | null
  claims?: Record<string, unknown>
}): Promise<JwtString> {
  const payer = options.payer ?? fixtures.client
  const signer = options.signer ?? payer
  const payload: Record<string, unknown> = {
    paymentRequestToken: options.paymentRequestToken,
    paymentOptionId: options.paymentOptionId,
    ...options.claims,
  }
  const audience = options.audience === undefined ? PAYMENT_SERVICE_URL : options.audience
  if (audience !== null) payload.aud = audience
  for (const key of Object.keys(payload)) if (payload[key] === undefined) delete payload[key]
  const expiresIn = options.expiresIn === undefined ? 300 : options.expiresIn
  return createJwt(
    payload,
    { issuer: payer.did, signer: signer.signer, ...(expiresIn === null ? {} : { expiresIn }) },
    { alg: signer.alg },
  )
}

/**
 * Signs a `PaymentReceiptCredential` with the ACK functions, issued by
 * `issuer` (the payment service by default) to `payer` (the client by
 * default), expiring at `expirationDate`.
 */
export async function buildReceipt(options: {
  paymentRequestToken: string
  paymentOptionId: string
  expirationDate: Date
  issuer?: AgentIdentity
  payer?: DidUri
  metadata?: Record<string, unknown>
}): Promise<JwtString> {
  const issuer = options.issuer ?? fixtures.paymentService
  const credential = createPaymentReceipt({
    paymentRequestToken: options.paymentRequestToken,
    paymentOptionId: options.paymentOptionId,
    issuer: issuer.did,
    payerDid: options.payer ?? fixtures.client.did,
    expirationDate: options.expirationDate,
    ...(options.metadata ? { metadata: options.metadata } : {}),
  })
  return signCredential(credential, { did: issuer.did, signer: issuer.signer, alg: issuer.alg })
}

/**
 * Signs a credential that is not a payment receipt but carries the same
 * claims, so only its type is wrong.
 */
export async function buildOtherCredential(options: {
  paymentRequestToken: string
  paymentOptionId: string
  expirationDate: Date
  issuer?: AgentIdentity
  payer?: DidUri
}): Promise<JwtString> {
  const issuer = options.issuer ?? fixtures.paymentService
  const credential = createCredential({
    type: "MembershipCredential",
    issuer: issuer.did,
    subject: options.payer ?? fixtures.client.did,
    expirationDate: options.expirationDate,
    attestation: { paymentRequestToken: options.paymentRequestToken, paymentOptionId: options.paymentOptionId },
  })
  return signCredential(credential, { did: issuer.did, signer: issuer.signer, alg: issuer.alg })
}

/**
 * Returns the JWT with one character of its signature changed, so the
 * header and payload are intact but the signature no longer verifies.
 */
export function tamperSignature(jwt: string): string {
  const dot = jwt.lastIndexOf(".")
  const at = dot + 1 + Math.floor((jwt.length - dot - 1) / 2)
  const replacement = jwt[at] === "A" ? "B" : "A"
  return `${jwt.slice(0, at)}${replacement}${jwt.slice(at + 1)}`
}
