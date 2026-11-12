# Human approval

A payment above the approval threshold ($50.00 by default, see [policy.md](policy.md)) does not move money until a person decides. The payment service holds it as `pending_approval`, the client agent waits, and the human approver approves or rejects it.

## Who the approver is

The approver is whoever holds `APPROVER_TOKEN`, a random string of at least 24 characters that `pnpm setup:env` writes to `.env`. It is a bearer token, compared in constant time, and nothing else authorizes a decision: the client agent's DID, a JWT it signs, or any other header all answer `401`.

The client agent never has the token. The page has a separate *Human approver* panel where a person pastes it; the panel keeps it in component memory only, sends it only to the approver routes, and forgets it on reload. It is never written to browser storage, a cookie, the console or the event log.

A payment to a payee that is not on the allowlist is refused before it ever reaches the approver: deny beats approval.

## The routes

Both are under `/payment-service` and need `Authorization: Bearer <APPROVER_TOKEN>`.

| Route | Answers |
| :- | :- |
| `GET /approvals?status=pending` | `200 { "approvals": ApprovalView[] }`, oldest first. `status` may also be `approved` or `rejected`, or left out for all. `400 invalid_request` for another status. `401 unauthorized`. |
| `POST /approvals/:id/decision` | Body `{ "decision": "approve" \| "reject", "note"?: string }`. `200 ApprovalView`. `400 invalid_request` for another body. `401 unauthorized`. `404 approval_not_found`. `409 approval_already_decided`. `410 payment_request_expired`. |

From a real run, with the token in `$TOKEN` (ids and DIDs shortened):

```
$ curl -si 'http://localhost:8787/payment-service/approvals?status=pending'
HTTP/1.1 401 Unauthorized
www-authenticate: Bearer realm="approver"
{"error":{"code":"unauthorized","message":"The approver token is missing or wrong."}}

$ curl -s -H "Authorization: Bearer $TOKEN" 'http://localhost:8787/payment-service/approvals?status=approved'
{"approvals":[{"approvalId":"apr_c5763c87…","paymentId":"pay_d55c8b41…","status":"approved",
 "payer":"did:key:z6MkkxisqX…","payee":"did:key:z6MkuJMwxR…",
 "amount":{"amount":7500,"decimals":2,"currency":"USD"},"description":"Annual report",
 "requestedAt":"2026-11-11T19:23:02.372Z","decidedAt":"2026-11-11T19:23:02.508Z"}]}

$ curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d '{"decision":"approve"}' http://localhost:8787/payment-service/approvals/apr_unknown/decision
{"error":{"code":"approval_not_found","message":"No such approval."}}
```

## The panel

1. Fetch *Annual report* ($75.00) in the catalog. The agent run stops at `awaiting_approval (waiting for a human to approve the payment)`.
2. In *Human approver*, paste the token into *Approver token* and press *Load approvals*. A wrong token shows the `401` in a red alert and lists nothing.
3. Each pending payment shows its amount, description, payer DID, payee DID and when it was requested, with *Approve* and *Reject* buttons. The list refreshes every three seconds; *Refresh* reloads it at once.
4. Press a button. The panel posts the decision, reloads the list, and the agent run continues within a second, when its next poll sees the new status.

## What happens on each decision

| Decision | Payment | Events | The client |
| :- | :- | :- | :- |
| Approve | `pending_approval` to `requires_payment`, with `next` set. The settlement adapter's `begin` runs exactly once, before the status changes, so the payment is never payable without its next action. If `begin` fails (Stripe could not create the PaymentIntent), the payment moves straight to `failed` and the decision stays recorded; see [stripe.md](stripe.md#when-a-payment-fails). | `ps.approval.decided` (actor `human`, `decision=approve`), then `ps.settlement.started`; or `ps.settlement.failed` with `reason=failed` | pays, fetches the receipt and retries: `delivered`; or fails `payment_failed` on its next poll |
| Reject | `pending_approval` to `rejected`. No adapter is called; the settle and receipt routes answer `409`. | `ps.approval.decided` (`decision=reject`) | fails `approval_rejected` |
| Request expired | `failed`, and the decision answers `410 payment_request_expired`. Listing approvals also fails a waiting payment whose request has expired and leaves it out. | `ps.settlement.failed` with `reason=expired` | fails `payment_failed` on its next poll |

A decision is final. A second decision on the same approval, or a concurrent one that lost the race, answers `409 approval_already_decided` and changes nothing. Initiating the same payment again after a rejection returns the same rejected payment, so a rejected agent cannot ask twice.

In the server log the decision line is attributed to the human, because the person made it and the payment service only recorded it (ids shortened):

```
19:23:02.378 payment-service  ps.approval.requested           pr=pr_69cc311b… pay=pay_d55c8b41… approvalId=apr_c5763c87… amount=$75.00 threshold=$50.00
19:23:02.508 human            ps.approval.decided             pr=pr_69cc311b… pay=pay_d55c8b41… approvalId=apr_c5763c87… decision=approve outcome=approved noted=false
19:23:02.508 payment-service  ps.settlement.started           pr=pr_69cc311b… pay=pay_d55c8b41… network=sandbox next=sandbox_settle
```

`noted` says whether the approver left a note; the note itself is returned in the `ApprovalView` but not logged.
