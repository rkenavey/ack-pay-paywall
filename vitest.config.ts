import { defineConfig } from "vitest/config"

// Every offline test. `pnpm exec vitest run <directory>` narrows to one
// directory from the repository root. The live Stripe test has its own
// config (vitest.live.config.ts) and is never part of this run.
export default defineConfig({
  test: {
    passWithNoTests: false,
    restoreMocks: true,
    unstubGlobals: true,
    projects: [
      {
        test: {
          name: "protocol",
          environment: "node",
          include: ["packages/protocol/test/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "server",
          environment: "node",
          include: ["packages/server/test/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "client-agent",
          environment: "node",
          include: ["packages/client/test/agent/**/*.test.ts"],
        },
      },
      "packages/client/vitest.config.ts",
      {
        test: {
          name: "e2e",
          environment: "node",
          include: ["tests/e2e/**/*.test.ts"],
        },
      },
    ],
  },
})
