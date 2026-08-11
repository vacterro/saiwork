import type { FreebuffRateLimit, FreebuffSessionSnapshot } from "./types"
import type { FetchLike } from "./client"

export const FREEBUFF_SESSION_ENDPOINT = "https://www.codebuff.com/api/v1/freebuff/session"
export const FREEBUFF_QUOTA_TIMEOUT_MS = 10_000

export interface FreebuffQuotaResult {
  configured: boolean
  snapshot: FreebuffSessionSnapshot | null
  error: string | null
}

/**
 * Read-only quota snapshot from codebuff.com.
 *
 * GET /api/v1/freebuff/session is the same display-only call the FreeBuff
 * desktop makes for its quota meter — no inference, no session slot granted —
 * so it is safe for SAIWORK to poll for the usage panel.
 */
export async function fetchFreebuffQuota(
  getToken: () => string | null,
  overrides: { fetch?: FetchLike; endpoint?: string } = {},
): Promise<FreebuffQuotaResult> {
  const token = getToken()
  if (!token) {
    return { configured: false, snapshot: null, error: "FreeBuff account not signed in" }
  }
  const fetchFn = overrides.fetch ?? fetch
  const endpoint = overrides.endpoint ?? FREEBUFF_SESSION_ENDPOINT
  try {
    const response = await fetchFn(endpoint, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        accept: "application/json",
        "x-freebuff-multi-session": "1",
        "x-freebuff-include-unused-rate-limits": "1",
      },
      signal: AbortSignal.timeout(FREEBUFF_QUOTA_TIMEOUT_MS),
    })
    if (!response.ok) {
      return { configured: true, snapshot: null, error: `FreeBuff quota request failed (HTTP ${response.status})` }
    }
    const raw: unknown = await response.json()
    const snapshot = parseSessionSnapshot(raw)
    return { configured: true, snapshot, error: snapshot ? null : "FreeBuff quota response had an unexpected shape" }
  } catch (error) {
    return {
      configured: true,
      snapshot: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export function parseSessionSnapshot(raw: unknown): FreebuffSessionSnapshot | null {
  if (typeof raw !== "object" || raw === null) return null
  const value = raw as Record<string, unknown>
  if (typeof value.status !== "string" || typeof value.accessTier !== "string") {
    return null
  }
  const snapshot: FreebuffSessionSnapshot = {
    status: value.status,
    accessTier: value.accessTier,
  }
  const rateLimits = value.rateLimitsByModel
  if (typeof rateLimits === "object" && rateLimits !== null && !Array.isArray(rateLimits)) {
    const parsed: Record<string, FreebuffRateLimit> = {}
    for (const [model, entry] of Object.entries(rateLimits)) {
      const limit = parseRateLimit(model, entry)
      if (limit) parsed[model] = limit
    }
    if (Object.keys(parsed).length > 0) snapshot.rateLimitsByModel = parsed
  }
  const counts = value.desktopSessionCounts
  if (typeof counts === "object" && counts !== null) {
    const rawCounts = counts as Record<string, unknown>
    snapshot.desktopSessionCounts = {
      premium: toFiniteNumber(rawCounts.premium, 0),
      unlimited: toFiniteNumber(rawCounts.unlimited, 0),
      ...(typeof rawCounts.nextExpiryAt === "string" ? { nextExpiryAt: rawCounts.nextExpiryAt } : {}),
    }
  }
  return snapshot
}

function parseRateLimit(model: string, raw: unknown): FreebuffRateLimit | null {
  if (typeof raw !== "object" || raw === null) return null
  const value = raw as Record<string, unknown>
  const limit = toFiniteNumber(value.limit, NaN)
  if (!Number.isFinite(limit)) return null
  const parsed: FreebuffRateLimit = {
    model,
    limit,
    period: typeof value.period === "string" ? value.period : "pacific_day",
    recentCount: toFiniteNumber(value.recentCount, 0),
  }
  if (typeof value.resetTimeZone === "string") parsed.resetTimeZone = value.resetTimeZone
  if (typeof value.resetAt === "string") parsed.resetAt = value.resetAt
  const windowHours = toFiniteNumber(value.windowHours, NaN)
  if (Number.isFinite(windowHours)) parsed.windowHours = windowHours
  const breakdown = value.entitlementBreakdown
  if (typeof breakdown === "object" && breakdown !== null) {
    const rawBreakdown = breakdown as Record<string, unknown>
    parsed.entitlementBreakdown = {
      base: toFiniteNumber(rawBreakdown.base, 0),
      referral: toFiniteNumber(rawBreakdown.referral, 0),
      streak: toFiniteNumber(rawBreakdown.streak, 0),
    }
  }
  return parsed
}

function toFiniteNumber(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : Number(value)
  return Number.isFinite(number) ? number : fallback
}
