import type { DidUri, JwtAlgorithm, JwtSigner } from "agentcommercekit"

/**
 * A signing identity: a `did:key` DID, the signer for its private key and the
 * JWT algorithm that key uses.
 *
 * Server identities are built from a private JWK; the browser generates its
 * own. The private key itself never leaves the signer.
 */
export interface AgentIdentity {
  did: DidUri
  signer: JwtSigner
  alg: JwtAlgorithm
}

/** The source of the current time. Everything protocol-relevant reads time from an injected clock. */
export interface Clock {
  now(): Date
}

/**
 * The source of identifiers. `next("pay")` returns a fresh id that starts
 * with `pay_`.
 */
export interface IdGenerator {
  next(prefix: string): string
}

/** The real clock. This and {@link randomIds} are the only places that read system time or randomness. */
export const systemClock: Clock = {
  now: () => new Date(),
}

/**
 * Random identifiers: the prefix, an underscore and 128 random bits as 32 hex
 * characters, from Web Crypto. Works in Node and in the browser.
 */
export const randomIds: IdGenerator = {
  next(prefix) {
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    let hex = ""
    for (const byte of bytes) hex += byte.toString(16).padStart(2, "0")
    return `${prefix}_${hex}`
  },
}

/**
 * Thrown by a stub whose behaviour has not been built yet. The argument names
 * the piece of work that will build it.
 */
export class NotImplementedError extends Error {
  constructor(task: string) {
    super(`not implemented yet (${task})`)
    this.name = "NotImplementedError"
  }
}
