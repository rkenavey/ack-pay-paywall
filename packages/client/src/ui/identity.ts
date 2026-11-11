import {
  createDidKeyUri,
  createJwtSigner,
  curveToJwtAlgorithm,
  generateKeypair,
  isPrivateKeyJwkEd25519,
  jwkToKeypair,
  keypairToJwk,
  type Keypair,
} from "agentcommercekit"
import type { AgentIdentity } from "@paywall/protocol"

/** The storage key under which the browser keeps the client agent's private JWK. */
export const IDENTITY_STORAGE_KEY = "paywall.client-agent.jwk"

function storedKeypair(raw: string | null): Keypair | undefined {
  if (raw === null) return undefined
  try {
    const jwk: unknown = JSON.parse(raw)
    return isPrivateKeyJwkEd25519(jwk) ? jwkToKeypair(jwk) : undefined
  } catch {
    return undefined
  }
}

/**
 * Loads the client agent's Ed25519 `did:key` identity from `storage`, or
 * generates one and stores its private JWK there on first use.
 *
 * Demo-grade: the private key sits in plain `localStorage`, readable by any
 * script on the page. A stored value that is not an Ed25519 private JWK is
 * replaced by a new key.
 */
export async function loadBrowserIdentity(storage: Pick<Storage, "getItem" | "setItem">): Promise<AgentIdentity> {
  let keypair = storedKeypair(storage.getItem(IDENTITY_STORAGE_KEY))
  if (!keypair) {
    keypair = await generateKeypair("Ed25519")
    storage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify(keypairToJwk(keypair)))
  }
  return { did: createDidKeyUri(keypair), signer: createJwtSigner(keypair), alg: curveToJwtAlgorithm(keypair.curve) }
}
