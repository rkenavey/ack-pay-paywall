import { isPrivateKeyJwk, type PrivateKeyJwk } from "agentcommercekit"
import { parseSpendPolicyConfig, type SpendPolicyConfig } from "../policy/index.ts"
import { identityFromJwk } from "./identity.ts"
import type { LogFormat } from "./log.ts"

/**
 * The server's configuration, read once at startup.
 *
 * Holds secrets (private JWKs, the approver token, Stripe keys): never log it
 * or send any of it to a client.
 */
export interface AppConfig {
  port: number
  /** The server's public origin; the payment service URL is this plus `/payment-service`. */
  publicBaseUrl: string
  /** The only browser origin CORS allows. */
  clientOrigin: string
  acmeAgentJwk: PrivateKeyJwk
  globexAgentJwk: PrivateKeyJwk
  paymentServiceJwk: PrivateKeyJwk
  policy: SpendPolicyConfig
  approverToken: string
  paymentRequestTtlSeconds: number
  receiptTtlSeconds: number
  sandboxNetwork: boolean
  /** Present only with a test-mode secret and publishable key pair. */
  stripe?: { secretKey: string; publishableKey: string; webhookSecret?: string }
  logFormat: LogFormat
}

type Env = Record<string, string | undefined>

/** Minimum length of `APPROVER_TOKEN`. */
const MIN_APPROVER_TOKEN_LENGTH = 24

// An unset variable and an empty one both mean "use the default", so a blank
// line copied from .env.example behaves like a missing one.
function optional(env: Env, name: string): string | undefined {
  const value = env[name]?.trim()
  return value === undefined || value === "" ? undefined : value
}

function required(env: Env, name: string): string {
  const value = optional(env, name)
  if (value === undefined) throw new Error(`${name} is required`)
  return value
}

function integer(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = optional(env, name)
  if (raw === undefined) return fallback
  const value = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}`)
  }
  return value
}

function origin(env: Env, name: string, fallback: string, allowPath: boolean): string {
  const raw = (optional(env, name) ?? fallback).replace(/\/+$/, "")
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${name} must be an http or https URL`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${name} must be an http or https URL`)
  if (url.search || url.hash || url.username || url.password) throw new Error(`${name} must not have a query, fragment or credentials`)
  if (!allowPath && url.pathname !== "/") throw new Error(`${name} must be an origin, such as http://localhost:5173, with no path`)
  return allowPath ? `${url.origin}${url.pathname.replace(/\/+$/, "")}` : url.origin
}

function privateJwk(env: Env, name: string): PrivateKeyJwk {
  const raw = required(env, name)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // The parser's message can quote the input, which is a private key.
    throw new Error(`${name} must be a private JWK as one-line JSON`)
  }
  if (!isPrivateKeyJwk(parsed)) throw new Error(`${name} must be a private JWK (Ed25519, secp256k1 or secp256r1)`)
  try {
    identityFromJwk(parsed)
  } catch {
    throw new Error(`${name} is not a usable private key`)
  }
  return parsed
}

function choice<T extends string>(env: Env, name: string, values: readonly T[], fallback: T): T {
  const raw = optional(env, name) ?? fallback
  if (!(values as readonly string[]).includes(raw)) throw new Error(`${name} must be one of ${values.join(", ")}`)
  return raw as T
}

function stripeKeys(env: Env): AppConfig["stripe"] {
  const secretKey = optional(env, "STRIPE_SECRET_KEY")
  const publishableKey = optional(env, "STRIPE_PUBLISHABLE_KEY")
  const webhookSecret = optional(env, "STRIPE_WEBHOOK_SECRET")
  if (secretKey === undefined && publishableKey === undefined) {
    if (webhookSecret !== undefined) throw new Error("STRIPE_WEBHOOK_SECRET is set without STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY")
    return undefined
  }
  if (secretKey === undefined) throw new Error("STRIPE_SECRET_KEY is required when STRIPE_PUBLISHABLE_KEY is set")
  if (publishableKey === undefined) throw new Error("STRIPE_PUBLISHABLE_KEY is required when STRIPE_SECRET_KEY is set")
  if (!/^(sk|rk)_test_[A-Za-z0-9_]+$/.test(secretKey)) {
    throw new Error("STRIPE_SECRET_KEY must be a test-mode key (sk_test_... or rk_test_...); live-mode keys are refused")
  }
  if (!/^pk_test_[A-Za-z0-9_]+$/.test(publishableKey)) {
    throw new Error("STRIPE_PUBLISHABLE_KEY must be a test-mode key (pk_test_...); live-mode keys are refused")
  }
  if (webhookSecret !== undefined && !/^whsec_[A-Za-z0-9_]+$/.test(webhookSecret)) {
    throw new Error("STRIPE_WEBHOOK_SECRET must be a webhook signing secret (whsec_...)")
  }
  return { secretKey, publishableKey, ...(webhookSecret === undefined ? {} : { webhookSecret }) }
}

/**
 * Reads and validates the configuration from environment variables such as
 * `process.env`.
 *
 * Throws an error whose message names the variable when a required value is
 * missing or any value is malformed, including a Stripe key that is not a
 * test-mode key. The message never contains the value.
 */
export function parseConfig(env: Record<string, string | undefined>): AppConfig {
  const acmeAgentJwk = privateJwk(env, "ACME_AGENT_JWK")
  const globexAgentJwk = privateJwk(env, "GLOBEX_AGENT_JWK")
  const paymentServiceJwk = privateJwk(env, "PAYMENT_SERVICE_JWK")
  // The roles must not share a key: the server agents trust the payment service only by its DID.
  const dids = [acmeAgentJwk, globexAgentJwk, paymentServiceJwk].map((jwk) => identityFromJwk(jwk).did)
  if (new Set(dids).size !== dids.length) {
    throw new Error("ACME_AGENT_JWK, GLOBEX_AGENT_JWK and PAYMENT_SERVICE_JWK must be three different keys")
  }

  const approverToken = required(env, "APPROVER_TOKEN")
  if (approverToken.length < MIN_APPROVER_TOKEN_LENGTH) {
    throw new Error(`APPROVER_TOKEN must be at least ${MIN_APPROVER_TOKEN_LENGTH} characters`)
  }

  const sandboxNetwork = choice(env, "SANDBOX_NETWORK", ["on", "off"], "on") === "on"
  const stripe = stripeKeys(env)
  if (!sandboxNetwork && stripe === undefined) {
    throw new Error("SANDBOX_NETWORK is off and STRIPE_SECRET_KEY is not set, so no payment network would be offered")
  }

  return {
    port: integer(env, "PORT", 8787, 0, 65535),
    publicBaseUrl: origin(env, "PUBLIC_BASE_URL", "http://localhost:8787", true),
    clientOrigin: origin(env, "CLIENT_ORIGIN", "http://localhost:5173", false),
    acmeAgentJwk,
    globexAgentJwk,
    paymentServiceJwk,
    policy: parseSpendPolicyConfig(env),
    approverToken,
    paymentRequestTtlSeconds: integer(env, "PAYMENT_REQUEST_TTL_SECONDS", 900, 1, 86_400),
    receiptTtlSeconds: integer(env, "RECEIPT_TTL_SECONDS", 600, 1, 86_400),
    sandboxNetwork,
    ...(stripe === undefined ? {} : { stripe }),
    logFormat: choice(env, "LOG_FORMAT", ["pretty", "json"], "pretty"),
  }
}
