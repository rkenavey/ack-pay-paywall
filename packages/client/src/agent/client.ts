import { NotImplementedError } from "@paywall/protocol"
import type { PaywallClient, PaywallClientDeps } from "./types.ts"

/**
 * Creates the client agent. On a 402 it verifies the payment request token,
 * selects an option, sends a signed initiation to the option's payment
 * service, waits for a human when asked to, runs the executor for the
 * network, verifies the receipt and retries the request once with it.
 */
export function createPaywallClient(deps: PaywallClientDeps): PaywallClient {
  void deps
  throw new NotImplementedError("T4")
}
