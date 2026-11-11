import * as v from "valibot"
import { paymentViewSchema } from "@paywall/protocol"
import type { PaymentExecutor } from "./types.ts"

/**
 * Creates the executor for the sandbox network: it asks the payment service
 * to settle the payment in its sandbox ledger. Throws when that call fails.
 */
export function createSandboxExecutor(): PaymentExecutor {
  return {
    network: "sandbox",
    async execute({ payment, next, paymentServiceUrl, fetch, signal }) {
      if (next.type !== "sandbox_settle") throw new Error(`the sandbox executor cannot handle ${next.type}`)
      const response = await fetch(`${paymentServiceUrl}/payments/${encodeURIComponent(payment.paymentId)}/sandbox/settle`, {
        method: "POST",
        signal,
      })
      if (response.status !== 200) throw new Error(`the sandbox settle call answered ${response.status}`)
      const view = v.safeParse(paymentViewSchema, await response.json())
      if (!view.success || view.output.paymentId !== payment.paymentId || view.output.status !== "settled") {
        throw new Error("the sandbox settle call did not settle the payment")
      }
    },
  }
}
