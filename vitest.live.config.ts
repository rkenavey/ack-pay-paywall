import { existsSync, readFileSync } from "node:fs"
import { parseEnv } from "node:util"
import { defineConfig } from "vitest/config"

// The live Stripe test-mode check. Reads the STRIPE_* keys from .env and
// talks to the real Stripe API, so it is never part of `pnpm test`.
const dotenv = existsSync(".env") ? parseEnv(readFileSync(".env", "utf8")) : {}
const stripeEnv = Object.fromEntries(Object.entries(dotenv).filter(([key]) => key.startsWith("STRIPE_")))

export default defineConfig({
  test: {
    name: "stripe-live",
    environment: "node",
    include: ["tests/stripe-live/**/*.test.ts"],
    passWithNoTests: false,
    testTimeout: 60_000,
    env: stripeEnv,
  },
})
