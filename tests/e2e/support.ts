// Wires the real client agent core to the real server (buildApp) in one
// process, sharing one ordered event log.
import { getDidResolver } from "agentcommercekit"
import {
  createPaywallClient,
  createSandboxExecutor,
  defaultSelectOption,
  type FlowState,
  type FlowStatus,
  type PaymentExecutor,
  type PaywallClient,
} from "@paywall/client"
import { buildApp, parseConfig } from "@paywall/server"
import {
  BASE_URL,
  FakeStripeGateway,
  fixtureEnv,
  fixtures,
  fixtureStripeEnv,
  inProcessFetch,
  MemoryEventLog,
  SequenceIds,
  useFixedTime,
} from "@paywall/testkit"

/** The absolute URL of a path on the in-process server. */
export const resourceUrl = (path: string) => `${BASE_URL}${path}`

/**
 * The executor the browser's Payment Element stands for: it confirms the
 * PaymentIntent behind the client secret in the fake gateway.
 */
export function fakeStripeExecutor(gateway: FakeStripeGateway): PaymentExecutor {
  return {
    network: "stripe",
    async execute({ next }) {
      if (next.type !== "stripe_payment_element") throw new Error(`unexpected next action ${next.type}`)
      gateway.succeed(gateway.intentIdForClientSecret(next.clientSecret))
    },
  }
}

/** The real server (buildApp) and the real client agent core in one process, on a fixed clock, sharing one event log. */
export function setupSystem(options: { stripe?: boolean; fakeTimers?: boolean; executors?: (gateway: FakeStripeGateway) => PaymentExecutor[] } = {}) {
  const clock = useFixedTime(undefined, { fakeTimers: options.fakeTimers ?? false })
  const log = new MemoryEventLog(clock)
  const gateway = new FakeStripeGateway()
  const config = parseConfig(fixtureEnv(options.stripe ? fixtureStripeEnv : {}))
  const app = buildApp(config, { clock, ids: new SequenceIds(), log, stripeGateway: gateway })
  const fetch = inProcessFetch(app)
  const client = createPaywallClient({
    fetch,
    identity: fixtures.client,
    executors: options.executors ? options.executors(gateway) : [createSandboxExecutor()],
    selectOption: defaultSelectOption,
    resolver: getDidResolver(),
    clock,
    log,
    approvalPoll: { intervalMs: 1000, timeoutMs: 300_000 },
  })
  return { clock, log, gateway, config, app, fetch, client }
}

/** Resolves when the client reaches `status`. */
export function reach(client: PaywallClient, status: FlowStatus): Promise<FlowState> {
  return new Promise((resolve) => {
    const unsubscribe = client.subscribe((state) => {
      if (state.status === status) {
        unsubscribe()
        resolve(state)
      }
    })
  })
}

/** The full event sequence of a sandbox purchase that the policy allows. */
export const SANDBOX_HAPPY_PATH = [
  "client.request.sent",
  "server.request.received",
  "server.payment_required.issued",
  "client.payment_required.received",
  "client.payment_request.verified",
  "client.option.selected",
  "client.payment.initiated",
  "ps.payment.initiated",
  "ps.policy.evaluated",
  "ps.settlement.started",
  "client.payment.executing",
  "ps.settlement.confirmed",
  "ps.receipt.issued",
  "client.receipt.received",
  "client.receipt.verified",
  "client.request.retried",
  "server.request.received",
  "server.receipt.presented",
  "server.receipt.verified",
  "server.resource.delivered",
  "client.resource.received",
] as const
