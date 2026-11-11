import type { ReactElement } from "react"
import type { Resolvable } from "agentcommercekit"
import { NotImplementedError, type AgentIdentity, type Clock } from "@paywall/protocol"
import type { PaymentExecutor } from "../agent/index.ts"

/**
 * What the page needs. `apiBaseUrl` is the server origin; the page lists the
 * catalogs of the server agents at `/api` and `/partner` under it.
 * `executors` defaults to the sandbox executor.
 */
export interface AppProps {
  apiBaseUrl: string
  fetch: typeof fetch
  identity: AgentIdentity
  resolver: Resolvable
  clock: Clock
  executors?: readonly PaymentExecutor[]
  approvalPoll?: { intervalMs: number; timeoutMs: number }
}

/**
 * The client page: the catalog of both server agents and the agent run
 * (status, event timeline, decoded payment request and receipt, and the
 * delivered content or the failure).
 */
export function App(props: AppProps): ReactElement {
  void props
  throw new NotImplementedError("T4")
}
