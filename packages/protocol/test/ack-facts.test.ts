// Pins the agentcommercekit behaviour the paywall relies on, so an upgrade
// that changes any of it fails here first.
import {
  createJwt,
  createPaymentReceipt,
  createSignedPaymentRequest,
  CredentialExpiredError,
  getDidResolver,
  InvalidPaymentRequestTokenError,
  isDidKeyUri,
  jwkToKeypair,
  keypairToJwk,
  signCredential,
  UntrustedIssuerError,
  verifyJwt,
  verifyPaymentReceipt,
  verifyPaymentRequestToken,
  type KeyCurve,
  type PaymentRequestInit,
} from "agentcommercekit"
import { afterEach, describe, expect, it, vi } from "vitest"
import { buildReceipt, fixtureIdentity, fixtures, PAYMENT_SERVICE_URL, useFixedTime } from "@paywall/testkit"

const resolver = getDidResolver()
afterEach(() => {
  vi.useRealTimers()
})

function requestInit(issuerDid: string, now: Date, extra: Record<string, unknown> = {}): PaymentRequestInit {
  return {
    id: "pr_0001",
    description: "Market brief",
    expiresAt: new Date(now.getTime() + 900_000),
    paymentOptions: [
      {
        id: "sandbox-usd",
        amount: 500,
        decimals: 2,
        currency: "USD",
        recipient: issuerDid,
        network: "sandbox",
        paymentService: PAYMENT_SERVICE_URL,
        receiptService: fixtures.paymentService.did,
      },
    ],
    ...extra,
  }
}

describe("ACK round trip", () => {
  const curves: KeyCurve[] = ["Ed25519", "secp256k1", "secp256r1"]

  for (const curve of curves) {
    it(`PRO-2: a payment request, its token and a receipt round-trip with ${curve} did:key identities`, async () => {
      const clock = useFixedTime()
      const server = fixtureIdentity(`pro2-server-${curve}`, curve)
      const receiptService = fixtureIdentity(`pro2-ps-${curve}`, curve)
      const payer = fixtureIdentity(`pro2-payer-${curve}`, curve)
      expect(isDidKeyUri(server.did)).toBe(true)

      const resolved = await resolver.resolve(server.did)
      expect(resolved.didDocument?.id).toBe(server.did)

      const { paymentRequest, paymentRequestToken } = await createSignedPaymentRequest(requestInit(server.did, clock.now()), {
        issuer: server.did,
        signer: server.signer,
        algorithm: server.alg,
      })
      expect(paymentRequest.expiresAt).toBe("2026-11-10T14:17:00.000Z")

      const verified = await verifyPaymentRequestToken(paymentRequestToken, { resolver, issuer: server.did })
      expect(verified.paymentRequest).toEqual(paymentRequest)
      expect(verified.parsed.issuer).toBe(server.did)

      const credential = createPaymentReceipt({
        paymentRequestToken,
        paymentOptionId: "sandbox-usd",
        issuer: receiptService.did,
        payerDid: payer.did,
        expirationDate: new Date(clock.now().getTime() + 600_000),
        metadata: { paymentId: "pay_0001" },
      })
      const receipt = await signCredential(credential, { did: receiptService.did, signer: receiptService.signer, alg: receiptService.alg })
      expect(typeof receipt).toBe("string")

      const result = await verifyPaymentReceipt(receipt, {
        resolver,
        trustedReceiptIssuers: [receiptService.did],
        paymentRequestIssuer: server.did,
      })
      expect(result.receipt.issuer).toEqual({ id: receiptService.did })
      expect(result.receipt.credentialSubject).toMatchObject({
        id: payer.did,
        paymentRequestToken,
        paymentOptionId: "sandbox-usd",
        metadata: { paymentId: "pay_0001" },
      })
      expect(result.receipt.expirationDate).toBe("2026-11-10T14:12:00.000Z")
      expect(result.paymentRequestToken).toBe(paymentRequestToken)
      expect(result.paymentRequest).toEqual(paymentRequest)
    })
  }

  it("PRO-2: keypairToJwk and jwkToKeypair round-trip a keypair to the same DID", () => {
    for (const identity of [fixtures.acme, fixtures.paymentService]) {
      const keypair = jwkToKeypair(identity.jwk)
      expect(keypairToJwk(keypair)).toEqual(identity.jwk)
    }
  })

  it("PRO-2: createJwt and verifyJwt carry the initiation claims and enforce the audience", async () => {
    useFixedTime()
    const jwt = await createJwt(
      { aud: PAYMENT_SERVICE_URL, paymentRequestToken: "x.y.z", paymentOptionId: "sandbox-usd" },
      { issuer: fixtures.client.did, signer: fixtures.client.signer, expiresIn: 300 },
      { alg: fixtures.client.alg },
    )
    const verified = await verifyJwt(jwt, { resolver, audience: PAYMENT_SERVICE_URL })
    expect(verified.issuer).toBe(fixtures.client.did)
    expect(verified.payload).toMatchObject({ aud: PAYMENT_SERVICE_URL, paymentOptionId: "sandbox-usd" })
    expect((verified.payload.exp ?? 0) - (verified.payload.iat ?? 0)).toBe(300)

    await expect(verifyJwt(jwt, { resolver, audience: "http://localhost:8787/elsewhere" })).rejects.toThrow(/audience/i)
    // Without an expected audience, a token that carries one does not verify either.
    await expect(verifyJwt(jwt, { resolver })).rejects.toThrow(/audience/i)
  })
})

