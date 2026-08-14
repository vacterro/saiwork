export const LOG_VALUE_MAX_LENGTH = 4096
export const LOG_ARRAY_MAX_ITEMS = 100
export const LOG_MAX_DEPTH = 8
export const LOG_REDACTED = "[REDACTED]"

const SENSITIVE_KEY_PART = /password|secret|apikey|authorization|cookie|privatekey|token/i

/**
 * True when a key names a secret-bearing field. Matching is deliberately
 * conservative (substring on the normalized key): a field that merely looks
 * secret is redacted rather than risk leaking the real one.
 */
export function isSensitiveLogKey(key: string): boolean {
  const normalized = key.replace(/[^a-zA-Z0-9]/g, "")
  return SENSITIVE_KEY_PART.test(normalized)
}

function boundString(value: string): string {
  if (value.length <= LOG_VALUE_MAX_LENGTH) return value
  return `${value.slice(0, LOG_VALUE_MAX_LENGTH)}...<truncated ${value.length - LOG_VALUE_MAX_LENGTH} chars>`
}

/**
 * Recursively redact every secret-bearing key and bound every string, so a
 * request payload can be handed to a trace logger without persisting login
 * passwords, tokens, API keys, cookies, or settings credentials. The result
 * is a plain copy; the input is never mutated.
 */
export function sanitizeLogValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === "string") return boundString(value)
  if (typeof value === "number" || typeof value === "boolean") return value

  if (Array.isArray(value)) {
    if (depth >= LOG_MAX_DEPTH) return `[depth-limit]`
    const items = value.slice(0, LOG_ARRAY_MAX_ITEMS)
    const sanitized = items.map((entry) => sanitizeLogValue(entry, depth + 1))
    return value.length > LOG_ARRAY_MAX_ITEMS
      ? [...sanitized, `...<truncated ${value.length - LOG_ARRAY_MAX_ITEMS} items>`]
      : sanitized
  }

  if (typeof value === "object") {
    if (depth >= LOG_MAX_DEPTH) return "[depth-limit]"
    const result: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = isSensitiveLogKey(key) ? LOG_REDACTED : sanitizeLogValue(entry, depth + 1)
    }
    return result
  }

  return String(value)
}
