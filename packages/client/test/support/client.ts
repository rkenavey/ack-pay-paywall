import { getDidResolver } from "agentcommercekit"
import type { Network } from "@paywall/protocol"
import { fixtures, MemoryEventLog, useFixedTime } from "@paywall/testkit"
import {
  createPaywallClient,
  createSandboxExecutor,
  defaultSelectOption,
  type FlowState,
  type FlowStatus,
  type OptionSelector,
  type PaymentExecutor,
  type PaywallClient,
} from "../../src/agent/index.ts"
import { FakePaywall } from "./fake-paywall.ts"

/** An executor for a network that records its calls and does nothing else. */
export function recordingExecutor(network: Network, onExecute?: () => void | Promise<void>) {
  const calls: Array<Parameters<PaymentExecutor["execute"]>[0]> = []
  const executor: PaymentExecutor = {
    network,
    async execute(ctx) {
      calls.push(ctx)
      await onExecute?.()
    },
  }
  return { executor, calls }
}

/** A client agent wired to a {@link FakePaywall} on a fixed clock. */
export function setupClient(
  options: {
    executors?: (paywall: FakePaywall) => PaymentExecutor[]
    selectOption?: OptionSelector
    approvalPoll?: { intervalMs: number; timeoutMs: number }
    fakeTimers?: boolean
  } = {},
) {
  const clock = useFixedTime(undefined, { fakeTimers: options.fakeTimers ?? false })
  const paywall = new FakePaywall(clock)
  const log = new MemoryEventLog(clock)
  const client = createPaywallClient({
    fetch: paywall.fetch,
    identity: fixtures.client,
    executors: options.executors ? options.executors(paywall) : [createSandboxExecutor()],
    selectOption: options.selectOption ?? defaultSelectOption,
    resolver: getDidResolver(),
    clock,
    log,
    approvalPoll: options.approvalPoll ?? { intervalMs: 1000, timeoutMs: 300_000 },
  })
  const states: FlowState[] = []
  client.subscribe((state) => states.push(structuredClone(state)))

  /** The statuses observed so far, with consecutive repeats collapsed. */
  const statuses = (): FlowStatus[] =>
    states.map((s) => s.status).filter((status, i, all) => i === 0 || all[i - 1] !== status)

  return { clock, paywall, log, client, states, statuses }
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
