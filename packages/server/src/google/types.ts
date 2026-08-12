/**
 * Google provider concept layer.
 *
 * Gemini Developer API and Antigravity (Google AI Pro subscription) are two
 * INDEPENDENT providers with separate auth, billing and quota pools. They share
 * the Google brand but must never be conflated: a Google AI Pro subscription is
 * not Gemini API billing, and a Gemini API key is not Antigravity OAuth.
 *
 * SAIWORK models them as distinct provider IDs and converts to the OpenCode
 * execution layer only at the adapter boundary.
 */

export const GEMINI_API_PROVIDER_ID = "google_gemini_api"
export const ANTIGRAVITY_PROVIDER_ID = "google_antigravity"

export type GoogleProviderId = typeof GEMINI_API_PROVIDER_ID | typeof ANTIGRAVITY_PROVIDER_ID

export const GOOGLE_PROVIDER_IDS: readonly GoogleProviderId[] = [
  GEMINI_API_PROVIDER_ID,
  ANTIGRAVITY_PROVIDER_ID,
]

export type GoogleProviderStatus =
  | "ready"
  | "auth_required"
  | "not_configured"
  | "plugin_missing"
  | "unavailable"

export interface GoogleProviderInfo {
  id: GoogleProviderId
  name: string
  description: string
  experimental: boolean
  status: GoogleProviderStatus
  detail: string | null
  modelCount: number
}

/** Normalized, provider-aware error classification. */
export type GoogleErrorCode =
  | "AUTH_REQUIRED"
  | "INVALID_API_KEY"
  | "FREE_TIER_QUOTA_EXCEEDED"
  | "PAID_API_QUOTA_EXCEEDED"
  | "ANTIGRAVITY_QUOTA_EXCEEDED"
  | "PLUGIN_MISSING"
  | "PROVIDER_UNAVAILABLE"
  | "MODEL_UNAVAILABLE"
  | "NETWORK_ERROR"
  | "UNKNOWN_PROVIDER_ERROR"

export interface GoogleError {
  code: GoogleErrorCode
  providerId: GoogleProviderId
  /** User-facing message, already normalized. */
  message: string
  /** True when a bounded retry is reasonable (transient network/server). */
  retryable: boolean
  /** Seconds to wait before retrying, when the provider supplied one. */
  retryAfterSeconds?: number
}

export interface GoogleModelInfo {
  id: string
  displayName: string
  reasoning: boolean
  context: number
  /** Which Google provider this model belongs to. */
  providerId: GoogleProviderId
}

/** Resolution of a SAIWORK Google provider at the OpenCode execution boundary. */
export interface GoogleExecutionResolution {
  providerId: GoogleProviderId
  modelId: string
  /** The OpenCode provider this maps to: the built-in `google` or the local Antigravity shim. */
  opencodeProvider: "google" | "saiwork-antigravity"
  /** OpenCode model id inside that provider (unprefixed). */
  opencodeModelId: string
  /** Which auth mode OpenCode must use for this provider. */
  authMode: "api" | "oauth" | "shim"
  /** Extra env vars to inject into the spawned OpenCode process, if any. */
  env: Record<string, string>
}

export interface GoogleProvidersStatusResponse {
  providers: GoogleProviderInfo[]
  allowProviderFallback: boolean
  antigravityAcknowledged: boolean
}
