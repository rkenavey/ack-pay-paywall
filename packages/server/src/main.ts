import { NotImplementedError } from "@paywall/protocol"

/**
 * The process entry point: reads the configuration from the environment,
 * builds the app and serves it on `PORT`. Stops the process with a message
 * naming the variable when the configuration is invalid.
 */
export async function main(env: Record<string, string | undefined>): Promise<void> {
  void env
  throw new NotImplementedError("T3")
}

if (import.meta.main) {
  await main(process.env)
}
