import type { Actor, Clock, EventLog, EventName, ProtocolEvent } from "@paywall/protocol"

/** An event log that keeps every event in memory, in emission order, stamped from `clock`. */
export class MemoryEventLog implements EventLog {
  readonly events: ProtocolEvent[] = []
  readonly #clock: Clock

  constructor(clock: Clock) {
    this.#clock = clock
  }

  emit(event: Omit<ProtocolEvent, "at">): void {
    this.events.push({ ...event, at: this.#clock.now().toISOString() })
  }

  /** The names of the events so far, optionally only those whose name starts with `prefix` (such as `"ps."`). */
  names(prefix?: string): EventName[] {
    return this.events.filter((e) => prefix === undefined || e.name.startsWith(prefix)).map((e) => e.name)
  }

  /** The events of one actor. */
  byActor(actor: Actor): ProtocolEvent[] {
    return this.events.filter((e) => e.actor === actor)
  }

  /** Every event with this name. */
  all(name: EventName): ProtocolEvent[] {
    return this.events.filter((e) => e.name === name)
  }

  /** The only event with this name; throws when there is not exactly one. */
  one(name: EventName): ProtocolEvent {
    const found = this.all(name)
    if (found.length !== 1) throw new Error(`expected exactly one ${name} event, found ${found.length}`)
    return found[0] as ProtocolEvent
  }

  clear(): void {
    this.events.length = 0
  }
}

/** Fans every event out to several logs, so client and server can share one ordered log. */
export function teeEventLog(...logs: EventLog[]): EventLog {
  return { emit: (event) => logs.forEach((log) => log.emit(event)) }
}

/** Every string found anywhere in the events, for leak checks. */
export function eventStrings(events: readonly ProtocolEvent[]): string[] {
  return events.flatMap((e) => [e.paymentRequestId, e.paymentId, ...Object.values(e.data ?? {})].filter((x): x is string => typeof x === "string"))
}

/** A compact JWT anywhere in a string: three base64url segments separated by dots. */
export const JWT_PATTERN = /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/
