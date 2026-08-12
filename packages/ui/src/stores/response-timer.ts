import { createSignal } from "solid-js"

/**
 * Per-session response-start timestamps.
 *
 * The SAIPEN bar response timer must keep counting across tab switches. A
 * session-view unmounts when its tab is left and remounts on return; if the
 * start time lived only in the component, the timer would either reset to zero
 * (messages not yet hydrated) or be lost. This store keys the start time by
 * `instanceId::sessionId` and is reactive, so a remounted view immediately
 * shows the correct elapsed time for its own session.
 */

const starts = new Map<string, number>()
const [revision, setRevision] = createSignal(0)

export function responseTimerKey(instanceId: string, sessionId: string): string {
  return `${instanceId}::${sessionId}`
}

export function setResponseStartedAt(instanceId: string, sessionId: string, startedAt: number): void {
  const key = responseTimerKey(instanceId, sessionId)
  starts.set(key, startedAt)
  setRevision((value) => value + 1)
}

export function clearResponseStartedAt(instanceId: string, sessionId: string): void {
  const key = responseTimerKey(instanceId, sessionId)
  if (starts.delete(key)) setRevision((value) => value + 1)
}

export function getResponseStartedAt(instanceId: string, sessionId: string): number | null {
  return starts.get(responseTimerKey(instanceId, sessionId)) ?? null
}

/** Reactive read: re-runs when any start time changes. */
export function responseStartedAtSignal(instanceId: string, sessionId: string): () => number | null {
  return () => {
    revision()
    return starts.get(responseTimerKey(instanceId, sessionId)) ?? null
  }
}
