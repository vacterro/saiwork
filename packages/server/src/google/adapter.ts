import { resolveAntigravityAccessToken, resolveGeminiApiKey } from "./providers"
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
 * OpenCode execution layer (the built-in `google` provider + model id + auth
 * mode) ONLY here. No OpenCode-specific strings leak into the rest of SAIWORK.
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
    return {
      providerId,
      modelId,
      opencodeProvider: "google",
      opencodeModelId: modelId,
      authMode: "oauth",
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
 * GEMINI_API_KEY feeds the google_gemini_api provider; the Antigravity OAuth
 * token feeds google_antigravity via GOOGLE_GENERATIVE_AI_API_KEY. The two
 * standard env vars are split across the providers, so both pools can be
 * configured at once without a custom env name or a secret in config.
 */
export function googleSpawnEnv(
  resolveGeminiKey: () => string | null = resolveGeminiApiKey,
  resolveAntigravityToken: () => string | null = resolveAntigravityAccessToken,
): Record<string, string> {
  const env: Record<string, string> = {}
  const geminiKey = resolveGeminiKey()
  if (geminiKey) env.GEMINI_API_KEY = geminiKey
  const antigravityToken = resolveAntigravityToken()
  if (antigravityToken) env.GOOGLE_GENERATIVE_AI_API_KEY = antigravityToken
  return env
}

/**
 * OpenCode config fragment registering the two Google providers as distinct
 * entries. Model ids stay provider-scoped so the picker can never confuse a
 * Gemini API model with an Antigravity one.
 */
export function buildGoogleProviderConfig(): { provider: Record<string, unknown> } {
  return {
    provider: {
      [GEMINI_API_PROVIDER_ID]: {
        npm: "@ai-sdk/google",
        name: "Gemini API",
        // Split the two standard Google env vars across the providers so each
        // pool gets its own credential without a custom env name (which
        // OpenCode rejects for npm providers). SAIWORK injects GEMINI_API_KEY
        // (Developer API key) and GOOGLE_GENERATIVE_AI_API_KEY (Antigravity
        // OAuth token) at workspace spawn; nothing is stored in config.
        env: ["GEMINI_API_KEY"],
        options: { baseURL: "https://generativelanguage.googleapis.com/v1beta" },
        models: {
          "gemini-3.1-pro-preview": { name: "Gemini 3.1 Pro Preview", reasoning: true },
          "gemini-3.5-flash": { name: "Gemini 3.5 Flash", reasoning: true },
          "gemini-3.5-flash-lite": { name: "Gemini 3.5 Flash Lite", reasoning: true },
          "gemini-3.1-flash-lite": { name: "Gemini 3.1 Flash Lite", reasoning: true },
        },
      },
      [ANTIGRAVITY_PROVIDER_ID]: {
        npm: "@ai-sdk/google",
        name: "Antigravity",
        env: ["GOOGLE_GENERATIVE_AI_API_KEY"],
        options: { baseURL: "https://generativelanguage.googleapis.com/v1beta" },
        models: {
          "gemini-3.1-pro-preview": { name: "Gemini 3.1 Pro Preview (AI Pro)", reasoning: true },
          "gemini-3.5-flash": { name: "Gemini 3.5 Flash (AI Pro)", reasoning: true },
          "gemini-3.5-flash-lite": { name: "Gemini 3.5 Flash Lite (AI Pro)", reasoning: true },
        },
      },
    },
  }
}
