import react from "@vitejs/plugin-react"
import { defineProject } from "vitest/config"

// The React tests: the page, the Stripe Payment Element executor and the
// approver panel, rendered in jsdom.
export default defineProject({
  plugins: [react()],
  test: {
    name: "client-ui",
    environment: "jsdom",
    include: ["test/{ui,stripe,approvals}/**/*.test.{ts,tsx}"],
    setupFiles: ["test/setup-dom.ts"],
  },
})
