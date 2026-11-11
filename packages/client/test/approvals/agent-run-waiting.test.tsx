import { act, fireEvent, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { elapse, type FixedClock } from "@paywall/testkit"
import { catalogItem, renderApp } from "../ui/render-app.tsx"

afterEach(() => {
  vi.useRealTimers()
})

/**
 * Lets pending promises and I/O run, without moving the fake timers, until
 * `condition` holds. setImmediate is not faked, so request bodies still flow.
 */
async function until(condition: () => boolean, clock: FixedClock): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (condition()) return
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve))
      await elapse(clock, 0)
    })
  }
  throw new Error("condition not reached")
}

async function startReport() {
  const app = renderApp({ fakeTimers: true, approvalPoll: { intervalMs: 1000, timeoutMs: 300_000 } })
  await until(() => within(app.catalog()).queryByText("Annual report") !== null, app.clock)
  const item = await catalogItem(app.catalog(), "Annual report")
  fireEvent.click(within(item).getByRole("button", { name: /fetch/i }))
  await until(() => /awaiting_approval/i.test(app.status().textContent ?? ""), app.clock)
  return app
}

describe("agent run while a human decides", () => {
  it("UI-7: while the payment waits, the run says it is waiting for a human, then continues when approved", async () => {
    const { run, status, paywall, clock } = await startReport()
    expect(run()).toHaveTextContent(/waiting for (a )?human/i)
    expect(paywall.payment().status).toBe("pending_approval")

    // Still waiting after a few polls.
    await act(() => elapse(clock, 3000))
    expect(status()).toHaveTextContent(/awaiting_approval/i)

    paywall.approve()
    await act(() => elapse(clock, 1000))
    await until(() => /delivered/i.test(status().textContent ?? ""), clock)
    expect(run()).toHaveTextContent("The annual report content.")
    expect(run()).not.toHaveTextContent(/waiting for (a )?human/i)
  })

  it("UI-7: when the human rejects, the run fails with approval_rejected", async () => {
    const { run, status, paywall, clock } = await startReport()
    paywall.reject()
    await act(() => elapse(clock, 1000))
    await until(() => /failed/i.test(status().textContent ?? ""), clock)
    expect(run()).toHaveTextContent("approval_rejected")
    expect(run()).not.toHaveTextContent("The annual report content.")
  })
})
