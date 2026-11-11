import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react"
import type { Resolvable } from "agentcommercekit"
import * as v from "valibot"
import {
  EVENT_LABELS,
  formatMoney,
  moneyFromOption,
  resourceListBodySchema,
  type AgentIdentity,
  type Clock,
  type EventLog,
  type ProtocolEvent,
  type ResourceSummary,
} from "@paywall/protocol"
import {
  createPaywallClient,
  createSandboxExecutor,
  DEFAULT_APPROVAL_POLL,
  defaultSelectOption,
  type FlowState,
  type PaymentExecutor,
} from "../agent/index.ts"

/**
 * What the page needs. `apiBaseUrl` is the server origin; the page lists the
 * catalogs of the server agents at `/api` and `/partner` under it.
 * `executors` defaults to the sandbox executor. `paymentPanel` is shown in
 * the agent run while the agent pays over a network that needs the person at
 * the browser, such as the Stripe Payment Element.
 */
export interface AppProps {
  apiBaseUrl: string
  fetch: typeof fetch
  identity: AgentIdentity
  resolver: Resolvable
  clock: Clock
  executors?: readonly PaymentExecutor[]
  approvalPoll?: { intervalMs: number; timeoutMs: number }
  paymentPanel?: ReactNode
}

const SERVER_AGENTS = [
  { path: "api", name: "Acme" },
  { path: "partner", name: "Globex" },
] as const

interface CatalogItem extends ResourceSummary {
  agent: (typeof SERVER_AGENTS)[number]
  url: string
}

type CatalogState = { items: CatalogItem[]; errors: string[]; loading: boolean }

const IDLE: FlowState = { status: "idle" }

/** Loads both server agents' free catalogs. */
function useCatalog(apiBaseUrl: string, fetchFn: typeof fetch): CatalogState {
  const [catalog, setCatalog] = useState<CatalogState>({ items: [], errors: [], loading: true })
  useEffect(() => {
    const controller = new AbortController()
    void Promise.all(
      SERVER_AGENTS.map(async (agent) => {
        try {
          const response = await fetchFn(`${apiBaseUrl}/${agent.path}/resources`, { signal: controller.signal })
          const body = v.safeParse(resourceListBodySchema, await response.json())
          if (!response.ok || !body.success) return { items: [], error: `${agent.name}: the catalog could not be read (HTTP ${response.status}).` }
          const items = body.output.resources.map((r) => ({ ...r, agent, url: `${apiBaseUrl}/${agent.path}/resources/${encodeURIComponent(r.id)}` }))
          return { items, error: undefined }
        } catch (error) {
          return { items: [], error: `${agent.name}: ${error instanceof Error ? error.message : "unreachable"}` }
        }
      }),
    ).then((results) => {
      if (controller.signal.aborted) return
      setCatalog({
        items: results.flatMap((r) => r.items),
        errors: results.flatMap((r) => (r.error ? [r.error] : [])),
        loading: false,
      })
    })
    return () => controller.abort()
  }, [apiBaseUrl, fetchFn])
  return catalog
}

/** Writes an event to the browser console in one readable line plus the full event. */
function logToConsole(event: ProtocolEvent): void {
  const ids = [event.paymentRequestId && `pr=${event.paymentRequestId}`, event.paymentId && `pay=${event.paymentId}`].filter(Boolean).join(" ")
  console.info(`[paywall] ${event.at} ${event.actor} ${event.name} ${ids}`.trimEnd(), event)
}

/**
 * The client page: the catalog of both server agents and the agent run
 * (status, event timeline, decoded payment request and receipt, and the
 * delivered content or the failure).
 */
