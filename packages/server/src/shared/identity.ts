import type { PrivateKeyJwk } from "agentcommercekit"
import { NotImplementedError, type AgentIdentity } from "@paywall/protocol"

/**
 * Builds a signing identity from a private JWK: its `did:key` DID, a signer
 * and the JWT algorithm for its curve.
 *
 * Throws when the value is not a private JWK of a supported curve.
 */
export function identityFromJwk(jwk: PrivateKeyJwk): AgentIdentity {
  void jwk
  throw new NotImplementedError("T3")
}
