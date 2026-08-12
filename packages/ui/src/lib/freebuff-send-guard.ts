import { tGlobal } from "./i18n"
import { freebuffThreads, freebuffQuota } from "../stores/freebuff"
import { getActiveSession } from "../stores/session-state"
import { showConfirmDialog } from "../stores/alerts"
import { messageStoreBus } from "../stores/message-v2/bus"
import {
  antigravityAvailabilityFrom,
  antigravityQuotaModels,
  ensureAntigravityQuota,
  freebuffAvailabilityFrom,
  type ModelAvailability,
} from "../stores/model-quota"

/**
 * Guard for FreeBuff's one-tab rule.
 *
 * FreeBuff allows a single hosted tab per network. Opening a NEW FreeBuff
 * conversation (a dialog that never produced a FreeBuff message yet) while
 * another FreeBuff tab is still open would silently steal that tab's slot.
 * Before that happens, ask the user to confirm switching: close the current
 * tab and start a fresh FreeBuff session here. Automation (Goal Auto) is not
 * guarded -- it goes through the queue and the server-side slot freeing.
 */

export interface FreebuffModelLike {
  providerId?: string
  modelId?: string
}

function providerOf(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined
  const record = message as { info?: { providerID?: string } | null; providerID?: string }
  return record.info?.providerID ?? record.providerID
}

export function sessionHasFreebuffMessage(messages: ReadonlyArray<unknown>): boolean {
  return messages.some((message) => providerOf(message) === "freebuff")
}

export function isNewFreebuffConversationSend(
  model: FreebuffModelLike | null | undefined,
  readMessages: () => ReadonlyArray<unknown>,
): boolean {
  if (model?.providerId !== "freebuff") return false
  return !sessionHasFreebuffMessage(readMessages())
}

/**
 * Returns true when the send may proceed. False means the user declined the
 * tab switch, and the caller must keep the draft text without enqueuing.
 */
export async function confirmFreebuffTabSwitch(
  instanceId: string,
  sessionId: string,
  model?: FreebuffModelLike,
): Promise<boolean> {
  const resolved = model ?? getActiveSession(instanceId)?.model ?? null
  const store = messageStoreBus.getInstance(instanceId)
  const readMessages = () => {
    if (!store) return []
    return store.getSessionMessageIds(sessionId)
      .map((id) => store.state.messages[id])
      .filter((message) => Boolean(message))
  }
  if (!isNewFreebuffConversationSend(resolved, readMessages)) return true
  if (!freebuffThreads().some((thread) => thread.status === "open")) return true

  return showConfirmDialog(tGlobal("freebuff.switchDialog.message"), {
    title: tGlobal("freebuff.switchDialog.title"),
    variant: "warning",
    confirmLabel: tGlobal("freebuff.switchDialog.confirm"),
    cancelLabel: tGlobal("freebuff.switchDialog.cancel"),
  })
}

function modelAvailabilityFor(model: FreebuffModelLike): ModelAvailability {
  if (model.providerId === "freebuff") {
    return freebuffAvailabilityFrom(freebuffQuota(), model.modelId ?? "")
  }
  if (model.providerId === "google_antigravity") {
    return antigravityAvailabilityFrom(antigravityQuotaModels(), model.modelId ?? "")
  }
  return { usable: true, known: false, exhausted: false }
}

async function modelAvailabilityFresh(model: FreebuffModelLike): Promise<ModelAvailability> {
  if (model.providerId === "google_antigravity") {
    await ensureAntigravityQuota()
  }
  return modelAvailabilityFor(model)
}

/**
 * True when the active session's model has exhausted its daily quota (FreeBuff
 * or Antigravity). Used to stop Goal Auto from continuing into a quota error.
 */
export async function modelQuotaBlocksSession(instanceId: string, sessionId: string): Promise<boolean> {
  const model = getActiveSession(instanceId)?.model ?? null
  if (!model) return false
  if (model.providerId !== "freebuff" && model.providerId !== "google_antigravity") return false
  const availability = await modelAvailabilityFresh(model)
  return availability.exhausted
}

/**
 * Synchronous variant for reactive effects: reads the current store signals
 * (FreeBuff quota is live; Antigravity is only known once fetched). Safe to
 * call inside a Solid effect; re-runs when the quota signals change.
 */
export function modelQuotaBlockedNow(instanceId: string): boolean {
  const model = getActiveSession(instanceId)?.model ?? null
  if (!model) return false
  if (model.providerId !== "freebuff" && model.providerId !== "google_antigravity") return false
  return modelAvailabilityFor(model).exhausted
}

/**
 * Combined guard for a manual send: (1) the FreeBuff one-tab switch, then
 * (2) an exhausted daily quota reminder for FreeBuff/Antigravity. Returns true
 * when the send may proceed. The quota reminder offers "Send anyway" (the quota
 * data may be stale), so declining keeps the draft text untouched.
 */
export async function confirmModelSend(
  instanceId: string,
  sessionId: string,
  model?: FreebuffModelLike,
): Promise<boolean> {
  if (!(await confirmFreebuffTabSwitch(instanceId, sessionId, model))) return false

  const resolved = model ?? getActiveSession(instanceId)?.model ?? null
  if (!resolved) return true
  if (resolved.providerId !== "freebuff" && resolved.providerId !== "google_antigravity") return true

  const availability = await modelAvailabilityFresh(resolved)
  if (!availability.exhausted) return true

  const reset = availability.resetAt
    ? new Date(availability.resetAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "—"
  return showConfirmDialog(tGlobal("modelQuota.sendBlocked.message", { time: reset }), {
    title: tGlobal("modelQuota.sendBlocked.title", { model: resolved.modelId }),
    variant: "warning",
    confirmLabel: tGlobal("modelQuota.sendBlocked.confirm"),
    cancelLabel: tGlobal("modelQuota.sendBlocked.cancel"),
  })
}
