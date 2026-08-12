import { tGlobal } from "./i18n"
import { freebuffThreads } from "../stores/freebuff"
import { getActiveSession } from "../stores/session-state"
import { showConfirmDialog } from "../stores/alerts"
import { messageStoreBus } from "../stores/message-v2/bus"

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
