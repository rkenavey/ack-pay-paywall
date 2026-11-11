/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The server origin the page talks to. Defaults to `http://localhost:8787`. */
  readonly VITE_API_BASE_URL?: string
}
