import { render, screen, waitFor, within } from "@testing-library/react"
import { getDidResolver } from "agentcommercekit"
import { expect } from "vitest"
import { BASE_URL, fixtures, useFixedTime } from "@paywall/testkit"
import type { PaymentExecutor } from "../../src/agent/index.ts"
import { App } from "../../src/ui/App.tsx"
import { FakePaywall } from "../support/fake-paywall.ts"

/**
 * Renders the page against a {@link FakePaywall} on a fixed clock. The page
 * contract the tests rely on: regions named "Catalog" and "Agent run"; in the
 * agent run a `status` live region, a list named
 * "Timeline", a region named "Payment request" with a list named "Payment
 * options" (the selected option's item has `aria-current="true"`), a region
 * named "Receipt", and a Reset button.
 */
export function renderApp(options: { executors?: (paywall: FakePaywall) => PaymentExecutor[]; fakeTimers?: boolean; approvalPoll?: { intervalMs: number; timeoutMs: number } } = {}) {
  const clock = useFixedTime(undefined, { fakeTimers: options.fakeTimers ?? false })
  const paywall = new FakePaywall(clock)
  const view = render(
    <App
      apiBaseUrl={BASE_URL}
      fetch={paywall.fetch}
      identity={fixtures.client}
      resolver={getDidResolver()}
      clock={clock}
      {...(options.executors ? { executors: options.executors(paywall) } : {})}
      {...(options.approvalPoll ? { approvalPoll: options.approvalPoll } : {})}
    />,
  )
  const catalog = () => screen.getByRole("region", { name: "Catalog" })
  const run = () => screen.getByRole("region", { name: "Agent run" })
  const status = () => within(run()).getByRole("status")
  return { clock, paywall, view, catalog, run, status }
}

/** The catalog item for a resource title. */
export async function catalogItem(catalog: HTMLElement, title: string): Promise<HTMLElement> {
  await within(catalog).findByText(title)
  const item = within(catalog)
    .getAllByRole("listitem")
    .find((li) => within(li).queryByText(title) !== null)
  if (!item) throw new Error(`no catalog item for ${title}`)
  return item
}

/** Waits until the status live region shows `text`. */
export async function waitForStatus(status: () => HTMLElement, text: RegExp): Promise<void> {
  await waitFor(() => expect(status()).toHaveTextContent(text), { timeout: 4000 })
}
