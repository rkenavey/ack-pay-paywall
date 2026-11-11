import { APPROVER_TOKEN, BASE_URL, CLIENT_ORIGIN } from "./builders.ts"
import { fixtures } from "./identities.ts"
import { FAKE_STRIPE_KEYS } from "./stripe.ts"

/**
 * Environment variables for the server built from the fixture identities:
 * Acme on the allowlist, the sandbox network on, no Stripe keys. Pass
 * `overrides` to change or add variables; an `undefined` value removes one.
 */
export function fixtureEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    PORT: "8787",
    PUBLIC_BASE_URL: BASE_URL,
    CLIENT_ORIGIN,
    ACME_AGENT_JWK: JSON.stringify(fixtures.acme.jwk),
    GLOBEX_AGENT_JWK: JSON.stringify(fixtures.globex.jwk),
    PAYMENT_SERVICE_JWK: JSON.stringify(fixtures.paymentService.jwk),
    POLICY_ALLOWED_COUNTERPARTIES: fixtures.acme.did,
    POLICY_APPROVAL_THRESHOLD_MINOR: "5000",
    APPROVER_TOKEN,
    PAYMENT_REQUEST_TTL_SECONDS: "900",
    RECEIPT_TTL_SECONDS: "600",
    SANDBOX_NETWORK: "on",
    LOG_FORMAT: "json",
    ...overrides,
  }
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key]
  return env
}

/** The Stripe variables for {@link fixtureEnv}, with the fake test-mode keys. */
export const fixtureStripeEnv = {
  STRIPE_SECRET_KEY: FAKE_STRIPE_KEYS.secretKey,
  STRIPE_PUBLISHABLE_KEY: FAKE_STRIPE_KEYS.publishableKey,
  STRIPE_WEBHOOK_SECRET: FAKE_STRIPE_KEYS.webhookSecret,
} as const
