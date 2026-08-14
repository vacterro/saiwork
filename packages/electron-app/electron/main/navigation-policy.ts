export type NavigationTargetClassification = "internal" | "externalAllowed" | "blocked"

/**
 * Canonical external-URL policy. Only http/https may reach the OS browser
 * (mailto: is intentionally absent: no product feature requires it), an
 * allowed renderer origin is internal, and every other scheme plus malformed
 * URLs is blocked -- never passed to an OS protocol handler and never treated
 * as trusted navigation.
 */
export function classifyNavigationTarget(url: string, allowedOrigins: readonly string[]): NavigationTargetClassification {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return "blocked"
  }
  if (parsed.protocol === "https:" || parsed.protocol === "http:") {
    return allowedOrigins.includes(parsed.origin) ? "internal" : "externalAllowed"
  }
  return "blocked"
}
