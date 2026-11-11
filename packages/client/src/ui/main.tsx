import { getDidResolver } from "agentcommercekit"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { systemClock } from "@paywall/protocol"
import { App } from "./App.tsx"
import "./styles.css"
import { loadBrowserIdentity } from "./identity.ts"

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8787"
const root = document.getElementById("root")
if (!root) throw new Error("missing #root element")

const identity = await loadBrowserIdentity(window.localStorage)
createRoot(root).render(
  <StrictMode>
    <App
      apiBaseUrl={apiBaseUrl}
      fetch={window.fetch.bind(window)}
      identity={identity}
      resolver={getDidResolver()}
      clock={systemClock}
    />
  </StrictMode>,
)