export function App(props: AppProps): ReactElement {
  const { apiBaseUrl, fetch: fetchFn, identity, resolver, clock } = props
  const catalog = useCatalog(apiBaseUrl, fetchFn)
  const defaultExecutors = useMemo(() => [createSandboxExecutor()], [])
  const executors = props.executors ?? defaultExecutors
  const approvalPoll = props.approvalPoll ?? DEFAULT_APPROVAL_POLL

  const [flow, setFlow] = useState<FlowState>(IDLE)
  const [events, setEvents] = useState<ProtocolEvent[]>([])
  const [target, setTarget] = useState<CatalogItem | undefined>()
  const run = useRef<{ id: number; controller: AbortController }>({ id: 0, controller: new AbortController() })

  const reset = useCallback(() => {
    run.current.controller.abort()
    run.current = { id: run.current.id + 1, controller: new AbortController() }
    setFlow(IDLE)
    setEvents([])
    setTarget(undefined)
  }, [])

  useEffect(() => () => run.current.controller.abort(), [])

  const start = useCallback(
    (item: CatalogItem) => {
      run.current.controller.abort()
      const id = run.current.id + 1
      const controller = new AbortController()
      run.current = { id, controller }
      const current = () => run.current.id === id
      setFlow(IDLE)
      setEvents([])
      setTarget(item)
      const log: EventLog = {
        emit(event) {
          const stamped: ProtocolEvent = { ...event, at: clock.now().toISOString() }
          logToConsole(stamped)
          if (current()) setEvents((previous) => [...previous, stamped])
        },
      }
      const client = createPaywallClient({
        fetch: fetchFn,
        identity,
        executors,
        selectOption: defaultSelectOption,
        resolver,
        clock,
        log,
        approvalPoll,
      })
      client.subscribe((state) => {
        if (current()) setFlow(state)
      })
      void client.fetchPaid(item.url, { signal: controller.signal })
    },
    [fetchFn, identity, executors, resolver, clock, approvalPoll],
  )

  const running = flow.status !== "idle" && flow.status !== "delivered" && flow.status !== "failed"

  return (
    <main className="page">
      <header className="masthead">
        <h1>ACK-Pay paywall client</h1>
        <p className="identity">
          Client agent <code>{identity.did}</code>
          <br />
          <small>Demo-grade key storage: this agent's private key is kept in this browser's localStorage, readable by any script on the page.</small>
        </p>
      </header>

      <section aria-labelledby="catalog-heading" className="panel">
        <h2 id="catalog-heading">Catalog</h2>
        {catalog.loading && <p>Loading catalogs…</p>}
        {catalog.errors.map((error) => (
          <p key={error} className="error">
            {error}
          </p>
        ))}
        <ul className="catalog">
          {catalog.items.map((item) => (
            <li key={item.url}>
              <span className="title">{item.title}</span>
              <span className="price">{formatMoney(item.price)}</span>
              <span className="agent">
                {item.agent.name} <code>/{item.agent.path}</code>
              </span>
              <button type="button" onClick={() => start(item)} disabled={running}>
                Fetch
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="run-heading" className="panel">
        <h2 id="run-heading">Agent run</h2>
        <p role="status" aria-live="polite" className={`status status-${flow.status}`}>
          Status: {flow.status}
          {flow.status === "awaiting_approval" && " (waiting for a human to approve the payment)"}
        </p>
        {target && (
          <p>
            Resource: <code>{target.url}</code>
          </p>
        )}
        <button type="button" onClick={reset}>
          Reset
        </button>

        <h3 id="timeline-heading">Timeline</h3>
        <ol aria-labelledby="timeline-heading" className="timeline">
          {events.map((event, i) => (
            <li key={i}>
              <time dateTime={event.at}>{event.at.slice(11, 23)}</time> <span className="label">{EVENT_LABELS[event.name]}</span>{" "}
              <code className="event-name">{event.name}</code>
            </li>
          ))}
        </ol>

        {flow.paymentRequired && <PaymentRequestView flow={flow} />}
        {flow.status === "paying" && flow.selectedOption?.network === "stripe" && props.paymentPanel}
        <ReceiptView events={events} />

        {flow.resource && (
          <section aria-labelledby="resource-heading" className="resource">
            <h3 id="resource-heading">{flow.resource.title}</h3>
            <p>{flow.resource.content}</p>
          </section>
        )}

        {flow.status === "failed" && flow.failure && (
          <div className="failure">
            <p>
              Failed: <code>{flow.failure.code}</code>. {flow.failure.message}
            </p>
            {flow.failure.details && Object.keys(flow.failure.details).length > 0 && (
              <dl>
                {Object.entries(flow.failure.details).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>
                      <code>{typeof value === "string" ? value : JSON.stringify(value)}</code>
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        )}
      </section>
    </main>
  )
}

/** The verified payment request: payee, description, amount and every option, with the selected one marked. */
function PaymentRequestView({ flow }: { flow: FlowState }): ReactElement | null {
  const request = flow.paymentRequired?.paymentRequest
  if (!request) return null
  const shown = flow.selectedOption ?? request.paymentOptions[0]
  const amount = shown ? moneyFromOption(shown) : undefined
  return (
    <section aria-labelledby="request-heading" className="decoded">
      <h3 id="request-heading">Payment request</h3>
      <dl>
        <dt>Payee</dt>
        <dd>
          <code>{flow.payee}</code>
        </dd>
        <dt>Description</dt>
        <dd>{request.description ?? "(none)"}</dd>
        <dt>Amount</dt>
        <dd>{amount ? formatMoney(amount) : "(not a whole number of minor units)"}</dd>
        <dt>Request id</dt>
        <dd>
          <code>{request.id}</code>
        </dd>
        <dt>Expires</dt>
        <dd>{request.expiresAt ?? "(never)"}</dd>
      </dl>
      <h4 id="options-heading">Payment options</h4>
      <ul aria-labelledby="options-heading">
        {request.paymentOptions.map((option) => {
          const selected = flow.selectedOption?.id === option.id
          const money = moneyFromOption(option)
          return (
            <li key={option.id} {...(selected ? { "aria-current": "true" as const } : {})} className={selected ? "selected" : undefined}>
              <code>{option.id}</code> on {option.network ?? "an unnamed network"}, {money ? formatMoney(money) : String(option.amount)}
              {selected && " (selected)"}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** The receipt as the agent verified it, from the `client.receipt.verified` event. */
function ReceiptView({ events }: { events: readonly ProtocolEvent[] }): ReactElement | null {
  const verified = events.find((event) => event.name === "client.receipt.verified")
  if (!verified?.data) return null
  const { issuer, payer, option, expires, receipt } = verified.data
  const tail = events.find((event) => event.name === "client.receipt.received")?.data?.receipt ?? receipt
  return (
    <section aria-labelledby="receipt-heading" className="decoded">
      <h3 id="receipt-heading">Receipt</h3>
      <dl>
        <dt>Issuer</dt>
        <dd>
          <code>{String(issuer)}</code>
        </dd>
        <dt>Payer</dt>
        <dd>
          <code>{String(payer)}</code>
        </dd>
        <dt>Option</dt>
        <dd>
          <code>{String(option)}</code>
        </dd>
        <dt>Expires</dt>
        <dd>{expires === null || expires === undefined ? "(never)" : String(expires)}</dd>
        {tail !== undefined && (
          <>
            <dt>Token</dt>
            <dd>
              <code>{String(tail)}</code>
            </dd>
          </>
        )}
      </dl>
    </section>
  )
}
