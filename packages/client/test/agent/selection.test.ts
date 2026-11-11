import { afterEach, describe, expect, it, vi } from "vitest"
import { paymentOption } from "@paywall/testkit"
import { createSandboxExecutor, defaultSelectOption, type OptionSelector } from "../../src/agent/index.ts"
import { resourceUrl } from "../support/fake-paywall.ts"
import { recordingExecutor, setupClient } from "../support/client.ts"

afterEach(() => {
  vi.useRealTimers()
})

const stripe = paymentOption({ network: "stripe" })
const sandbox = paymentOption({ network: "sandbox" })
const lightning = paymentOption({ network: "lightning" })

describe("option selection", () => {
  it("CL-5: the default prefers stripe over sandbox among networks with an executor, whatever the option order", () => {
    expect(defaultSelectOption([sandbox, stripe], ["sandbox", "stripe"])).toEqual(stripe)
    expect(defaultSelectOption([stripe, sandbox], ["stripe", "sandbox"])).toEqual(stripe)
    expect(defaultSelectOption([stripe, sandbox], ["sandbox"])).toEqual(sandbox)
    expect(defaultSelectOption([lightning, sandbox], ["sandbox", "stripe"])).toEqual(sandbox)
    expect(defaultSelectOption([stripe], ["sandbox"])).toBeUndefined()
    expect(defaultSelectOption([lightning], ["sandbox", "stripe"])).toBeUndefined()
    expect(defaultSelectOption([sandbox, stripe], [])).toBeUndefined()
  })

  it("CL-5: selection is deterministic", () => {
    const options = [sandbox, lightning, stripe]
    const first = defaultSelectOption(options, ["sandbox", "stripe"])
    for (let i = 0; i < 10; i += 1) expect(defaultSelectOption(structuredClone(options), ["stripe", "sandbox"])).toEqual(first)
  })

  it("CL-5: the client selects among the networks it has executors for, preferring stripe", async () => {
    let stripeCalls: ReturnType<typeof recordingExecutor>["calls"] = []
    const { client } = setupClient({
      executors: (fake) => {
        const recorded = recordingExecutor("stripe", () => fake.settleStripe(fake.payment().paymentId))
        stripeCalls = recorded.calls
        return [createSandboxExecutor(), recorded.executor]
      },
    })
    const state = await client.fetchPaid(resourceUrl("market-brief"))
    expect(state.status).toBe("delivered")
    expect(state.selectedOption?.id).toBe("stripe-usd")
    expect(stripeCalls).toHaveLength(1)
    expect(stripeCalls[0]?.next).toEqual(expect.objectContaining({ type: "stripe_payment_element" }))
    expect(stripeCalls[0]?.payment.paymentId).toBe("pay_0001")
    expect(stripeCalls[0]?.paymentServiceUrl).toBe(stripe.paymentService)
  })

  it("CL-5: with no executor for any offered network the run fails no_supported_option and pays nothing", async () => {
    const { client, paywall } = setupClient()
    paywall.networks = ["stripe"]
    const state = await client.fetchPaid(resourceUrl("market-brief"))
    expect(state.status).toBe("failed")
    expect(state.failure?.code).toBe("no_supported_option")
    expect(paywall.paymentServiceCalls()).toHaveLength(0)
  })

  it("CL-5: a custom selector receives the verified options and the supported networks", async () => {
    const seen: Array<[string[], string[]]> = []
    const pickSandbox: OptionSelector = (options, supported) => {
      seen.push([options.map((o) => o.id), [...supported]])
      return options.find((o) => o.network === "sandbox")
    }
    const { client } = setupClient({ selectOption: pickSandbox })
    const state = await client.fetchPaid(resourceUrl("market-brief"))
    expect(state.status).toBe("delivered")
    expect(state.selectedOption?.id).toBe("sandbox-usd")
    expect(seen).toEqual([[["stripe-usd", "sandbox-usd"], ["sandbox"]]])
  })
})
