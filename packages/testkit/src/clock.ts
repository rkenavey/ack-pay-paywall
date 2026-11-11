import { vi } from "vitest"
import type { Clock, IdGenerator } from "@paywall/protocol"

/** The instant every test starts at unless it says otherwise. */
export const FIXED_START = new Date("2026-11-10T14:02:00.000Z")

/**
 * A clock that stands still until a test moves it.
 *
 * `onChange` listeners run after every `advance` or `set`; {@link useFixedTime}
 * uses one to keep the faked system time in step.
 */
export class FixedClock implements Clock {
  #now: number
  #listeners: Array<(now: Date) => void> = []

  constructor(start: Date | string = FIXED_START) {
    this.#now = new Date(start).getTime()
  }

  now(): Date {
    return new Date(this.#now)
  }

  /** Moves the clock forward by `ms` milliseconds. */
  advance(ms: number): void {
    this.set(new Date(this.#now + ms))
  }

  /** Moves the clock forward by `seconds` seconds. */
  advanceSeconds(seconds: number): void {
    this.advance(seconds * 1000)
  }

  set(at: Date | string): void {
    this.#now = new Date(at).getTime()
    for (const listener of this.#listeners) listener(this.now())
  }

  onChange(listener: (now: Date) => void): void {
    this.#listeners.push(listener)
  }
}

/**
 * Freezes the system clock with Vitest's fake `Date` and returns a
 * {@link FixedClock} that moves it.
 *
 * ACK reads the system time when it stamps and checks credentials and JWTs,
 * so tests freeze it at the same instant as the injected clock. Only `Date`
 * is faked unless `fakeTimers` is true, which also fakes `setTimeout`,
 * `clearTimeout`, `setInterval` and `clearInterval` for polling tests.
 * Call `vi.useRealTimers()` in `afterEach`.
 */
export function useFixedTime(start: Date | string = FIXED_START, options: { fakeTimers?: boolean } = {}): FixedClock {
  const clock = new FixedClock(start)
  vi.useFakeTimers({
    now: clock.now(),
    toFake: options.fakeTimers ? ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] : ["Date"],
  })
  clock.onChange((now) => vi.setSystemTime(now))
  return clock
}

/** Sequential, readable ids: `pr_0001`, `pr_0002`, `pay_0001`, with a counter per prefix. */
export class SequenceIds implements IdGenerator {
  #counters = new Map<string, number>()

  next(prefix: string): string {
    const n = (this.#counters.get(prefix) ?? 0) + 1
    this.#counters.set(prefix, n)
    return `${prefix}_${String(n).padStart(4, "0")}`
  }
}

/**
 * Lets `ms` milliseconds pass under {@link useFixedTime} with `fakeTimers`:
 * runs the timers that fall due, then moves the fixed clock to the same
 * instant as the faked system time.
 */
export async function elapse(clock: FixedClock, ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  const now = vi.getMockedSystemTime()
  if (now) clock.set(now)
}
