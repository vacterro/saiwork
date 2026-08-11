import {
  ANTIGRAVITY_PROVIDER_ID,
  GEMINI_API_PROVIDER_ID,
  type GoogleError,
  type GoogleErrorCode,
  type GoogleProviderId,
} from "./types"

/**
 * Normalized, provider-aware Google error classification.
 *
 * The critical distinction: `free_tier` failures come from the Gemini
 * Developer API Free Tier and have NOTHING to do with a Google AI Pro /
 * Antigravity subscription. Classifying them as such prevents two classic
 * mistakes: telling the user to rotate their API key (which will not help)
 * and reporting the error against the wrong quota pool.
 */

export interface RawGoogleErrorInput {
  /** HTTP status when available. */
  status?: number
  /** The raw message/body to inspect. */
  message?: string
  /** Structured error body, if any (e.g. `error.status`). */
  body?: unknown
}

const FREE_TIER_PATTERNS = [
  "free_tier",
  "free tier",
  "generate_content_free_tier_input_token_count",
  "free-tier",
] as const

const QUOTA_PATTERNS = [
  "quota",
  "rate limit",
  "rate_limit",
  "resource_exhausted",
  "429",
  "insufficient",
] as const

const AUTH_PATTERNS = [
  "unauthorized",
  "permission denied",
  "invalid api key",
  "invalid_key",
  "api key not valid",
  "authentication",
  "auth required",
  "403",
  "401",
] as const

const MODEL_PATTERNS = [
  "model not found",
  "not found: models/",
  "models/.*not found",
  "not_found",
  "no model",
  "model name",
  "not found",
] as const

const NETWORK_PATTERNS = [
  "econnreset",
  "econnrefused",
  "enotfound",
  "network",
  "socket",
  "timeout",
  "aborted",
  "fetch failed",
  "failed to fetch",
] as const

function textOf(input: RawGoogleErrorInput): string {
  const parts: string[] = []
  if (input.message) parts.push(input.message)
  if (typeof input.body === "string") parts.push(input.body)
  if (input.body && typeof input.body === "object") {
    const raw = input.body as Record<string, unknown>
    const status = typeof raw.status === "string" ? raw.status : ""
    const message = typeof raw.message === "string" ? raw.message : ""
    if (status) parts.push(status)
    if (message) parts.push(message)
  }
  return parts.join("\n").toLowerCase()
}

function hasAny(text: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern).test(text)
    } catch {
      return text.includes(pattern)
    }
  })
}

export function classifyGoogleError(
  providerId: GoogleProviderId,
  input: RawGoogleErrorInput,
): GoogleError {
  const text = textOf(input)
  const status = input.status

  if (hasAny(text, FREE_TIER_PATTERNS)) {
    return {
      code: "FREE_TIER_QUOTA_EXCEEDED",
      providerId,
      message:
        "Gemini Developer API Free Tier quota exhausted. This is not your Google AI Pro / Antigravity quota. " +
        "Check your Google AI Studio billing or project quota; changing the API key does not raise this limit.",
      retryable: false,
    }
  }

  if (status !== undefined && status >= 500 && status < 600) {
    return {
      code: "PROVIDER_UNAVAILABLE",
      providerId,
      message: "Google service is temporarily unavailable. Try again in a moment.",
      retryable: true,
    }
  }

  if (hasAny(text, NETWORK_PATTERNS)) {
    return {
      code: "NETWORK_ERROR",
      providerId,
      message: "Network error while reaching the Google service. Check your connection and retry.",
      retryable: true,
    }
  }

  if (hasAny(text, QUOTA_PATTERNS)) {
    const isAntigravity = providerId === ANTIGRAVITY_PROVIDER_ID
    return {
      code: isAntigravity ? "ANTIGRAVITY_QUOTA_EXCEEDED" : "PAID_API_QUOTA_EXCEEDED",
      providerId,
      message: isAntigravity
        ? "Antigravity subscription quota exceeded for this period."
        : "Gemini API quota exceeded for this billing project.",
      retryable: false,
    }
  }

  if (hasAny(text, MODEL_PATTERNS)) {
    return {
      code: "MODEL_UNAVAILABLE",
      providerId,
      message: `The selected model is not available on the ${providerId === GEMINI_API_PROVIDER_ID ? "Gemini API" : "Antigravity"} provider.`,
      retryable: false,
    }
  }

  if (hasAny(text, AUTH_PATTERNS) || status === 401 || status === 403) {
    const isAntigravity = providerId === ANTIGRAVITY_PROVIDER_ID
    return {
      code: isAntigravity ? "AUTH_REQUIRED" : "INVALID_API_KEY",
      providerId,
      message: isAntigravity
        ? "Antigravity OAuth session is required or expired. Sign in to Antigravity to continue."
        : "The Gemini API key is invalid or unauthorized. Verify the key in your Google AI Studio project.",
      retryable: false,
    }
  }

  return {
    code: "UNKNOWN_PROVIDER_ERROR",
    providerId,
    message: "The Google provider returned an unrecognized error.",
    retryable: false,
  }
}

/** True when a bounded retry is safe for this classification. */
export function isRetryableGoogleErrorCode(code: GoogleErrorCode): boolean {
  return code === "NETWORK_ERROR" || code === "PROVIDER_UNAVAILABLE"
}
