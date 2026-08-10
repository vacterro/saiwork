import type { Provider } from "../../types/session"
import { DEFAULT_MODEL_OUTPUT_LIMIT } from "../session-models"
import { providers, sessions, sessionInfoByInstance, setSessionInfoByInstance, updateThreadTotalsForSession } from "../session-state"
import { messageStoreBus } from "./bus"
import type { SessionUsageState } from "./types"

function getLatestUsageEntry(usage?: SessionUsageState) {
  if (!usage?.latestMessageId) return undefined
  return usage.entries[usage.latestMessageId]
}

function resolveSelectedModel(instanceProviders: Provider[], providerId?: string, modelId?: string) {
  if (!providerId || !modelId) return undefined
  const provider = instanceProviders.find((p) => p.id === providerId)
  return provider?.models.find((m) => m.id === modelId)
}

export function updateSessionInfo(instanceId: string, sessionId: string): void {
  const instanceSessions = sessions().get(instanceId)
  if (!instanceSessions) return
  const session = instanceSessions.get(sessionId)
  if (!session) return

  const store = messageStoreBus.getOrCreate(instanceId)
  const usage = store.getSessionUsage(sessionId)
  const hasUsageEntries = Boolean(usage && Object.keys(usage.entries).length > 0)

  let totalInputTokens = usage?.totalInputTokens ?? 0
  let totalOutputTokens = usage?.totalOutputTokens ?? 0
  let totalReasoningTokens = usage?.totalReasoningTokens ?? 0
  let totalCost = usage?.totalCost ?? 0
  let actualUsageTokens = usage?.actualUsageTokens ?? 0

  const latestEntry = getLatestUsageEntry(usage)

  const previousInfo = sessionInfoByInstance().get(instanceId)?.get(sessionId)
  let contextWindow = 0
  let contextLimitTokens: number | null = null
  let isSubscriptionModel = false

  if (!hasUsageEntries && previousInfo) {
    totalInputTokens = previousInfo.inputTokens
    totalOutputTokens = previousInfo.outputTokens
    totalReasoningTokens = previousInfo.reasoningTokens
    totalCost = previousInfo.cost
    actualUsageTokens = previousInfo.actualUsageTokens
  }

  const instanceProviders = providers().get(instanceId) || []

  const sessionModel = session.model
  const sessionProviderId = sessionModel?.providerId
  const sessionModelId = sessionModel?.modelId

  const latestInfo = latestEntry?.messageId ? store.getMessageInfo(latestEntry.messageId) : undefined
  const latestProviderId = (latestInfo as any)?.providerID || (latestInfo as any)?.providerId || ""
  const latestModelId = (latestInfo as any)?.modelID || (latestInfo as any)?.modelId || ""

  const selectedModel =
    resolveSelectedModel(instanceProviders, sessionProviderId, sessionModelId) ??
    resolveSelectedModel(instanceProviders, latestProviderId, latestModelId)

  let modelOutputLimit = DEFAULT_MODEL_OUTPUT_LIMIT
  let modelInputLimit: number | null = null

  if (selectedModel) {
    contextWindow = selectedModel.limit?.context ?? 0
    const inputLimit = selectedModel.limit?.input
    if (typeof inputLimit === "number" && inputLimit > 0) {
      modelInputLimit = inputLimit
    }
    const outputLimit = selectedModel.limit?.output
    if (typeof outputLimit === "number" && outputLimit > 0) {
      modelOutputLimit = Math.min(outputLimit, DEFAULT_MODEL_OUTPUT_LIMIT)
    }
    if ((selectedModel.cost?.input ?? 0) === 0 && (selectedModel.cost?.output ?? 0) === 0) {
      isSubscriptionModel = true
    }
  }

  if (!selectedModel && contextWindow === 0 && previousInfo) {
    contextWindow = previousInfo.contextWindow
  }

  if (!selectedModel && previousInfo) {
    modelInputLimit = previousInfo.modelInputLimit
    modelOutputLimit = previousInfo.modelOutputLimit
    contextLimitTokens = previousInfo.contextLimitTokens
  }

  if (previousInfo) {
    if (!hasUsageEntries) {
      isSubscriptionModel = previousInfo.isSubscriptionModel
    } else if (!isSubscriptionModel) {
      isSubscriptionModel = previousInfo.isSubscriptionModel
    }
  }

  if (modelInputLimit !== null) {
    contextLimitTokens = contextWindow > 0 ? contextWindow : modelInputLimit
  } else if (contextWindow > 0) {
    contextLimitTokens = contextWindow
  }

  setSessionInfoByInstance((prev) => {
    const next = new Map(prev)
    const instanceInfo = new Map(prev.get(instanceId))
    instanceInfo.set(sessionId, {
      cost: totalCost,
      contextWindow,
      isSubscriptionModel,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      reasoningTokens: totalReasoningTokens,
      actualUsageTokens,
      modelOutputLimit,
      modelInputLimit,
      contextLimitTokens,
    })
    next.set(instanceId, instanceInfo)
    return next
  })

  updateThreadTotalsForSession(instanceId, sessionId)
}
