import type { Pane } from "../lib/panes"
import { readSessionPaneRoute } from "../lib/runtime-env"
import { detachPaneAt, panesForInstance, restorePaneAt } from "./panes"

export interface SessionPaneWindowPayload {
  ownerInstanceId: string
  paneId: string
  instanceId: string
  sessionId: string
}

export type SessionPaneWindowNotice = SessionPaneWindowPayload & {
  state: "detached" | "recover"
}

interface SessionPaneWindowAPI {
  openSessionPane?(payload: SessionPaneWindowPayload): Promise<{ ok: boolean }>
  reattachSessionPane?(payload: SessionPaneWindowPayload): Promise<{ ok: boolean }>
  sessionPaneOwnerAck?(payload: SessionPaneWindowPayload): Promise<{ ok: boolean }>
}

const recoveryGenerations = new Map<string, number>()
const recoveredPanes = new Map<string, SessionPaneWindowPayload>()

function ownerPaneKey(ownerInstanceId: string, paneId: string): string {
  return JSON.stringify([ownerInstanceId, paneId])
}

function payloadKey(payload: SessionPaneWindowPayload): string {
  return JSON.stringify([payload.ownerInstanceId, payload.paneId, payload.instanceId, payload.sessionId])
}

function currentAPI(): SessionPaneWindowAPI | undefined {
  return (globalThis as unknown as { electronAPI?: SessionPaneWindowAPI }).electronAPI
}

function paneStillMatches(payload: SessionPaneWindowPayload): boolean {
  return Boolean(panesForInstance(payload.ownerInstanceId)?.panes.some((pane) =>
    pane.id === payload.paneId
    && pane.instanceId === payload.instanceId
    && pane.sessionId === payload.sessionId,
  ))
}

export async function detachPaneToWindow(
  ownerInstanceId: string,
  pane: Pick<Pane, "id" | "instanceId" | "sessionId">,
  api = currentAPI(),
): Promise<boolean> {
  const payload: SessionPaneWindowPayload = {
    ownerInstanceId,
    paneId: pane.id,
    instanceId: pane.instanceId,
    sessionId: pane.sessionId,
  }
  if (!api?.openSessionPane) return false
  const key = payloadKey(payload)
  const recoveryGeneration = recoveryGenerations.get(key) ?? 0

  try {
    const result = await api.openSessionPane(payload)
    if (!result.ok) return false
    if ((recoveryGenerations.get(key) ?? 0) !== recoveryGeneration) return false
    if (!paneStillMatches(payload)) {
      await api.reattachSessionPane?.(payload)
      return false
    }
    detachPaneAt(ownerInstanceId, pane.id)
    return true
  } catch {
    return false
  }
}

export function recoverPaneFromWindow(payload: SessionPaneWindowNotice): boolean {
  const key = payloadKey(payload)
  recoveryGenerations.set(key, (recoveryGenerations.get(key) ?? 0) + 1)
  const existing = panesForInstance(payload.ownerInstanceId)?.panes.find((pane) => pane.id === payload.paneId)
  if (existing && (existing.instanceId !== payload.instanceId || existing.sessionId !== payload.sessionId)) return false
  const recoveryKey = ownerPaneKey(payload.ownerInstanceId, payload.paneId)
  if (payload.state === "recover") recoveredPanes.set(recoveryKey, payload)
  else recoveredPanes.delete(recoveryKey)
  restorePaneAt(payload.ownerInstanceId, {
    id: payload.paneId,
    instanceId: payload.instanceId,
    sessionId: payload.sessionId,
  }, payload.state === "detached")
  return true
}

/** Clears main-process recovery only when the user explicitly closes the pane. */
export async function resolveRecoveredPane(
  ownerInstanceId: string,
  paneId: string,
  api = currentAPI(),
): Promise<boolean> {
  const key = ownerPaneKey(ownerInstanceId, paneId)
  const payload = recoveredPanes.get(key)
  if (!payload) return true
  if (!api?.sessionPaneOwnerAck) return false
  try {
    const result = await api.sessionPaneOwnerAck(payload)
    if (result.ok) recoveredPanes.delete(key)
    return result.ok
  } catch {
    return false
  }
}

export async function reattachSessionPane(
  payload: SessionPaneWindowPayload,
  api = currentAPI(),
): Promise<boolean> {
  if (!api?.reattachSessionPane) return false
  try {
    const result = await api.reattachSessionPane(payload)
    return result.ok
  } catch {
    return false
  }
}

export async function reattachCurrentSessionPane(api = currentAPI()): Promise<boolean> {
  const route = readSessionPaneRoute()
  if (!api?.reattachSessionPane || !route.ownerInstanceId || !route.paneId || !route.instanceId || !route.sessionId) {
    return false
  }
  return reattachSessionPane({
    ownerInstanceId: route.ownerInstanceId,
    paneId: route.paneId,
    instanceId: route.instanceId,
    sessionId: route.sessionId,
  }, api)
}
