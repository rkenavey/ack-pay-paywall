import type { ReactElement } from "react"
import { NotImplementedError } from "@paywall/protocol"

/** What the approver panel needs: the payment service URL and a `fetch`. */
export interface ApproverPanelProps {
  paymentServiceUrl: string
  fetch: typeof fetch
}

/**
 * The human approver's panel: a field for the approver token, the pending
 * approvals with payer, payee, amount and description, and Approve and Reject
 * buttons. The token stays in component state and is sent only as a bearer
 * token to the approver routes.
 */
export function ApproverPanel(props: ApproverPanelProps): ReactElement {
  void props
  throw new NotImplementedError("T6")
}
