import type { Clock, EventLog, ProtocolEvent } from "@paywall/protocol"
import { tokenTail } from "@paywall/protocol"

/** How the console sink writes events: one readable line each, or one JSON object each. */
export type LogFormat = "pretty" | "json"

// Last line of defence: emitters already log tokens as tails, but anything
// shaped like a JWT or a Stripe secret is cut down here too.
const JWT_LIKE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
const SECRET_LIKE = /(^(sk|rk)_(test|live)_)|(^whsec_)|(_secret_)/

function redact(value: string | number | boolean | null | undefined): string | number | boolean | null | undefined {
  if (typeof value !== "string") return value
  if (SECRET_LIKE.test(value)) return "[redacted]"
  if (JWT_LIKE.test(value) && value.length > 40) return tokenTail(value)
  return value
}

function pretty(event: ProtocolEvent): string {
  const time = event.at.slice(11, 23)
  const fields: string[] = []
  if (event.paymentRequestId) fields.push(`pr=${event.paymentRequestId}`)
  if (event.paymentId) fields.push(`pay=${event.paymentId}`)
  for (const [key, value] of Object.entries(event.data ?? {})) {
    const text = value === null ? "null" : String(value)
    fields.push(`${key}=${/[\s"=]/.test(text) || text === "" ? JSON.stringify(text) : text}`)
  }
  return `${time} ${event.actor.padEnd(16)} ${event.name.padEnd(31)} ${fields.join(" ")}`.trimEnd()
}

/**
 * Creates the event sink that writes one line per protocol event.
 *
 * `pretty` lines read `time actor name key=value ...` with the UTC time of
 * day; `json` lines are the event as JSON. `write` receives each line without
 * a trailing newline and defaults to standard output. Values that look like
 * a JWT are shortened to their last 8 characters and values that look like a
 * Stripe secret are replaced, whatever the emitter passed.
 */
export function createConsoleEventLog(options: { format: LogFormat; clock: Clock; write?: (line: string) => void }): EventLog {
  const write = options.write ?? ((line: string) => void process.stdout.write(`${line}\n`))
  return {
    emit(event) {
      const data = event.data
        ? Object.fromEntries(Object.entries(event.data).map(([key, value]) => [key, redact(value)]))
        : undefined
      const stamped: ProtocolEvent = {
        name: event.name,
        actor: event.actor,
        at: options.clock.now().toISOString(),
        ...(event.paymentRequestId === undefined ? {} : { paymentRequestId: event.paymentRequestId }),
        ...(event.paymentId === undefined ? {} : { paymentId: event.paymentId }),
        ...(data === undefined ? {} : { data: data as ProtocolEvent["data"] }),
      }
      write(options.format === "json" ? JSON.stringify(stamped) : pretty(stamped))
    },
  }
}
