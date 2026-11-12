# Stripe test mode

With Stripe test-mode keys in `.env`, every payment request also offers a `stripe-usd` option, and the client agent prefers it over the sandbox. The payer pays with Stripe's Payment Element in the page; card data goes from the browser to Stripe and never touches this server. Only test-mode keys are accepted: a live key stops the server at startup.

## Getting keys

1. Sign in to the [Stripe Dashboard](https://dashboard.stripe.com) and switch to a sandbox or test mode.
2. Open **Developers → API keys**. Copy the publishable key (`pk_test_...`) and the secret key (`sk_test_...`). A restricted key (`rk_test_...`) with write access to PaymentIntents also works.
3. Put them in `.env`, and nowhere else:

```sh
STRIPE_SECRET_KEY=sk_test_your_secret_key
STRIPE_PUBLISHABLE_KEY=pk_test_your_publishable_key
```

Set both or neither. Restart the server; its startup notice lists the Stripe network and the webhook state:

```
  Networks: sandbox, stripe (test mode); CORS origin http://localhost:5173
  Stripe webhook: not configured (receipts verify the PaymentIntent directly)
```

The secret key stays on the server. The browser gets only the publishable key, inside the payment's next action, so the page needs no Stripe configuration of its own.

## What happens in a payment

1. The client agent initiates a payment for `stripe-usd`. After the spend policy allows it, the payment service creates one PaymentIntent for the amount and currency of the signed payment request, with automatic payment methods that never redirect, metadata `paymentId`, `paymentRequestId`, `paymentOptionId` and `payer`, and the idempotency key `pi:<paymentId>`. A repeated initiation returns the same payment and creates no second PaymentIntent.
2. The payment answers with `next: { type: "stripe_payment_element", clientSecret, publishableKey }`. The page loads Stripe.js once per publishable key, mounts the Payment Element under **Card payment (Stripe test mode)** in the agent run, and shows a Pay button.
3. Pay calls `stripe.confirmPayment` with `redirect: "if_required"`. Stripe shows a 3D Secure challenge itself when the card needs one. A decline shows Stripe's message under the element and the payer can try again on the same PaymentIntent. If Stripe reports the payment as `processing`, the page re-reads it every two seconds until it settles one way or the other.
4. Once Stripe.js reports `succeeded`, the agent asks the payment service for the receipt.

## What the server checks before it signs a receipt

The browser's word is never the evidence. When the receipt is requested, the payment service retrieves the PaymentIntent from Stripe and requires all of:

- `status` is `succeeded`;
- `amount` and `amount_received` both equal the amount of the signed payment request;
- the currency matches (compared case-insensitively: Stripe reports `usd`, the request says `USD`);
- `metadata.paymentId` is this payment's id.

| PaymentIntent | Receipt route |
| :- | :- |
| `succeeded` and matching | `200` with the receipt; `settlementRef` in its metadata is the PaymentIntent id |
| `requires_payment_method`, `requires_confirmation`, `requires_action`, `processing` | `409 payment_not_settled`; the payment stays payable |
| `canceled` | `409 payment_not_settled`; the payment moves to `failed` |
| not `succeeded`, and the payment request has expired | `409 payment_not_settled`; the PaymentIntent is cancelled, and the payment moves to `failed` once Stripe confirms the cancel |
| `succeeded` but another amount, currency or payment id | `409 settlement_mismatch`; nothing is issued |

The settlement time in the receipt is when the payment service first saw the PaymentIntent succeeded. A PaymentIntent that succeeded is honoured even when the payment request has expired since: the money has moved, so the receipt is issued.

## When a payment fails

A decline does not fail a payment: the payer can try again on the same PaymentIntent. A Stripe payment fails only when its PaymentIntent is `canceled`, or its payment request expires before the money arrives (noticed by the receipt route, the webhook, an approval decision or the approver's list). To fail it, the payment service first cancels the PaymentIntent, and the payment moves to `failed` only once Stripe confirms the cancel, so a failed payment can never take money later:

- if no PaymentIntent was created (the payment was still waiting for a human), there is nothing to cancel and the payment fails at once;
- if creating it threw, Stripe may have created it anyway, so the service repeats the create with the same idempotency key and cancels what comes back;
- if Stripe refuses because the PaymentIntent has succeeded, the money has moved: the payment is settled and the receipt is issued, even though the request has expired;
- if the cancel fails for any other reason, the payment stays in `requires_payment` (or `pending_approval`), `ps.settlement.failed` is logged with `reason=cancel_failed`, and the receipt route keeps answering `409 payment_not_settled`. The next time the payment is touched (the receipt route, the webhook, the approver's list or a decision) the service tries the cancel once more; reading the payment with `GET` does not count. Should the PaymentIntent succeed before that, the touch settles the payment instead.

Each touch makes at most one cancel attempt and logs at most one event, so a cancel Stripe keeps refusing is retried only as often as something asks about the payment. A payment whose settlement never started (no next action) while its cancel is outstanding answers `500 internal_error` rather than appear payable.

`ps.settlement.failed` carries one of these reasons:

| `reason` | Meaning | Payment afterwards |
| :- | :- | :- |
| `declined` | The webhook reported `payment_intent.payment_failed`. | `requires_payment`; the payer can try again |
| `cancel_failed` | Cancelling the PaymentIntent failed; `cause` is the reason the payment was being failed (`expired` or `failed`). It has no `cause` when the PaymentIntent belonged to a payment that had already failed or been rejected. | unchanged; retried on the next touch |
| `expired` | The payment request expired before the money arrived, and the cancel is confirmed. | `failed` |
| `failed` | The PaymentIntent was `canceled`, or settlement could not be started, and the cancel is confirmed. | `failed` |
| `mismatch` | The PaymentIntent succeeded for another amount, currency or payment id. | unchanged; no receipt is issued |

## The webhook

Without a webhook the demo still works: the receipt route checks the PaymentIntent directly. To have Stripe tell the server as well, forward events with the [Stripe CLI](https://docs.stripe.com/stripe-cli):

```sh
stripe listen --events payment_intent.succeeded,payment_intent.payment_failed --forward-to localhost:8787/payment-service/webhooks/stripe
```

Current versions of the CLI require `--events` (or `--all-snapshot` / `--all-thin`); without it `stripe listen` stops with "must specify events to forward".

It prints a signing secret. Put it in `.env` as `STRIPE_WEBHOOK_SECRET=whsec_your_signing_secret` and restart the server.

The signing secret `stripe listen` prints belongs to your CLI login and stays the same between runs, so it only needs copying once.

This has been run against this project, with `stripe listen` forwarding to the server and the page in Chrome; that run used port 8797 instead of 8787, which is why the output below shows it. Paying for `market-brief` with `4242 4242 4242 4242` delivered `payment_intent.succeeded`; paying with `4000 0000 0000 9995` showed "Your card has insufficient funds. Try a different card." under the element, and pressing Pay again with `4242 4242 4242 4242` on the same PaymentIntent delivered the resource. The CLI showed each event answered `200` (local times, event ids shortened):

```
19:47:56   --> payment_intent.succeeded [evt_…V0odjgVCS]
19:47:56  <--  [200] POST http://localhost:8797/payment-service/webhooks/stripe [evt_…V0odjgVCS]
19:48:46   --> payment_intent.payment_failed [evt_…V05iE8eSm]
19:48:47  <--  [200] POST http://localhost:8797/payment-service/webhooks/stripe [evt_…V05iE8eSm]
19:48:48   --> payment_intent.succeeded [evt_…V05cMxj5F]
19:48:48  <--  [200] POST http://localhost:8797/payment-service/webhooks/stripe [evt_…V05cMxj5F]
```

and the server log of the declined-then-retried payment (UTC, DIDs and ids shortened):

```
00:48:42.074 payment-service  ps.settlement.started    pr=pr_f906… pay=pay_5f1f… network=stripe next=stripe_payment_element
00:48:47.028 payment-service  ps.settlement.failed     pr=pr_f906… pay=pay_5f1f… network=stripe reason=declined paymentIntent=pi_3UamBxIGD5cnPg2V0i05hgFE
00:48:48.142 payment-service  ps.settlement.confirmed  pr=pr_f906… pay=pay_5f1f… network=stripe ref=pi_3UamBxIGD5cnPg2V0i05hgFE amount=$5.00 settledAt=2026-11-12T00:48:48.142Z
00:48:48.143 payment-service  ps.receipt.issued        pr=pr_f906… pay=pay_5f1f… option=stripe-usd expiresAt=2026-11-12T00:58:48.142Z receipt=…g1uw64Bw
00:48:48.161 server-agent     server.resource.delivered pr=pr_f906… resource=market-brief
```

The decline was logged and the payment stayed payable. The success webhook and the page's receipt request arrived within the same second; whichever came first settled the payment, and it was confirmed once.

`POST /payment-service/webhooks/stripe` reads the raw body and verifies the `Stripe-Signature` header with that secret (`400 webhook_signature_invalid` otherwise). It then:

- `payment_intent.succeeded`: retrieves the PaymentIntent and settles the payment it names, with the same checks as above;
- `payment_intent.payment_failed`: logs `ps.settlement.failed` with `reason=declined` and leaves the payment in `requires_payment`, so a retry on the same PaymentIntent still settles it, through this webhook or the receipt route. Nothing is logged when Stripe now reports the PaymentIntent as succeeded. For a payment whose cancel is outstanding it retries the cancel instead of logging a decline;
- anything else: `200`, ignored.

Each event id is handled once; a redelivery answers `200` and changes nothing. With no secret configured the route answers `503 webhook_not_configured` and processes nothing.

## Test cards

Any future expiry, any CVC and any postal code.

| Card | Result |
| :- | :- |
| `4242 4242 4242 4242` | Succeeds. |
| `4000 0025 0000 3155` | Asks for 3D Secure; choose **Complete** in Stripe's test page and it succeeds. |
| `4000 0000 0000 9995` | Declined ("Your card has insufficient funds. Try a different card."); the message shows under the element and Pay can be pressed again with another card. |

## The live test

```sh
pnpm test:stripe-live
```

It reads only the `STRIPE_*` variables from `.env` and fails when the keys are missing. Against the real test-mode API it begins a payment, checks the PaymentIntent Stripe created (amount, currency, automatic payment methods without redirects, metadata), checks that no receipt is issued before confirmation, confirms the PaymentIntent with the test payment method `pm_card_visa` (standing in for the browser), then issues the receipt and verifies it with ACK, and checks that the succeeded PaymentIntent cannot be cancelled. A second test creates a PaymentIntent, cancels it through the gateway, and cancels it again to show an already-canceled one is accepted:

```
$ pnpm test:stripe-live
 Test Files  1 passed (1)
      Tests  2 passed (2)
```

It creates a $5.00 test payment and a canceled PaymentIntent in your Stripe account each time it runs. The offline tests never talk to Stripe: the server tests use a fake gateway behind the `StripeGateway` interface, and the page tests mock Stripe.js (see [testing.md](testing.md)).
