/**
 * Secret sanitization for the Google integration.
 *
 * API keys, OAuth tokens and authorization payloads must never reach logs,
 * persisted config, or SAIPEN/board files. Anything that will be logged or
 * stored passes through here first.
 */

const SECRET_PATTERNS: RegExp[] = [
  /AIza[0-9A-Za-z_-]{10,}/g, // Gemini API key
  /AQ\.[0-9A-Za-z_-]{10,}/g, // OAuth-minted ephemeral key
  /ya29\.[0-9A-Za-z_-]{6,}/g, // Google OAuth access token
  /1\/\/[0-9A-Za-z_-]{6,}/g, // Google OAuth refresh token
  /ghp_[0-9A-Za-z]{20,}/g, // GitHub token fallback
  /sk-[0-9A-Za-z]{20,}/g, // generic secret key
]

export const REDACTED = "[REDACTED]"

/** Strip well-known secret shapes from free text. */
export function sanitizeSecretText(input: string): string {
  let output = input
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, REDACTED)
  }
  return output
}

/** Strip `Authorization: Bearer ...` and `X-Goog-Api-Key: ...` header lines. */
export function sanitizeHeaderLine(line: string): string {
  const lowered = line.toLowerCase()
  if (lowered.startsWith("authorization:") || lowered.startsWith("x-goog-api-key:")
    || lowered.startsWith("x-api-key:")) {
    const name = line.slice(0, line.indexOf(":") + 1)
    return `${name} ${REDACTED}`
  }
  return line
}

export function sanitizeStderr(raw: string): string {
  return raw
    .split(/\r?\n/)
    .map(sanitizeHeaderLine)
    .map((line) => sanitizeSecretText(line))
    .join("\n")
}

/** True when a string looks like it contains a credential. */
export function looksLikeSecret(input: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(input))
}
