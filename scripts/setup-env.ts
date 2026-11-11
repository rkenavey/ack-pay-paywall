// `pnpm setup:env`: writes a .env with three fresh private JWKs, the Acme DID
// on the allowlist and a random approver token, leaving the Stripe lines blank.
import { NotImplementedError } from "@paywall/protocol"

/** Writes the `.env` file. Refuses to overwrite an existing one. */
export async function setupEnv(): Promise<void> {
  throw new NotImplementedError("T3")
}

if (import.meta.main) {
  await setupEnv()
}
