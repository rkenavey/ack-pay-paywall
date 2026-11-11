import {
  createDidKeyUri,
  createJwtSigner,
  curveToJwtAlgorithm,
  getDidResolver,
  jwkToKeypair,
  privateKeyBytesToJwk,
  type KeyCurve,
  type PrivateKeyJwk,
  type Resolvable,
} from "agentcommercekit"
import type { AgentIdentity } from "@paywall/protocol"

/** A fixture identity together with the private JWK it was built from. */
export interface FixtureIdentity extends AgentIdentity {
  jwk: PrivateKeyJwk
}

/**
 * Derives a test-only private key from a label. The bytes are the label
 * padded to 32 characters, so fixture keys are reproducible and obviously not
 * secret.
 */
function seed(label: string): Uint8Array {
  const text = `paywall-test-fixture:${label}`.padEnd(32, ".").slice(0, 32)
  return new TextEncoder().encode(text)
}

/** Builds an identity from a private JWK the same way the server does. */
export function identityFromPrivateJwk(jwk: PrivateKeyJwk): FixtureIdentity {
  const keypair = jwkToKeypair(jwk)
  return { did: createDidKeyUri(keypair), signer: createJwtSigner(keypair), alg: curveToJwtAlgorithm(keypair.curve), jwk }
}

/** A deterministic identity on `curve` for `label`. */
export function fixtureIdentity(label: string, curve: KeyCurve = "Ed25519"): FixtureIdentity {
  return identityFromPrivateJwk(privateKeyBytesToJwk(seed(label), curve))
}

/**
 * The fixture identities: the two server agents, the payment service, the
 * client agent and an issuer nobody trusts. The payment service uses
 * secp256k1 so receipts exercise a second curve; the rest are Ed25519.
 */
export const fixtures = {
  acme: fixtureIdentity("acme"),
  globex: fixtureIdentity("globex"),
  paymentService: fixtureIdentity("payment-service", "secp256k1"),
  client: fixtureIdentity("client"),
  untrusted: fixtureIdentity("untrusted"),
} as const

/** A DID resolver for `did:key`, which needs no network. */
export function fixtureResolver(): Resolvable {
  return getDidResolver()
}
