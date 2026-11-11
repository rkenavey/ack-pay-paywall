// `pnpm setup:env`: writes a .env with three fresh private JWKs, the Acme DID
// on the allowlist and a random approver token, leaving the Stripe lines blank.
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { bytesToBase64url, createDidKeyUri, generateKeypair, keypairToJwk } from "agentcommercekit"

const ROOT = join(import.meta.dirname, "..")

/** Replaces the value of `name=` in a .env text, keeping every comment and other line. */
function setValue(text: string, name: string, value: string): string {
  const line = new RegExp(`^${name}=.*$`, "m")
  if (!line.test(text)) throw new Error(`.env.example has no ${name} line`)
  return text.replace(line, () => `${name}=${value}`)
}

/** Writes the `.env` file. Refuses to overwrite an existing one. */
export async function setupEnv(): Promise<void> {
  const target = join(ROOT, ".env")
  if (existsSync(target)) {
    process.stderr.write(".env already exists; not overwriting it. Delete it first to generate fresh keys.\n")
    process.exitCode = 1
    return
  }

  const [acme, globex, paymentService] = await Promise.all([
    generateKeypair("Ed25519"),
    generateKeypair("Ed25519"),
    generateKeypair("Ed25519"),
  ])
  const jwk = (keypair: typeof acme) => `'${JSON.stringify(keypairToJwk(keypair))}'`
  const approverToken = bytesToBase64url(crypto.getRandomValues(new Uint8Array(32)))

  let text = readFileSync(join(ROOT, ".env.example"), "utf8")
  text = setValue(text, "ACME_AGENT_JWK", jwk(acme))
  text = setValue(text, "GLOBEX_AGENT_JWK", jwk(globex))
  text = setValue(text, "PAYMENT_SERVICE_JWK", jwk(paymentService))
  text = setValue(text, "POLICY_ALLOWED_COUNTERPARTIES", createDidKeyUri(acme))
  text = setValue(text, "APPROVER_TOKEN", approverToken)
  writeFileSync(target, text, { mode: 0o600, flag: "wx" })

  // Only public values are printed; the keys and the approver token stay in the file.
  process.stdout.write(
    [
      "Wrote .env with fresh keys and an approver token (readable only by you).",
      `  Acme DID (on the allowlist): ${createDidKeyUri(acme)}`,
      `  Globex DID:                  ${createDidKeyUri(globex)}`,
      `  Payment service DID:         ${createDidKeyUri(paymentService)}`,
      "The Stripe lines are blank, so only the sandbox network is offered.",
      "",
    ].join("\n"),
  )
}

// `import.meta.main` needs Node 24.2; comparing paths works on Node 22 too.
const entry = process.argv[1]
if (entry !== undefined && realpathSync(entry) === import.meta.filename) {
  await setupEnv()
}
