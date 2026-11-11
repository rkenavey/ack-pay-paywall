import * as v from "valibot"

/**
 * Every protocol event name, in the order the steps happen on a paid request
 * that needs approval, followed by the three failure events.
 *
 * The prefix names the role that emits it: `client.` the client agent,
 * `server.` a server agent, `ps.` the payment service.
 */
export const EVENT_NAMES = [
  "client.request.sent",
  "server.request.received",
  "server.payment_required.issued",
  "client.payment_required.received",
  "client.payment_request.verified",
  "client.option.selected",
  "client.payment.initiated",
  "ps.payment.initiated",
  "ps.policy.evaluated",
  "ps.approval.requested",
  "client.approval.waiting",
  "ps.approval.decided",
  "ps.settlement.started",
  "client.payment.executing",
  "ps.settlement.confirmed",
  "ps.receipt.issued",
  "client.receipt.received",
  "client.receipt.verified",
  "client.request.retried",
  "server.receipt.presented",
  "server.receipt.verified",
  "server.resource.delivered",
  "client.resource.received",
  "server.receipt.rejected",
  "ps.settlement.failed",
  "client.flow.failed",
] as const

/** The name of a protocol event. */
export type EventName = (typeof EVENT_NAMES)[number]

/** Who did the thing an event records. */
export type Actor = "client-agent" | "server-agent" | "payment-service" | "human"

/**
 * One step of the protocol, as written to the event log.
 *
 * `at` is an ISO 8601 timestamp from the injected clock. `data` holds only
 * scalars, and never a private key, a Stripe secret key, a client secret, the
 * approver token or a complete JWT; use {@link tokenTail} for tokens.
 */
export interface ProtocolEvent {
  name: EventName
  actor: Actor
  at: string
  paymentRequestId?: string
  paymentId?: string
  data?: Record<string, string | number | boolean | null>
}

/**
 * The sink every protocol step writes to. The sink stamps `at` from its own
 * clock, so emitters pass everything else.
 */
export interface EventLog {
  emit(event: Omit<ProtocolEvent, "at">): void
}

/** A short, readable label for each event, used by the timeline and the console log. */
export const EVENT_LABELS: Readonly<Record<EventName, string>> = {
  "client.request.sent": "Client requested the resource",
  "server.request.received": "Server received the request",
  "server.payment_required.issued": "Server answered 402 with a payment request",
  "client.payment_required.received": "Client received 402 Payment Required",
  "client.payment_request.verified": "Client verified the payment request token",
  "client.option.selected": "Client selected a payment option",
  "client.payment.initiated": "Client sent a signed payment initiation",
  "ps.payment.initiated": "Payment service received the initiation",
  "ps.policy.evaluated": "Payment service evaluated the spend policy",
  "ps.approval.requested": "Payment service asked a human to approve",
  "client.approval.waiting": "Client is waiting for a human approver",
  "ps.approval.decided": "A human decided on the payment",
  "ps.settlement.started": "Payment service started settlement",
  "client.payment.executing": "Client is paying",
  "ps.settlement.confirmed": "Payment service confirmed settlement",
  "ps.receipt.issued": "Payment service signed a receipt",
  "client.receipt.received": "Client received the receipt",
  "client.receipt.verified": "Client verified the receipt",
  "client.request.retried": "Client retried with the receipt",
  "server.receipt.presented": "Server received a receipt",
  "server.receipt.verified": "Server verified the receipt",
  "server.resource.delivered": "Server delivered the resource",
  "client.resource.received": "Client received the resource",
  "server.receipt.rejected": "Server rejected the receipt",
  "ps.settlement.failed": "Settlement failed",
  "client.flow.failed": "Client run failed",
}

/** Tells whether a string is one of {@link EVENT_NAMES}. */
export function isEventName(value: unknown): value is EventName {
  return typeof value === "string" && (EVENT_NAMES as readonly string[]).includes(value)
}

/** The actor that emits an event, derived from the event's prefix. */
export function actorOf(name: EventName): Actor {
  if (name.startsWith("client.")) return "client-agent"
  if (name.startsWith("server.")) return "server-agent"
  return "payment-service"
}

/**
 * The loggable form of a token: an ellipsis and its last 8 characters.
 *
 * Event data never carries a complete JWT; this is how a token is referred to.
 */
export function tokenTail(token: string): string {
  return `…${token.slice(-8)}`
}

/** Validates a {@link ProtocolEvent}, for sinks that receive events from elsewhere. */
export const protocolEventSchema = v.object({
  name: v.picklist(EVENT_NAMES),
  actor: v.picklist(["client-agent", "server-agent", "payment-service", "human"]),
  at: v.pipe(v.string(), v.isoTimestamp()),
  paymentRequestId: v.optional(v.string()),
  paymentId: v.optional(v.string()),
  data: v.optional(v.record(v.string(), v.union([v.string(), v.number(), v.boolean(), v.null()]))),
})
