import { realpathSync } from "node:fs"
import { serve } from "@hono/node-server"
import { buildApp } from "./app.ts"
import { parseConfig } from "./shared/config.ts"
import { identityFromJwk } from "./shared/identity.ts"

/**
 * The process entry point: reads the configuration from the environment,
 * builds the app and serves it on `PORT`. Stops the process with a message
 * naming the variable when the configuration is invalid.
 *
 * Protocol events go to standard output; the startup and shutdown notices go
 * to standard error, so `LOG_FORMAT=json` output stays one event per line.
 */
export async function main(env: Record<string, string | undefined>): Promise<void> {
  let config
  try {
    config = parseConfig(env)
  } catch (error) {
    process.stderr.write(`Configuration error: ${error instanceof Error ? error.message : "invalid configuration"}\n`)
    process.exit(1)
  }

  const app = buildApp(config)
  const notice = (line: string) => process.stderr.write(`${line}\n`)
  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    notice(`Paywall server listening on port ${info.port}, public URL ${config.publicBaseUrl}`)
    notice(`  Acme server agent      ${config.publicBaseUrl}/api      ${identityFromJwk(config.acmeAgentJwk).did}`)
    notice(`  Globex server agent    ${config.publicBaseUrl}/partner  ${identityFromJwk(config.globexAgentJwk).did}`)
    notice(`  Payment service        ${config.publicBaseUrl}/payment-service  ${identityFromJwk(config.paymentServiceJwk).did}`)
    notice(`  Networks: ${config.sandboxNetwork ? "sandbox" : "none"}; CORS origin ${config.clientOrigin}`)
    if (config.stripe) notice("  Stripe keys are set, but this build offers no Stripe option yet.")
  })

  const stop = () => {
    notice("Shutting down")
    server.close(() => process.exit(0))
  }
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
}

// `import.meta.main` needs Node 24.2; comparing paths works on Node 22 too.
const entry = process.argv[1]
if (entry !== undefined && realpathSync(entry) === import.meta.filename) {
  await main(process.env)
}
