// Lint rules, including the import boundaries between the packages and
// modules. Each boundary is a `no-restricted-imports` rule scoped to the files
// it applies to.
import js from "@eslint/js"
import globals from "globals"
import tseslint from "typescript-eslint"

// Libraries that would bypass ACK for JWTs, credentials and DIDs.
const bypassAck = {
  group: ["jose", "jose/*", "jsonwebtoken", "did-jwt", "did-jwt-vc", "did-resolver"],
  message: "Create and verify JWTs, credentials and DIDs with agentcommercekit.",
}
const stripeServer = { regex: "^stripe(/.*)?$", message: "The Stripe SDK is imported only under packages/server/src/payment-service/stripe/." }
const stripeBrowser = { regex: "^@stripe/", message: "Stripe.js is imported only under packages/client/src/stripe/." }
const testkit = { group: ["@paywall/testkit", "@paywall/testkit/*"], message: "The testkit is for tests only." }

// Base groups for every source file; each scoped block below repeats them,
// because a later no-restricted-imports entry replaces an earlier one.
const sourceGroups = [bypassAck, stripeServer, stripeBrowser, testkit]

const restricted = (...patterns) => ["error", { patterns }]
const restrictedTs = (paths, patterns) => ["error", { paths, patterns }]

// Time and ids come from the injected Clock and IdGenerator.
const clockAndIds = [
  "error",
  { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: "Read the time from the injected Clock." },
  { selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']", message: "Read the time from the injected Clock." },
  { selector: "CallExpression[callee.property.name='randomUUID']", message: "Take ids from the injected IdGenerator." },
]

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "**/coverage/**", ".gate/**", ".claude/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "no-restricted-imports": restricted(bypassAck),
      "no-restricted-syntax": clockAndIds,
    },
  },
  {
    files: ["packages/*/src/**"],
    rules: { "no-restricted-imports": restricted(...sourceGroups) },
  },
  {
    // The protocol package depends on nothing but ACK and valibot.
    files: ["packages/protocol/src/**"],
    rules: {
      "no-restricted-imports": restricted(...sourceGroups, {
        regex: "^(?!agentcommercekit(/|$)|valibot$|\\./).*",
        message: "@paywall/protocol imports only agentcommercekit and valibot.",
      }),
    },
  },
  {
    // The spend policy is pure: types from the protocol and nothing else.
    files: ["packages/server/src/policy/**"],
    rules: {
      "no-restricted-imports": "off",
      "@typescript-eslint/no-restricted-imports": restrictedTs(
        [{ name: "@paywall/protocol", allowTypeImports: true, message: "The policy imports only types from @paywall/protocol." }],
        [{ regex: "^(?!@paywall/protocol$|\\./).*", message: "The policy imports only types from @paywall/protocol." }],
      ),
    },
  },
  {
    files: ["packages/server/src/server-agent/**"],
    rules: {
      "no-restricted-imports": restricted(...sourceGroups, {
        group: ["**/payment-service", "**/payment-service/**"],
        message: "The server agent and the payment service meet only in app.ts.",
      }),
    },
  },
  {
    files: ["packages/server/src/payment-service/**"],
    ignores: ["packages/server/src/payment-service/stripe/**"],
    rules: {
      "no-restricted-imports": restricted(bypassAck, stripeServer, stripeBrowser, testkit, {
        group: ["**/server-agent", "**/server-agent/**"],
        message: "The server agent and the payment service meet only in app.ts.",
      }),
    },
  },
  {
    files: ["packages/server/src/payment-service/stripe/**"],
    rules: {
      "no-restricted-imports": restricted(bypassAck, stripeBrowser, testkit, {
        group: ["**/server-agent", "**/server-agent/**"],
        message: "The server agent and the payment service meet only in app.ts.",
      }),
    },
  },
  {
    // The client agent core: no React, no DOM beyond fetch and Web Crypto, no Stripe.
    files: ["packages/client/src/agent/**"],
    rules: {
      "no-restricted-imports": restricted(...sourceGroups, {
        group: ["react", "react/*", "react-dom", "react-dom/*", "**/ui/**", "**/stripe/**", "**/approver/**"],
        message: "The client agent core has no React, no DOM and no Stripe.",
      }),
      "no-restricted-globals": [
        "error",
        ...["window", "document", "localStorage", "sessionStorage", "navigator", "location", "history"].map((name) => ({
          name,
          message: "The client agent core uses no DOM beyond fetch and Web Crypto.",
        })),
      ],
    },
  },
  {
    files: ["packages/client/src/stripe/**"],
    rules: { "no-restricted-imports": restricted(bypassAck, stripeServer, testkit) },
  },
  {
    // The two system implementations of Clock and IdGenerator.
    files: ["packages/protocol/src/runtime.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
)
