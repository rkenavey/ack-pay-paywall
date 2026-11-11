import { NotImplementedError, type Clock, type EventLog } from "@paywall/protocol"

/** How the console sink writes events: one readable line each, or one JSON object each. */
export type LogFormat = "pretty" | "json"

/**
 * Creates the event sink that writes one line per protocol event.
 *
 * `pretty` lines read `time actor name key=value ...`; `json` lines are the
 * event as JSON. `write` receives each line without a trailing newline and
 * defaults to standard output.
 */
export function createConsoleEventLog(options: { format: LogFormat; clock: Clock; write?: (line: string) => void }): EventLog {
  void options
  throw new NotImplementedError("T3")
}
