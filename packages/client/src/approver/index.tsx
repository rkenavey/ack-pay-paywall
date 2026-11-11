import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactElement } from "react"
import * as v from "valibot"
import { approvalListBodySchema, errorBodySchema, formatMoney, type ApprovalView } from "@paywall/protocol"

/** What the approver panel needs: the payment service URL and a `fetch`. */
export interface ApproverPanelProps {
  paymentServiceUrl: string
  fetch: typeof fetch
  /** How often the loaded list refreshes itself, in milliseconds. Default 3000; 0 turns it off. */
  refreshMs?: number
}

const DEFAULT_REFRESH_MS = 3000

/** Reads an error body into one readable line, naming the HTTP status and code. */
async function describeError(response: Response): Promise<string> {
  let raw: unknown
  try {
    raw = await response.json()
  } catch {
    raw = undefined
  }
  const body = v.safeParse(errorBodySchema, raw)
  const reason = body.success ? `${body.output.error.code}: ${body.output.error.message}` : "the response could not be read"
  return response.status === 401 ? `HTTP 401 unauthorized: the approver token was refused (${reason})` : `HTTP ${response.status} ${reason}`
}

/**
 * The human approver's panel: a field for the approver token, the pending
 * approvals with payer, payee, amount and description, and Approve and Reject
 * buttons. The token stays in component state and is sent only as a bearer
 * token to the approver routes; it is never stored and never reaches the
 * client agent. Once loaded, the list refreshes every `refreshMs`.
 */
export function ApproverPanel(props: ApproverPanelProps): ReactElement {
  const { paymentServiceUrl, fetch: fetchFn } = props
  const refreshMs = props.refreshMs ?? DEFAULT_REFRESH_MS
  const [draft, setDraft] = useState("")
  const [token, setToken] = useState<string | undefined>()
  const [approvals, setApprovals] = useState<ApprovalView[] | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState<string | undefined>()
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const load = useCallback(
    async (bearer: string) => {
      try {
        const response = await fetchFn(`${paymentServiceUrl}/approvals?status=pending`, { headers: { Authorization: `Bearer ${bearer}` } })
        if (!mounted.current) return
        if (!response.ok) {
          setApprovals(undefined)
          if (response.status === 401) setToken(undefined)
          setError(await describeError(response))
          return
        }
        const body = v.safeParse(approvalListBodySchema, await response.json())
        if (!mounted.current) return
        if (!body.success) {
          setError("The approvals list could not be read.")
          return
        }
        setApprovals(body.output.approvals)
        setError(undefined)
      } catch (cause) {
        if (mounted.current) setError(`The payment service is unreachable: ${cause instanceof Error ? cause.message : String(cause)}`)
      }
    },
    [fetchFn, paymentServiceUrl],
  )

  useEffect(() => {
    if (token === undefined || refreshMs <= 0) return
    const timer = setInterval(() => void load(token), refreshMs)
    return () => clearInterval(timer)
  }, [token, refreshMs, load])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const bearer = draft.trim()
    if (!bearer) {
      setError("Enter the approver token.")
      return
    }
    setToken(bearer)
    void load(bearer)
  }

  const decide = async (approval: ApprovalView, decision: "approve" | "reject") => {
    if (token === undefined) return
    setBusy(approval.approvalId)
    try {
      const response = await fetchFn(`${paymentServiceUrl}/approvals/${encodeURIComponent(approval.approvalId)}/decision`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      })
      if (!mounted.current) return
      if (!response.ok) setError(await describeError(response))
      else setError(undefined)
      await load(token)
    } catch (cause) {
      if (mounted.current) setError(`The payment service is unreachable: ${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      if (mounted.current) setBusy(undefined)
    }
  }

  return (
    <section aria-labelledby="approver-heading" className="panel">
      <h2 id="approver-heading">Human approver</h2>
      <p>
        <small>
          Payments above the approval threshold wait here for a person holding the approver token. The token stays in this panel's memory
          and is sent only to the approver routes; the client agent never sees it.
        </small>
      </p>
      <form onSubmit={submit} className="approver-form">
        <label htmlFor="approver-token">Approver token</label>
        <input
          id="approver-token"
          type="password"
          autoComplete="off"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit">Load approvals</button>
        {token !== undefined && (
          <button type="button" onClick={() => void load(token)}>
            Refresh
          </button>
        )}
      </form>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {approvals && approvals.length === 0 && <p>No payments are waiting for approval.</p>}
      {approvals && approvals.length > 0 && (
        <ul className="approvals">
          {approvals.map((approval) => (
            <li key={approval.approvalId}>
              <dl>
                <dt>Amount</dt>
                <dd>{formatMoney(approval.amount)}</dd>
                <dt>Description</dt>
                <dd>{approval.description ?? "(none)"}</dd>
                <dt>Payer</dt>
                <dd>
                  <code>{approval.payer}</code>
                </dd>
                <dt>Payee</dt>
                <dd>
                  <code>{approval.payee}</code>
                </dd>
                <dt>Requested</dt>
                <dd>{approval.requestedAt}</dd>
              </dl>
              <button type="button" disabled={busy !== undefined} onClick={() => void decide(approval, "approve")}>
                Approve
              </button>
              <button type="button" disabled={busy !== undefined} onClick={() => void decide(approval, "reject")}>
                Reject
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
