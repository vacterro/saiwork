import { createSignal } from "solid-js"

const [hasInstances, setHasInstances] = createSignal(false)
const [selectedFolder, setSelectedFolder] = createSignal<string | null>(null)
const [isSelectingFolder, setIsSelectingFolder] = createSignal(false)
const [showFolderSelection, setShowFolderSelection] = createSignal(false)

/**
 * SAIWORK panel visibility. Persisted so the layout the user left is the layout
 * they come back to -- a panel that silently reappears is the same surprise as
 * one that silently vanishes.
 */
const SAIPEN_BAR_KEY = "saiwork.saipen-bar.visible"
const SHORTCUTS_OVERLAY_KEY = "saiwork.shortcuts-overlay.visible"
const QUEUE_PANEL_KEY = "saiwork.queue-panel.visible"

function readPersistedFlag(key: string, fallback: boolean): boolean {
  if (typeof localStorage === "undefined") return fallback
  const raw = localStorage.getItem(key)
  if (raw === null) return fallback
  return raw === "true"
}

function writePersistedFlag(key: string, value: boolean) {
  if (typeof localStorage === "undefined") return
  localStorage.setItem(key, String(value))
}

const [showSaipenBar, setShowSaipenBarSignal] = createSignal(readPersistedFlag(SAIPEN_BAR_KEY, true))

function setShowSaipenBar(value: boolean) {
  setShowSaipenBarSignal(value)
  writePersistedFlag(SAIPEN_BAR_KEY, value)
}

function toggleSaipenBar() {
  setShowSaipenBar(!showSaipenBar())
}

const [showShortcutsOverlay, setShowShortcutsOverlay] = createSignal(false)

function toggleShortcutsOverlay() {
  setShowShortcutsOverlay(!showShortcutsOverlay())
}

/** Whether the queue panel is visible above the prompt input. */
const [showQueuePanel, setShowQueuePanelSignal] = createSignal(readPersistedFlag(QUEUE_PANEL_KEY, true))

function setShowQueuePanel(value: boolean) {
  setShowQueuePanelSignal(value)
  writePersistedFlag(QUEUE_PANEL_KEY, value)
}

function toggleQueuePanel() {
  setShowQueuePanel(!showQueuePanel())
}

/**
 * Whether the queue panel body is expanded. Defaults to collapsed so automatic
 * enqueues (Goal Auto) never take height from the message list without the user
 * asking. Persisted so the layout the user left is the layout they return to.
 */
const QUEUE_PANEL_EXPANDED_KEY = "saiwork.prompt-queue.expanded"

const [promptQueueExpanded, setPromptQueueExpandedSignal] = createSignal(
  readPersistedFlag(QUEUE_PANEL_EXPANDED_KEY, false),
)

function setPromptQueueExpanded(value: boolean) {
  setPromptQueueExpandedSignal(value)
  writePersistedFlag(QUEUE_PANEL_EXPANDED_KEY, value)
}

const [instanceTabOrder, setInstanceTabOrder] = createSignal<string[]>([])
const [sessionTabOrder, setSessionTabOrder] = createSignal<Map<string, string[]>>(new Map())

/**
 * Global "sessions sidebar" visibility toggle (Alt+D). The left drawer state
 * lives per-shell in useDrawerChrome; this signal lets a global shortcut hide
 * or reveal the sessions sidebar across any active shell. True = visible.
 */
const SESSION_SIDEBAR_KEY = "saiwork.session-sidebar.visible"
const [sessionSidebarVisible, setSessionSidebarVisibleSignal] = createSignal(
  readPersistedFlag(SESSION_SIDEBAR_KEY, true),
)

function setSessionSidebarVisible(value: boolean) {
  setSessionSidebarVisibleSignal(value)
  writePersistedFlag(SESSION_SIDEBAR_KEY, value)
}

function toggleSessionSidebar() {
  setSessionSidebarVisible(!sessionSidebarVisible())
}

function reorderInstanceTabs(newOrder: string[]) {
  setInstanceTabOrder(newOrder)
}

function reorderSessionTabs(instanceId: string, newOrder: string[]) {
  setSessionTabOrder((prev) => {
    const next = new Map(prev)
    next.set(instanceId, newOrder)
    return next
  })
}

export {
  hasInstances,
  setHasInstances,
  selectedFolder,
  setSelectedFolder,
  isSelectingFolder,
  setIsSelectingFolder,
  showFolderSelection,
  setShowFolderSelection,
  instanceTabOrder,
  setInstanceTabOrder,
  sessionTabOrder,
  setSessionTabOrder,
  reorderInstanceTabs,
  reorderSessionTabs,
  sessionSidebarVisible,
  setSessionSidebarVisible,
  toggleSessionSidebar,
  showSaipenBar,
  setShowSaipenBar,
  toggleSaipenBar,
  showQueuePanel,
  setShowQueuePanel,
  toggleQueuePanel,
  showShortcutsOverlay,
  setShowShortcutsOverlay,
  toggleShortcutsOverlay,
  promptQueueExpanded,
  setPromptQueueExpanded,
}
