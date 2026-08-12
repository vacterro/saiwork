import { createSignal } from "solid-js"

import { serverApi } from "../lib/api-client"
import { formatQuotaCount } from "../lib/format-quota"
import { freebuffQuota } from "./freebuff"

/**
 * Per-model quota availability for the provider pools that have a daily limit:
 * FreeBuff (live from the codebuff snapshot, already polled) and Antigravity
 * (fetched from /api/google/antigravity/quota, cached 60s). Used by the model
 * picker to mark exhausted models and by the send/goal-auto guards so the user
 * is never surprised by a quota error mid-conversation.
 */

export interface ModelAvailability {
  usable: boolean
  /** True when quota data for this model is known at all. */
  known: boolean
  exhausted: boolean
  /** Short display, e.g. "2/6" or "62%". */
  remainingLabel?: string
  /** Reset as an epoch-ms timestamp for local-time rendering. */
  resetAt?: number
  period?: string
}

export interface FreebuffQuotaSnapshotLike {
  rateLimitsByModel?: Record<string, { model: string; limit: number; recentCount: number; resetAt?: string; period?: string }>
}

export interface AntigravityQuotaEntry {
  remainingPercent: number | null
  resetAt: string | null
}

export function freebuffAvailabilityFrom(
  snapshot: FreebuffQuotaSnapshotLike | null | undefined,
  modelId: string,
): ModelAvailability {
  const entry = snapshot?.rateLimitsByModel?.[modelId]
  if (!entry) return { usable: true, known: false, exhausted: false }
  const limit = Math.max(0, entry.limit)
  const remaining = Math.max(0, limit - Math.max(0, entry.recentCount))
  const usable = limit > 0 && remaining > 0
  return {
    usable,
    known: true,
    exhausted: !usable,
    remainingLabel: `${formatQuotaCount(remaining)}/${formatQuotaCount(limit)}`,
    resetAt: entry.resetAt ? Date.parse(entry.resetAt) : undefined,
    period: entry.period,
  }
}

export function antigravityAvailabilityFrom(
  models: Record<string, AntigravityQuotaEntry> | null | undefined,
  modelId: string,
): ModelAvailability {
  const entry = models?.[modelId]
  if (!entry || entry.remainingPercent === null) return { usable: true, known: false, exhausted: false }
  const usable = entry.remainingPercent > 0
  return {
    usable,
    known: true,
    exhausted: !usable,
    remainingLabel: `${entry.remainingPercent}%`,
    resetAt: entry.resetAt ? Date.parse(entry.resetAt) : undefined,
  }
}

const ANTIGRAVITY_QUOTA_TTL_MS = 60_000

const [antigravityQuota, setAntigravityQuota] = createSignal<Record<string, AntigravityQuotaEntry>>({})
const [antigravityQuotaError, setAntigravityQuotaError] = createSignal<string | null>(null)
let antigravityFetchedAt = 0
let antigravityFetching: Promise<void> | null = null

/** Fetch the Antigravity quota once per TTL; safe to call repeatedly. */
export function ensureAntigravityQuota(): Promise<void> {
  if (antigravityFetching) return antigravityFetching
  if (Date.now() - antigravityFetchedAt < ANTIGRAVITY_QUOTA_TTL_MS) return Promise.resolve()
  antigravityFetching = serverApi
    .fetchAntigravityQuota()
    .then((response) => {
      setAntigravityQuota(response.models)
      setAntigravityQuotaError(null)
      antigravityFetchedAt = Date.now()
    })
    .catch((error) => {
      // Surface the failure instead of silently showing "no quota": consumers
      // can render the reason. Retry after the TTL.
      setAntigravityQuotaError(error instanceof Error ? error.message : String(error))
      antigravityFetchedAt = Date.now()
    })
    .finally(() => {
      antigravityFetching = null
    })
  return antigravityFetching
}

export function antigravityQuotaModels(): Record<string, AntigravityQuotaEntry> {
  return antigravityQuota()
}

/** Non-null when the last Antigravity quota fetch failed. */
export function antigravityQuotaFailure(): string | null {
  return antigravityQuotaError()
}

/** Reactive availability for a picker option. */
export function modelAvailability(providerId: string, modelId: string): ModelAvailability {
  if (providerId === "freebuff") return freebuffAvailabilityFrom(freebuffQuota(), modelId)
  if (providerId === "google_antigravity") return antigravityAvailabilityFrom(antigravityQuota(), modelId)
  return { usable: true, known: false, exhausted: false }
}
