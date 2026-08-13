import { createEffect, createMemo, createSignal } from "solid-js"
import type { Instance } from "../types/instance"
import { activeInstanceId, claimRestoreCreatedInstanceForUser, instances, setActiveInstanceId } from "./instances"
import { activeSidecarToken, setActiveSidecarToken, sidecarTabs, type SideCarTabRecord } from "./sidecars"
import { sessions } from "./session-state"
import { appSessionRestoreGateActive } from "./app-session-restore-gate"

export interface InstanceAppTab {
  id: string
  kind: "instance"
  instance: Instance
}

export interface SideCarAppTab {
  id: string
  kind: "sidecar"
  sidecarTab: SideCarTabRecord
}

export type AppTabRecord = InstanceAppTab | SideCarAppTab

function getInstanceAppTabId(instanceId: string): string {
  return `instance:${instanceId}`
}

function getSidecarAppTabId(token: string): string {
  return `sidecar:${token}`
}

function getAdjacentAppTabId(tabId: string): string | null {
  const tabs = appTabs()
  const index = tabs.findIndex((tab) => tab.id === tabId)
  if (index < 0) return activeAppTabId()
  return tabs[index - 1]?.id ?? tabs[index + 1]?.id ?? null
}

function getPreferredTabId(): string | null {
  const sidecarToken = activeSidecarToken()
  if (sidecarToken) {
    return getSidecarAppTabId(sidecarToken)
  }

  const instanceId = activeInstanceId()
  if (instanceId) {
    return getInstanceAppTabId(instanceId)
  }

  return null
}

const [activeAppTabId, setActiveAppTabId] = createSignal<string | null>(null)
const [tabOrder, setTabOrder] = createSignal<string[]>([])
const [appTabSelectionRevision, setAppTabSelectionRevision] = createSignal(0)
const [appTabOrderRevision, setAppTabOrderRevision] = createSignal(0)

/**
 * Per-instance "is work happening and when did it stop" derived from session
 * statuses. A session is working/compacting while a turn runs; `idleSince` is
 * the wall-clock moment it finished.
 */
function instanceWorkingInfo(instanceId: string): { working: boolean; lastStoppedAt: number | null } {
  const instanceSessions = sessions().get(instanceId)
  if (!instanceSessions) return { working: false, lastStoppedAt: null }
  let working = false
  let lastStoppedAt: number | null = null
  for (const session of instanceSessions.values()) {
    if (session.status === "working" || session.status === "compacting") working = true
    const stopped = typeof session.idleSince === "number" ? session.idleSince : null
    if (stopped !== null && (lastStoppedAt === null || stopped > lastStoppedAt)) lastStoppedAt = stopped
  }
  return { working, lastStoppedAt }
}

/** When each tab's work most recently STARTED; drives the working-first order. */
const becameWorkingAt = new Map<string, number>()

createEffect(() => {
  const now = Date.now()
  for (const instanceId of instances().keys()) {
    const tabId = getInstanceAppTabId(instanceId)
    if (instanceWorkingInfo(instanceId).working) {
      if (!becameWorkingAt.has(tabId)) becameWorkingAt.set(tabId, now)
    } else {
      becameWorkingAt.delete(tabId)
    }
  }
})

function rememberTabOrder(tabId: string) {
  setTabOrder((prev) => (prev.includes(tabId) ? prev : [...prev, tabId]))
}

/**
 * Pure ordering for the working-first tab bar: working tabs to the left (most
 * recently started working first), then idle tabs by most recently stopped
 * working; original index breaks ties (stable).
 */
export function rankWorkingFirst<T>(
  ordered: T[],
  infoOf: (tab: T) => { working: boolean; lastStoppedAt: number | null } | null,
  becameWorkingAt: (tab: T) => number,
  idOf: (tab: T) => string,
): T[] {
  const index = new Map<T, number>(ordered.map((tab, i) => [tab, i]))
  return [...ordered].sort((a, b) => {
    const infoA = infoOf(a)
    const infoB = infoOf(b)
    const workingA = Boolean(infoA?.working)
    const workingB = Boolean(infoB?.working)
    if (workingA !== workingB) return workingA ? -1 : 1
    const tsA = workingA ? becameWorkingAt(a) : (infoA?.lastStoppedAt ?? 0)
    const tsB = workingB ? becameWorkingAt(b) : (infoB?.lastStoppedAt ?? 0)
    if (tsB !== tsA) return tsB - tsA
    return (index.get(a) ?? 0) - (index.get(b) ?? 0)
  })
}

const appTabs = createMemo<AppTabRecord[]>(() => {
  const currentTabs = [
    ...Array.from(instances().values()).map((instance) => ({
      id: getInstanceAppTabId(instance.id),
      kind: "instance" as const,
      instance,
    })),
    ...sidecarTabs().map((sidecarTab) => ({
      id: getSidecarAppTabId(sidecarTab.token),
      kind: "sidecar" as const,
      sidecarTab,
    })),
  ]

  const tabsById = new Map(currentTabs.map((tab) => [tab.id, tab]))
  const orderedIds = tabOrder().filter((tabId) => tabsById.has(tabId))
  const missingIds = currentTabs.map((tab) => tab.id).filter((tabId) => !orderedIds.includes(tabId))
  const ordered = [...orderedIds, ...missingIds].map((tabId) => tabsById.get(tabId)!).filter(Boolean)

  // Working tabs move LEFT so it is visible which project last started work;
  // idle tabs follow ordered by most recently stopped (newest-stopped closest
  // to the front). Drag order breaks ties (stable).
  return rankWorkingFirst(
    ordered,
    (tab) => (tab.kind === "instance" ? instanceWorkingInfo(tab.instance.id) : null),
    (tab) => becameWorkingAt.get(tab.id) ?? 0,
    (tab) => tab.id,
  )
})

