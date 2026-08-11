/**
 * Google error classification for the plugin side of the execution boundary.
 *
 * Lives in its own module so the plugin can import it without exposing extra
 * named exports that OpenCode's plugin loader could mistake for hooks.
 */

export interface GooglePluginError {
  name?: string
  data?: {
    message?: string
    statusCode?: number
    responseBody?: string
    metadata?: Record<string, string>
  }
}

export type GoogleClassifyClient = {
  classifyGoogleError: (payload: { providerId: string; message?: string; status?: number; body?: unknown }) => Promise<{
    code: string
    providerId: string
    message: string
    retryable: boolean
    retryAfterSeconds?: number
  }>
  postEvent: (event: { type: string; properties?: Record<string, unknown> }) => Promise<void>
}

const GOOGLE_ERROR_MARKERS = [
  "google",
  "gemini",
  "generativelanguage",
  "free_tier",
  "AIza",
  "ya29",
] as const

const SECRET_PATTERNS: RegExp[] = [
  /AIza[0-9A-Za-z_-]{10,}/g,
  /ya29\.[0-9A-Za-z_-]{6,}/g,
  /1\/\/[0-9A-Za-z_-]{6,}/g,
  /Bearer [A-Za-z0-9._~+/=-]+/g,
]

export function redactSecrets(input: string): string {
  let output = input
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, "[REDACTED]")
  }
  return output
}

/**
 * Classifies Google model errors at the execution boundary.
 *
 * The plugin runs inside OpenCode, so it is the first place a `session.error`
 * from a google_* provider is visible. It asks the SAIWORK server to normalize
 * the error (free_tier gets the correct message, never an Antigravity label),
 * logs only the redacted result, and forwards a normalized event so the UI can
 * surface it later. Classification and redaction are best-effort: any failure
 * here must never break the session, so everything is caught.
 */
export async function maybeClassifyGoogleError(
  error: GooglePluginError,
  client: GoogleClassifyClient,
): Promise<void> {
  try {
    const data = error.data ?? {}
    const message = data.message ?? ""
    const responseBody = data.responseBody ?? ""
    const rawText = `${message}\n${responseBody}`
    const lower = rawText.toLowerCase()

    const isGoogle = GOOGLE_ERROR_MARKERS.some((marker) => lower.includes(marker))
    if (!isGoogle) return

    const providerId = lower.includes("antigravity") || lower.includes("google.oauth")
      ? "google_antigravity"
      : "google_gemini_api"

    const normalized = await client.classifyGoogleError({
      providerId,
      message: data.message,
      status: data.statusCode,
      body: data.responseBody,
    })

    const safe = redactSecrets(`${normalized.code}: ${normalized.message}`)
    console.warn(`[SaiWorkPlugin] ${safe}`)

    await client.postEvent({
      type: "saiwork.googleError",
      properties: {
        providerId: normalized.providerId,
        code: normalized.code,
        message: normalized.message,
        retryable: normalized.retryable,
      },
    }).catch(() => undefined)
  } catch {
    // Classification is best-effort; never let it interfere with the session.
  }
}
