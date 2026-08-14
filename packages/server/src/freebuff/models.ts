import type { FreebuffModelInfo, FreebuffReasoningEffort } from "./types"

/**
 * FreeBuff's included free-tier models.
 *
 * Mirrors the catalog the FreeBuff desktop exposes on the limited tier. The
 * exact entitlement (limit, reset) comes live from the quota endpoint; this
 * file only maps stable IDs to display metadata.
 *
 * Reasoning: FreeBuff 0.0.55 accepts per-thread `reasoningEffort` on thread
 * creation. Every model caps its own effort range; the free-tier models all
 * top out at `high` (EFFORTS_THROUGH_HIGH in the orchestrator). SAIWORK always
 * requests the maximum so turns run at full reasoning.
 */
export const FREEBUFF_MAX_REASONING_EFFORT = "high" as const

export const FREEBUFF_MODELS: FreebuffModelInfo[] = [
  {
    id: "deepseek/deepseek-v4-flash",
    displayName: "DeepSeek V4 Flash 07/31",
    tagline: "Smartest & Fastest",
    free: true,
    isNew: true,
    contextWindow: 1_048_576,
    reasoningEffort: FREEBUFF_MAX_REASONING_EFFORT,
    efforts: ["low", "medium", "high"],
    defaultEffort: "medium",
  },
  {
    id: "mimo/mimo-v2.5",
    displayName: "MiMo 2.5",
    tagline: "Balanced",
    free: true,
  },
  {
    id: "z-ai/glm-5.2",
    displayName: "GLM 5.2",
    tagline: "Unlock by referring friends",
    free: true,
  },
]

export const FREEBUFF_MODEL_IDS = new Set(FREEBUFF_MODELS.map((model) => model.id))

/**
 * The effective catalog: the static display-metadata list unioned with any
 * model ids the FreeBuff backend currently reports live (its quota snapshot
 * lists per-model rate limits for every available model). A newly released
 * model appears here as soon as the backend serves it, with the id as its
 * display name until static metadata catches up.
 */
export function freebuffLiveCatalog(liveModelIds?: Iterable<string> | null): FreebuffModelInfo[] {
  const byId = new Map(FREEBUFF_MODELS.map((model) => [model.id, model]))
  for (const id of liveModelIds ?? []) {
    if (!id || byId.has(id)) continue
    byId.set(id, { id, displayName: id, tagline: "", free: true })
  }
  return [...byId.values()]
}

/** The set of model ids the FreeBuff backend currently exposes, static included. */
export function freebuffLiveModelIds(liveModelIds?: Iterable<string> | null): Set<string> {
  const ids = new Set<string>(FREEBUFF_MODELS.map((model) => model.id))
  for (const id of liveModelIds ?? []) {
    if (id) ids.add(id)
  }
  return ids
}

export function isFreebuffModelId(modelId: string | null | undefined): boolean {
  return Boolean(modelId && FREEBUFF_MODEL_IDS.has(modelId))
}

export function freebuffModelInfo(modelId: string): FreebuffModelInfo | null {
  return FREEBUFF_MODELS.find((model) => model.id === modelId) ?? null
}

/** The maximum reasoning effort the engine will honor for `modelId`. */
export function freebuffMaxReasoningEffort(modelId: string): FreebuffReasoningEffort {
  const model = freebuffModelInfo(modelId)
  const efforts = model?.efforts
  if (efforts && efforts.length > 0) return efforts[efforts.length - 1]
  return model?.reasoningEffort ?? FREEBUFF_MAX_REASONING_EFFORT
}