const activeAppTab = createMemo(() => appTabs().find((tab) => tab.id === activeAppTabId()) ?? null)

function getAppTabById(tabId: string | null): AppTabRecord | null {
  if (!tabId) return null
  return appTabs().find((tab) => tab.id === tabId) ?? null
}

function selectAppTab(tabId: string | null, options?: { source?: "restore" }) {
  if (options?.source !== "restore") setAppTabSelectionRevision((revision) => revision + 1)
  if (!tabId) {
    setActiveAppTabId(null)
    setActiveSidecarToken(null)
    return
  }

  const tab = appTabs().find((entry) => entry.id === tabId)
  if (!tab) return

  rememberTabOrder(tab.id)
  setActiveAppTabId(tab.id)

  if (tab.kind === "instance") {
    if (options?.source !== "restore") claimRestoreCreatedInstanceForUser(tab.instance.id)
    setActiveSidecarToken(null)
    setActiveInstanceId(tab.instance.id)
    return
  }

  setActiveInstanceId(null)
  setActiveSidecarToken(tab.sidecarTab.token)
}

function selectInstanceTab(instanceId: string) {
  selectAppTab(getInstanceAppTabId(instanceId))
}

function selectSidecarTab(token: string) {
  selectAppTab(getSidecarAppTabId(token))
}

function moveAppTab(tabId: string, targetTabId: string, placement: "before" | "after") {
  if (tabId === targetTabId) return

  const tabs = appTabs()
  const ids = tabs.map((tab) => tab.id)
  if (!ids.includes(tabId) || !ids.includes(targetTabId)) return

  const reorderedIds = ids.filter((id) => id !== tabId)
  const targetIndex = reorderedIds.indexOf(targetTabId)
  if (targetIndex < 0) return

  reorderedIds.splice(placement === "after" ? targetIndex + 1 : targetIndex, 0, tabId)
  setTabOrder(reorderedIds)
  setAppTabOrderRevision((revision) => revision + 1)
}

function markAppTabUserInteraction() {
  setAppTabSelectionRevision((revision) => revision + 1)
  setAppTabOrderRevision((revision) => revision + 1)
}

function setAppTabOrder(tabIds: string[]) {
  const availableIds = appTabs().map((tab) => tab.id)
  const available = new Set(availableIds)
  const seen = new Set<string>()
  const orderedIds: string[] = []

  for (const tabId of tabIds) {
    if (!available.has(tabId) || seen.has(tabId)) continue
    seen.add(tabId)
    orderedIds.push(tabId)
  }
  for (const tabId of availableIds) {
    if (seen.has(tabId)) continue
    orderedIds.push(tabId)
  }

  setTabOrder(orderedIds)
}

function selectNextAppTab() {
  const tabs = appTabs()
  if (tabs.length <= 1) return

  const current = tabs.findIndex((tab) => tab.id === activeAppTabId())
  const nextIndex = current < 0 ? 0 : (current + 1) % tabs.length
  const nextTab = tabs[nextIndex]
  if (nextTab) selectAppTab(nextTab.id)
}

function selectPreviousAppTab() {
  const tabs = appTabs()
  if (tabs.length <= 1) return

  const current = tabs.findIndex((tab) => tab.id === activeAppTabId())
  const previousIndex = current <= 0 ? tabs.length - 1 : current - 1
  const previousTab = tabs[previousIndex]
  if (previousTab) selectAppTab(previousTab.id)
}

function selectAppTabByIndex(index: number) {
  const tab = appTabs()[index]
  if (tab) selectAppTab(tab.id)
}

function ensureActiveAppTab(preferredTabId?: string | null) {
  if (appSessionRestoreGateActive()) return
  const tabs = appTabs()
  const current = activeAppTabId()

  if (current && tabs.some((tab) => tab.id === current)) {
    return
  }

  const candidateId = preferredTabId ?? getPreferredTabId()
  if (candidateId && tabs.some((tab) => tab.id === candidateId)) {
    selectAppTab(candidateId)
    return
  }

  selectAppTab(tabs[0]?.id ?? null)
}

export {
  activeAppTabId,
  appTabOrderRevision,
  appTabSelectionRevision,
  activeAppTab,
  appTabs,
  ensureActiveAppTab,
  getAdjacentAppTabId,
  getAppTabById,
  getInstanceAppTabId,
  getSidecarAppTabId,
  markAppTabUserInteraction,
  moveAppTab,
  setAppTabOrder,
  selectAppTab,
  selectAppTabByIndex,
  selectInstanceTab,
  selectNextAppTab,
  selectPreviousAppTab,
  selectSidecarTab,
}
