import type { CatalogEntry } from "../server-agent/index.ts"

/** The resources the Acme server agent sells at `/api`. */
export const ACME_CATALOG: readonly CatalogEntry[] = [
  {
    id: "market-brief",
    title: "Market brief",
    price: { amount: 500, decimals: 2, currency: "USD" },
    content:
      "Weekly market brief: agent-to-agent payment volume rose 12% week on week; most of it settled in under a second.",
  },
  {
    id: "annual-report",
    title: "Annual report",
    price: { amount: 7500, decimals: 2, currency: "USD" },
    content: "Acme annual report: revenue, costs and the outlook for the year ahead, in twelve pages.",
  },
]

/** The resources the Globex server agent sells at `/partner`. Globex is not on the default allowlist. */
export const GLOBEX_CATALOG: readonly CatalogEntry[] = [
  {
    id: "partner-feed",
    title: "Partner feed",
    price: { amount: 500, decimals: 2, currency: "USD" },
    content: "Globex partner feed: the latest partner announcements, refreshed hourly.",
  },
]
