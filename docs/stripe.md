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

Set both or neither. Restart the server; its startup notice lists `Networks: sandbox, stripe (test mode)`. The secret key stays on the server. The browser gets only the publishable key, inside the payment's next action, so the page needs no Stripe configuration of its own.

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
| `succeeded` but another amount, currency or payment id | `409 settlement_mismatch`; nothing is issued |

The settlement time in the receipt is when the payment service first saw the PaymentIntent succeeded.

## The webhook

Without a webhook the demo still works: the receipt route checks the PaymentIntent directly. To have Stripe tell the server as well, forward events with the [Stripe CLI](https://docs.stripe.com/stripe-cli):

```sh
stripe listen --forward-to localhost:8787/payment-service/webhooks/stripe
```

It prints a signing secret. Put it in `.env` as `STRIPE_WEBHOOK_SECRET=whsec_your_signing_secret` and restart the server.

`POST /payment-service/webhooks/stripe` reads the raw body and verifies the `Stripe-Signature` header with that secret (`400 webhook_signature_invalid` otherwise). It then:

- `payment_intent.succeeded`: retrieves the PaymentIntent and settles the payment it names, with the same checks as above;
- `payment_intent.payment_failed`: moves the payment to `failed`, unless Stripe now reports the PaymentIntent as succeeded;
- anything else: `200`, ignored.

Each event id is handled once; a redelivery answers `200` and changes nothing. With no secret configured the route answers `503 webhook_not_configured` and processes nothing.

With the webhook on, a declined card fails the payment, so trying again in the page does not lead to a receipt: see the last entry of [decisions.md](decisions.md) on this.

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

It reads only the `STRIPE_*` variables from `.env` and fails when the keys are missing. Against the real test-mode API it begins a payment, checks the PaymentIntent Stripe created (amount, currency, automatic payment methods without redirects, metadata), checks that no receipt is issued before confirmation, confirms the PaymentIntent with the test payment method `pm_card_visa` (standing in for the browser), then issues the receipt and verifies it with ACK:

```
$ pnpm test:stripe-live
 Test Files  1 passed (1)
      Tests  1 passed (1)
```

It creates a $5.00 test payment in your Stripe account each time it runs. The offline tests never talk to Stripe: the server tests use a fake gateway behind the `StripeGateway` interface, and the page tests mock Stripe.js (see [testing.md](testing.md)).
