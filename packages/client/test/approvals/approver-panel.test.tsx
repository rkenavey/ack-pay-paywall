import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ApprovalView } from "@paywall/protocol"
import { APPROVER_TOKEN, FetchStub, fixtures, json, PAYMENT_SERVICE_URL, useFixedTime } from "@paywall/testkit"
import { ApproverPanel } from "../../src/approver/index.tsx"

afterEach(() => {
  vi.useRealTimers()
})

/** A scripted approvals API that requires the approver token. */
function approvalsApi() {
  const stub = new FetchStub()
  const approvals: ApprovalView[] = [
    {
      approvalId: "apr_0001",
      paymentId: "pay_0001",
      status: "pending",
      payer: fixtures.client.did,
      payee: fixtures.acme.did,
      amount: { amount: 7500, decimals: 2, currency: "USD" },
      description: "Annual report",
      requestedAt: "2026-11-10T14:02:00.000Z",
    },
    {
      approvalId: "apr_0002",
      paymentId: "pay_0002",
      status: "pending",
      payer: fixtures.client.did,
      payee: fixtures.acme.did,
      amount: { amount: 12000, decimals: 2, currency: "USD" },
      description: "Board pack",
      requestedAt: "2026-11-10T14:02:00.000Z",
    },
  ]
  const authorized = (headers: Headers) => headers.get("authorization") === `Bearer ${APPROVER_TOKEN}`
  const unauthorized = () => json({ error: { code: "unauthorized", message: "approver token required" } }, 401)
  stub.on("GET", `${PAYMENT_SERVICE_URL}/approvals`, (request) =>
    authorized(request.headers) ? json({ approvals: approvals.filter((a) => a.status === "pending") }) : unauthorized(),
  )
  stub.on("POST", `${PAYMENT_SERVICE_URL}/approvals/:id/decision`, (request, { id }) => {
    if (!authorized(request.headers)) return unauthorized()
    const approval = approvals.find((a) => a.approvalId === id)
    if (!approval) return json({ error: { code: "approval_not_found", message: "no such approval" } }, 404)
    const { decision } = JSON.parse(request.body) as { decision: "approve" | "reject" }
    approval.status = decision === "approve" ? "approved" : "rejected"
    approval.decidedAt = "2026-11-10T14:03:00.000Z"
    return json(approval)
  })
  return { stub, approvals }
}

async function enterToken(token: string) {
  await userEvent.type(screen.getByLabelText(/approver token/i), token)
  await userEvent.click(screen.getByRole("button", { name: /load approvals/i }))
}

function region() {
  return screen.getByRole("region", { name: "Human approver" })
}

describe("approver panel", () => {
  it("UI-6: lists pending approvals with payer, payee, amount and description once a token is entered", async () => {
    useFixedTime()
    const { stub } = approvalsApi()
    render(<ApproverPanel paymentServiceUrl={PAYMENT_SERVICE_URL} fetch={stub.fetch} />)
    expect(stub.requests).toHaveLength(0)
    await enterToken(APPROVER_TOKEN)

    const items = await within(region()).findAllByRole("listitem")
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent(fixtures.client.did)
    expect(items[0]).toHaveTextContent(fixtures.acme.did)
    expect(items[0]).toHaveTextContent("$75.00")
    expect(items[0]).toHaveTextContent("Annual report")
    expect(items[1]).toHaveTextContent("$120.00")
    const list = stub.requests.find((r) => r.path === "/payment-service/approvals")
    expect(list?.url).toContain("status=pending")
    expect(list?.headers.get("authorization")).toBe(`Bearer ${APPROVER_TOKEN}`)
  })

  it("UI-6: Approve and Reject call the decision route and the list updates", async () => {
    useFixedTime()
    const { stub } = approvalsApi()
    render(<ApproverPanel paymentServiceUrl={PAYMENT_SERVICE_URL} fetch={stub.fetch} />)
    await enterToken(APPROVER_TOKEN)

    const [first] = await within(region()).findAllByRole("listitem")
    await userEvent.click(within(first as HTMLElement).getByRole("button", { name: /approve/i }))
    await waitFor(() => expect(within(region()).getAllByRole("listitem")).toHaveLength(1))
    expect(within(region()).getByRole("listitem")).toHaveTextContent("Board pack")

    await userEvent.click(within(within(region()).getByRole("listitem")).getByRole("button", { name: /reject/i }))
    await waitFor(() => expect(within(region()).queryAllByRole("listitem")).toHaveLength(0))

    const decisions = stub.requests.filter((r) => r.path.endsWith("/decision"))
    expect(decisions.map((r) => [r.path, JSON.parse(r.body).decision])).toEqual([
      ["/payment-service/approvals/apr_0001/decision", "approve"],
      ["/payment-service/approvals/apr_0002/decision", "reject"],
    ])
    for (const r of decisions) {
      expect(r.method).toBe("POST")
      expect(r.headers.get("authorization")).toBe(`Bearer ${APPROVER_TOKEN}`)
      expect(r.headers.get("content-type")).toMatch(/application\/json/)
    }
  })

  it("UI-6: a 401 shows an error", async () => {
    useFixedTime()
    const { stub } = approvalsApi()
    render(<ApproverPanel paymentServiceUrl={PAYMENT_SERVICE_URL} fetch={stub.fetch} />)
    await enterToken("not-the-approver-token-000000")
    const alert = await within(region()).findByRole("alert")
    expect(alert).toHaveTextContent(/unauthorized|401|token/i)
    expect(within(region()).queryAllByRole("listitem")).toHaveLength(0)
  })

  it("UI-6: the token stays in the page: it is not written to browser storage", async () => {
    useFixedTime()
    const { stub } = approvalsApi()
    const setItem = vi.spyOn(Storage.prototype, "setItem")
    render(<ApproverPanel paymentServiceUrl={PAYMENT_SERVICE_URL} fetch={stub.fetch} />)
    await enterToken(APPROVER_TOKEN)
    await within(region()).findAllByRole("listitem")
    expect(setItem.mock.calls.some((call) => call.some((arg) => String(arg).includes(APPROVER_TOKEN)))).toBe(false)
    expect(document.cookie).not.toContain(APPROVER_TOKEN)
  })
})
