import { resolveGeminiApiKey } from "./providers"
import { ANTIGRAVITY_SHIM_API_KEY } from "../server/shim-keys"
import {
  ANTIGRAVITY_PROVIDER_ID,
  GEMINI_API_PROVIDER_ID,
  type GoogleExecutionResolution,
  type GoogleProviderId,
} from "./types"

/**
 * Execution-boundary adapter.
 *
 * SAIWORK's Google concept (provider id + scoped model) is converted to the
 * OpenCode execution layer (a provider id + model id + auth mode) ONLY here.
 * No OpenCode-specific strings leak into the rest of SAIWORK.
 *
 * Provider switching is never implicit: resolving a model to a different
 * provider requires the caller to pass `allowFallback = true`; otherwise a
 * cross-pool resolution is refused so a quota-exhausted provider can never
 * silently start burning paid credits on another billing pool.
 */

export class ProviderFallbackBlockedError extends Error {
  constructor(from: GoogleProviderId, to: GoogleProviderId) {
    super(`Provider fallback is disabled; refusing to route ${from} to ${to}.`)
    this.name = "ProviderFallbackBlockedError"
  }
}

export interface ResolveExecutionOptions {
  allowProviderFallback: boolean
  /** Override the Gemini API key source for spawn env injection. */
  resolveGeminiKey?: () => string | null
}

/** The OpenCode provider id that fronts the local Antigravity shim. */
export const ANTIGRAVITY_OPENCODE_PROVIDER = "saiwork-antigravity"
// Per-instance bearer key for the Antigravity shim (see server/shim-keys.ts).
export { ANTIGRAVITY_SHIM_API_KEY }

export function resolveGoogleExecution(
  providerId: GoogleProviderId,
  scopedModelId: string,
  options: ResolveExecutionOptions,
): GoogleExecutionResolution {
  // Strip the SAIWORK provider prefix from a scoped model id if present.
  const modelId = scopedModelId.startsWith(`${providerId}/`)
    ? scopedModelId.slice(providerId.length + 1)
    : scopedModelId

  if (providerId === GEMINI_API_PROVIDER_ID) {
    return {
      providerId,
      modelId,
      opencodeProvider: "google",
      opencodeModelId: modelId,
      authMode: "api",
      env: {},
    }
  }

  if (providerId === ANTIGRAVITY_PROVIDER_ID) {
    // Antigravity runs through the local SAIWORK shim: the OAuth session lives
    // server-side, so the workspace gets no credential and no env var.
    return {
      providerId,
      modelId,
      opencodeProvider: ANTIGRAVITY_OPENCODE_PROVIDER,
      opencodeModelId: modelId,
      authMode: "shim",
      env: {},
    }
  }

  throw new ProviderFallbackBlockedError(providerId, GEMINI_API_PROVIDER_ID)
}

/**
 * Resolve a fallback target when a provider is exhausted. Refuses unless the
 * user explicitly enabled cross-provider fallback.
 */
export function resolveGoogleFallback(
  from: GoogleProviderId,
  modelId: string,
  allowProviderFallback: boolean,
): GoogleExecutionResolution | null {
  if (!allowProviderFallback) {
    return null
  }
  const target: GoogleProviderId =
    from === GEMINI_API_PROVIDER_ID ? ANTIGRAVITY_PROVIDER_ID : GEMINI_API_PROVIDER_ID
  return resolveGoogleExecution(target, modelId, { allowProviderFallback: true })
}

/** Env vars to merge into a spawned OpenCode process for the Gemini API key. */
export function geminiSpawnEnv(
  resolveGeminiKey: () => string | null = resolveGeminiApiKey,
): Record<string, string> {
  const key = resolveGeminiKey()
  return key ? { GEMINI_API_KEY: key } : {}
}

/**
 * Env vars for a spawned OpenCode process covering both Google pools.
 *
 * GEMINI_API_KEY feeds the google_gemini_api provider. Antigravity needs no
 * env var: its OAuth session lives server-side in SAIWORK and is served to the
 * workspace through the local shim, so the Google account credential never
 * crosses into a child process.
 */
export function googleSpawnEnv(
  resolveGeminiKey: () => string | null = resolveGeminiApiKey,
): Record<string, string> {
  const geminiKey = resolveGeminiKey()
  return geminiKey ? { GEMINI_API_KEY: geminiKey } : {}
}

/**
 * OpenCode config fragment registering the two Google providers as distinct
 * entries. Model ids stay provider-scoped so the picker can never confuse a
 * Gemini API model with an Antigravity one.
 *
 * `google_antigravity` is fronted by the local SAIWORK shim: OpenCode talks an
 * OpenAI-compatible protocol to `${baseUrl}/v1`, and SAIWORK translates to the
 * Antigravity subscription backend (cloudcode-pa.googleapis.com) with the
 * OAuth session it manages. The shim token is a constant local gate, not a
 * real secret.
 *
 * The Antigravity provider pins NO models: the `@ai-sdk/openai-compatible`
 * provider lists them live from the shim's `/v1/models`, which serves the
 * current backend catalog. A model the vendor releases (Gemini 3.7 Flash, ...)
 * therefore appears without a SAIWORK release and without editing this file.
 */
export function buildGoogleProviderConfig(options: { baseUrl?: string; includeAntigravity?: boolean } = {}): {
  provider: Record<string, unknown>
} {
  const shimBaseUrl = options.baseUrl?.replace(/\/+$/, "") ?? "http://127.0.0.1:4000"

  const provider: Record<string, unknown> = {
    [GEMINI_API_PROVIDER_ID]: {
      npm: "@ai-sdk/google",
      name: "Gemini API",
      // Split the two standard Google env vars across the providers so each
      // pool gets its own credential without a custom env name (which
      // OpenCode rejects for npm providers). SAIWORK injects GEMINI_API_KEY
      // (Developer API key) at workspace spawn; nothing is stored in config.
      env: ["GEMINI_API_KEY"],
      options: { baseURL: "https://generativelanguage.googleapis.com/v1beta" },
      models: {
        "gemini-3.1-pro-preview": { name: "Gemini 3.1 Pro Preview", reasoning: true },
        "gemini-3.5-flash": { name: "Gemini 3.5 Flash", reasoning: true },
        "gemini-3.5-flash-lite": { name: "Gemini 3.5 Flash Lite", reasoning: true },
        "gemini-3.1-flash-lite": { name: "Gemini 3.1 Flash Lite", reasoning: true },
      },
    },
  }
  if (options.includeAntigravity !== false) {
    provider[ANTIGRAVITY_PROVIDER_ID] = {
      npm: "@ai-sdk/openai-compatible",
      name: "Antigravity",
      options: {
        baseURL: `${shimBaseUrl}/v1`,
        apiKey: ANTIGRAVITY_SHIM_API_KEY,
      },
    }
  }
  return { provider }
}
