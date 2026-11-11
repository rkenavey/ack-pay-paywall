import { NotImplementedError, type AgentIdentity } from "@paywall/protocol"

/** The storage key under which the browser keeps the client agent's private JWK. */
export const IDENTITY_STORAGE_KEY = "paywall.client-agent.jwk"

/**
 * Loads the client agent's Ed25519 `did:key` identity from `storage`, or
 * generates one and stores its private JWK there on first use.
 *
 * Demo-grade: the private key sits in plain `localStorage`, readable by any
 * script on the page.
 */
export async function loadBrowserIdentity(storage: Pick<Storage, "getItem" | "setItem">): Promise<AgentIdentity> {
  void storage
  throw new NotImplementedError("T4")
}
