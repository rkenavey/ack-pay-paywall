import type { PrivateKeyJwk } from "agentcommercekit"
import { NotImplementedError } from "@paywall/protocol"
import type { SpendPolicyConfig } from "../policy/index.ts"
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

/**
 * Reads and validates the configuration from environment variables such as
 * `process.env`.
 *
 * Throws an error whose message names the variable when a required value is
 * missing or any value is malformed, including a Stripe key that is not a
 * test-mode key. The message never contains the value.
 */
export function parseConfig(env: Record<string, string | undefined>): AppConfig {
  void env
  throw new NotImplementedError("T3")
}
