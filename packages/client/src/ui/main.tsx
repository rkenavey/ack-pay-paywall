import { getDidResolver } from "agentcommercekit"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { systemClock } from "@paywall/protocol"
import { createSandboxExecutor } from "../agent/index.ts"
import { createStripeCheckout, StripePaymentForm } from "../stripe/index.tsx"
import { App } from "./App.tsx"
import "./styles.css"
import { loadBrowserIdentity } from "./identity.ts"

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8787"
const root = document.getElementById("root")
if (!root) throw new Error("missing #root element")

const identity = await loadBrowserIdentity(window.localStorage)
// The agent pays with Stripe only when a payment request offers a Stripe option.
const stripeCheckout = createStripeCheckout({ returnUrl: window.location.href })
const executors = [createSandboxExecutor(), stripeCheckout.executor]
createRoot(root).render(
  <StrictMode>
    <App
      apiBaseUrl={apiBaseUrl}
      fetch={window.fetch.bind(window)}
      identity={identity}
      resolver={getDidResolver()}
      clock={systemClock}
      executors={executors}
      paymentPanel={<StripePaymentForm checkout={stripeCheckout} />}
    />
  </StrictMode>,
)