describe("ACK facts", () => {
  it("PRO-3: createSignedPaymentRequest drops unknown fields from the request and its options", async () => {
    const clock = useFixedTime()
    const init = requestInit(fixtures.acme.did, clock.now(), { resourceId: "market-brief" })
    const withExtraOption = { ...init, paymentOptions: [{ ...init.paymentOptions[0], resourceId: "market-brief" }] }
    const { paymentRequest, paymentRequestToken } = await createSignedPaymentRequest(withExtraOption as never, {
      issuer: fixtures.acme.did,
      signer: fixtures.acme.signer,
      algorithm: fixtures.acme.alg,
    })
    expect(paymentRequest).not.toHaveProperty("resourceId")
    expect(paymentRequest.paymentOptions[0]).not.toHaveProperty("resourceId")
    const verified = await verifyPaymentRequestToken(paymentRequestToken, { resolver })
    expect(verified.paymentRequest).not.toHaveProperty("resourceId")
    expect(typeof paymentRequest.expiresAt).toBe("string")
  })

  it("PRO-3: verifyPaymentRequestToken accepts a request whose expiresAt is in the past", async () => {
    const clock = useFixedTime()
    const { paymentRequestToken } = await createSignedPaymentRequest(
      { ...requestInit(fixtures.acme.did, clock.now()), expiresAt: new Date(clock.now().getTime() - 60_000) },
      { issuer: fixtures.acme.did, signer: fixtures.acme.signer, algorithm: fixtures.acme.alg },
    )
    const verified = await verifyPaymentRequestToken(paymentRequestToken, { resolver })
    expect(verified.paymentRequest.expiresAt).toBe("2026-11-10T14:01:00.000Z")
  })

  it("PRO-3: verifyPaymentRequestToken rejects a token signed by another key and one from an unexpected issuer", async () => {
    const clock = useFixedTime()
    const forged = await createSignedPaymentRequest(requestInit(fixtures.acme.did, clock.now()), {
      issuer: fixtures.acme.did,
      signer: fixtures.untrusted.signer,
      algorithm: fixtures.untrusted.alg,
    })
    await expect(verifyPaymentRequestToken(forged.paymentRequestToken, { resolver })).rejects.toBeInstanceOf(InvalidPaymentRequestTokenError)

    const genuine = await createSignedPaymentRequest(requestInit(fixtures.acme.did, clock.now()), {
      issuer: fixtures.acme.did,
      signer: fixtures.acme.signer,
      algorithm: fixtures.acme.alg,
    })
    await expect(
      verifyPaymentRequestToken(genuine.paymentRequestToken, { resolver, issuer: fixtures.globex.did }),
    ).rejects.toBeInstanceOf(InvalidPaymentRequestTokenError)
  })

  it("PRO-3: a receipt from an untrusted issuer throws UntrustedIssuerError", async () => {
    const clock = useFixedTime()
    const { paymentRequestToken } = await createSignedPaymentRequest(requestInit(fixtures.acme.did, clock.now()), {
      issuer: fixtures.acme.did,
      signer: fixtures.acme.signer,
      algorithm: fixtures.acme.alg,
    })
    const receipt = await buildReceipt({
      paymentRequestToken,
      paymentOptionId: "sandbox-usd",
      issuer: fixtures.untrusted,
      expirationDate: new Date(clock.now().getTime() + 600_000),
    })
    await expect(
      verifyPaymentReceipt(receipt, { resolver, trustedReceiptIssuers: [fixtures.paymentService.did], paymentRequestIssuer: fixtures.acme.did }),
    ).rejects.toBeInstanceOf(UntrustedIssuerError)
  })

  it("PRO-3: an expired receipt throws CredentialExpiredError", async () => {
    const clock = useFixedTime()
    const { paymentRequestToken } = await createSignedPaymentRequest(requestInit(fixtures.acme.did, clock.now()), {
      issuer: fixtures.acme.did,
      signer: fixtures.acme.signer,
      algorithm: fixtures.acme.alg,
    })
    const receipt = await buildReceipt({
      paymentRequestToken,
      paymentOptionId: "sandbox-usd",
      expirationDate: new Date(clock.now().getTime() + 600_000),
    })
    const options = { resolver, trustedReceiptIssuers: [fixtures.paymentService.did], paymentRequestIssuer: fixtures.acme.did }
    await expect(verifyPaymentReceipt(receipt, options)).resolves.toBeDefined()

    clock.advanceSeconds(601)
    await expect(verifyPaymentReceipt(receipt, options)).rejects.toBeInstanceOf(CredentialExpiredError)
  })

  it("PRO-3: a receipt more than 300 s past its expiry fails the JWT check first, not with CredentialExpiredError", async () => {
    // did-jwt allows 300 s of clock skew on `exp`; beyond that the JWT check
    // rejects the receipt before the credential expiry check runs.
    const clock = useFixedTime()
    const { paymentRequestToken } = await createSignedPaymentRequest(requestInit(fixtures.acme.did, clock.now()), {
      issuer: fixtures.acme.did,
      signer: fixtures.acme.signer,
      algorithm: fixtures.acme.alg,
    })
    const receipt = await buildReceipt({
      paymentRequestToken,
      paymentOptionId: "sandbox-usd",
      expirationDate: new Date(clock.now().getTime() + 600_000),
    })
    clock.advanceSeconds(600 + 301)
    const error = await verifyPaymentReceipt(receipt, {
      resolver,
      trustedReceiptIssuers: [fixtures.paymentService.did],
      paymentRequestIssuer: fixtures.acme.did,
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(CredentialExpiredError)
    expect(String(error)).toMatch(/expired/i)
  })

  it("PRO-3: a receipt whose token was issued by someone else throws InvalidPaymentRequestTokenError", async () => {
    const clock = useFixedTime()
    const { paymentRequestToken } = await createSignedPaymentRequest(requestInit(fixtures.globex.did, clock.now()), {
      issuer: fixtures.globex.did,
      signer: fixtures.globex.signer,
      algorithm: fixtures.globex.alg,
    })
    const receipt = await buildReceipt({
      paymentRequestToken,
      paymentOptionId: "sandbox-usd",
      expirationDate: new Date(clock.now().getTime() + 600_000),
    })
    await expect(
      verifyPaymentReceipt(receipt, { resolver, trustedReceiptIssuers: [fixtures.paymentService.did], paymentRequestIssuer: fixtures.acme.did }),
    ).rejects.toBeInstanceOf(InvalidPaymentRequestTokenError)
  })
})
