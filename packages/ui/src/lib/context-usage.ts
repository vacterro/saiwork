export interface ContextTokenUsage {
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens?: number
  summary?: boolean
}

export interface ContextCompactionLimits {
  contextWindow: number
  inputLimit: number | null
  outputLimit: number
  reservedTokens?: number
  autoCompact?: boolean
}

function validTokenCount(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

export function resolveActualUsageTokens(usage: ContextTokenUsage): number {
  if (usage.summary) return usage.outputTokens
  if (validTokenCount(usage.totalTokens) && usage.totalTokens > 0) return usage.totalTokens

  return (
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheReadTokens +
    usage.cacheWriteTokens
  )
}

export function resolveCompactionThreshold(limits: ContextCompactionLimits): number | null {
  if (limits.autoCompact === false || limits.contextWindow <= 0) return null

  if (limits.inputLimit && limits.inputLimit > 0) {
    const reserved = validTokenCount(limits.reservedTokens)
      ? limits.reservedTokens
      : Math.min(20_000, Math.max(0, limits.outputLimit))
    return Math.max(0, limits.inputLimit - reserved)
  }

  return Math.max(0, limits.contextWindow - Math.max(0, limits.outputLimit))
}
