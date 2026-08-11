import type { FreebuffModelInfo } from "./types"

/**
 * FreeBuff's included free-tier models.
 *
 * Mirrors the catalog the FreeBuff desktop exposes on the limited tier. The
 * exact entitlement (limit, reset) comes live from the quota endpoint; this
 * file only maps stable IDs to display metadata.
 */
export const FREEBUFF_MODELS: FreebuffModelInfo[] = [
  {
    id: "deepseek/deepseek-v4-flash",
    displayName: "DeepSeek V4 Flash 07/31",
    tagline: "Smartest & Fastest",
    free: true,
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

export function isFreebuffModelId(modelId: string | null | undefined): boolean {
  return Boolean(modelId && FREEBUFF_MODEL_IDS.has(modelId))
}

export function freebuffModelInfo(modelId: string): FreebuffModelInfo | null {
  return FREEBUFF_MODELS.find((model) => model.id === modelId) ?? null
}
