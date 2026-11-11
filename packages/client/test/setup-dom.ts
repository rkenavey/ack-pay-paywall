import "@testing-library/jest-dom/vitest"
import { cleanup } from "@testing-library/react"
import { afterEach } from "vitest"

// jsdom installs its own typed-array constructors, while Node APIs such as
// TextEncoder and Buffer still return Node's. The multiformats code under ACK
// checks `instanceof Uint8Array` and rejects bytes from the other realm, so
// the tests put Node's constructors back. Real browsers have one realm.
const nodeUint8Array = Object.getPrototypeOf(Buffer.prototype).constructor as Uint8ArrayConstructor
const nodeArrayBuffer = Buffer.alloc(1).buffer.constructor as ArrayBufferConstructor
Object.assign(globalThis, { Uint8Array: nodeUint8Array, ArrayBuffer: nodeArrayBuffer })

afterEach(() => {
  cleanup()
})
