import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { EVENT_LABELS, type EventName } from "@paywall/protocol"
import { fixtures } from "@paywall/testkit"
import { FAKE_RESOURCES } from "../support/fake-paywall.ts"
import { catalogItem, renderApp, waitForStatus } from "./render-app.tsx"

afterEach(() => {
  vi.useRealTimers()
})

const CLIENT_EVENTS: EventName[] = [
  "client.request.sent",
  "client.payment_required.received",
  "client.payment_request.verified",
  "client.option.selected",
  "client.payment.initiated",
  "client.payment.executing",
  "client.receipt.received",
  "client.receipt.verified",
  "client.request.retried",
  "client.resource.received",
]

async function fetchResource(catalog: HTMLElement, title: string) {
  const item = await catalogItem(catalog, title)
  await userEvent.click(within(item).getByRole("button", { name: /fetch/i }))
}

describe("client page", () => {
  it("UI-1: the catalog lists the resources of both server agents with formatted prices", async () => {
    const { catalog, paywall } = renderApp()
    const brief = await catalogItem(catalog(), "Market brief")
    const report = await catalogItem(catalog(), "Annual report")
    const feed = await catalogItem(catalog(), "Partner feed")
    expect(brief).toHaveTextContent("$5.00")
    expect(report).toHaveTextContent("$75.00")
    expect(feed).toHaveTextContent("$5.00")
    expect(within(catalog()).getAllByRole("button", { name: /fetch/i })).toHaveLength(3)
    expect(paywall.stub.calls("GET", "/api/resources")).toHaveLength(1)
    expect(paywall.stub.calls("GET", "/partner/resources")).toHaveLength(1)
    expect(paywall.paymentServiceCalls()).toHaveLength(0)
  })

  it("UI-1: Fetch starts a run for that resource", async () => {
    const { catalog, status, paywall } = renderApp()
    await fetchResource(catalog(), "Market brief")
    await waitForStatus(status, /delivered/i)
    expect(paywall.resourceCalls("market-brief").length).toBeGreaterThanOrEqual(1)
  })

  it("UI-2: after a 402 the page shows the payee DID, the description, the amount and every option, with the selected one marked", async () => {
    const { catalog, run, status } = renderApp()
    await fetchResource(catalog(), "Market brief")
    await waitForStatus(status, /delivered/i)

    const request = within(run()).getByRole("region", { name: "Payment request" })
    expect(request).toHaveTextContent(fixtures.acme.did)
    expect(request).toHaveTextContent("Market brief")
    expect(request).toHaveTextContent("$5.00")
    const options = within(within(request).getByRole("list", { name: "Payment options" })).getAllByRole("listitem")
    expect(options).toHaveLength(2)
    const [stripeOption, sandboxOption] = options
    expect(stripeOption).toHaveTextContent("stripe-usd")
    expect(sandboxOption).toHaveTextContent("sandbox-usd")
    expect(sandboxOption).toHaveAttribute("aria-current", "true")
    expect(stripeOption).not.toHaveAttribute("aria-current", "true")
  })

  it("UI-3: the timeline shows one row per event, in order, with a readable label", async () => {
    const consoleSpies = [vi.spyOn(console, "log"), vi.spyOn(console, "info"), vi.spyOn(console, "debug")]
    for (const spy of consoleSpies) spy.mockImplementation(() => undefined)
    const { catalog, run, status } = renderApp()
    await fetchResource(catalog(), "Market brief")
    await waitForStatus(status, /delivered/i)

    const rows = within(within(run()).getByRole("list", { name: "Timeline" })).getAllByRole("listitem")
    expect(rows).toHaveLength(CLIENT_EVENTS.length)
    CLIENT_EVENTS.forEach((name, i) => {
      expect(rows[i]).toHaveTextContent(EVENT_LABELS[name])
    })

    // Every event is also written to the browser console.
    const logged = consoleSpies.flatMap((spy) => spy.mock.calls.map((args) => args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")))
    for (const name of CLIENT_EVENTS) expect(logged.some((line) => line.includes(name))).toBe(true)
  })

  it("UI-4: after delivery the page shows the receipt's issuer, payer, option and expiry, and the content", async () => {
    const { catalog, run, status } = renderApp()
    await fetchResource(catalog(), "Market brief")
    await waitForStatus(status, /delivered/i)

    const receipt = within(run()).getByRole("region", { name: "Receipt" })
    expect(receipt).toHaveTextContent(fixtures.paymentService.did)
    expect(receipt).toHaveTextContent(fixtures.client.did)
    expect(receipt).toHaveTextContent("sandbox-usd")
    expect(receipt).toHaveTextContent("2026-11-10T14:12:00.000Z")
    expect(run()).toHaveTextContent(FAKE_RESOURCES[0]?.content as string)
  })

  it("UI-5: a failed run shows the failure code and reason, and a control that resets the run", async () => {
    const { catalog, run, status } = renderApp()
    await fetchResource(catalog(), "Partner feed")
    await waitForStatus(status, /failed/i)

    expect(run()).toHaveTextContent("policy_denied")
    expect(run()).toHaveTextContent("counterparty_not_allowed")
    expect(run()).not.toHaveTextContent("The partner feed content.")

    await userEvent.click(within(run()).getByRole("button", { name: /reset/i }))
    await waitForStatus(status, /idle/i)
    expect(run()).not.toHaveTextContent("policy_denied")
    expect(within(run()).queryByRole("list", { name: "Timeline" })?.querySelectorAll("li").length ?? 0).toBe(0)
  })

  it("UI-5: status changes reach an aria-live region", async () => {
    const { catalog, status } = renderApp()
    const live = status()
    expect(live).toHaveAttribute("aria-live", "polite")
    expect(live).toHaveTextContent(/idle/i)
    await fetchResource(catalog(), "Market brief")
    await waitForStatus(status, /delivered/i)
    expect(status()).toBe(live)
    expect(screen.getAllByRole("status").length).toBeGreaterThanOrEqual(1)
  })
})
