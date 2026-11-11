import {
  createDidKeyUri,
  createJwtSigner,
  curveToJwtAlgorithm,
  isPrivateKeyJwk,
  jwkToKeypair,
  type PrivateKeyJwk,
} from "agentcommercekit"
import type { AgentIdentity } from "@paywall/protocol"

/**
 * Builds a signing identity from a private JWK: its `did:key` DID, a signer
 * and the JWT algorithm for its curve.
 *
 * Throws when the value is not a private JWK of a supported curve. The error
 * message never contains the key.
 */
export function identityFromJwk(jwk: PrivateKeyJwk): AgentIdentity {
  if (!isPrivateKeyJwk(jwk)) throw new Error("not a private JWK of a supported curve")
  let keypair
  try {
    keypair = jwkToKeypair(jwk)
  } catch {
    throw new Error("not a usable private JWK")
  }
  return { did: createDidKeyUri(keypair), signer: createJwtSigner(keypair), alg: curveToJwtAlgorithm(keypair.curve) }
}
