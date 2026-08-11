import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  type Accessor,
  type Component,
} from "solid-js"
import AppBar from "@suid/material/AppBar"
import Box from "@suid/material/Box"
import Drawer from "@suid/material/Drawer"
import IconButton from "@suid/material/IconButton"
import Toolbar from "@suid/material/Toolbar"
import useMediaQuery from "@suid/material/useMediaQuery"
import type { Instance } from "../../types/instance"
import type { Command } from "../../lib/commands"
import type { BackgroundProcess } from "../../../../server/src/api-types"
import { keyboardRegistry, type KeyboardShortcut } from "../../lib/keyboard-registry"

import { isOpen as isCommandPaletteOpen, hideCommandPalette, showCommandPalette } from "../../stores/command-palette"
import InstanceWelcomeView from "../instance-welcome-view"
import InfoView from "../info-view"
import CommandPalette from "../command-palette"
import PermissionNotificationBanner from "../permission-notification-banner"
import PermissionApprovalModal from "../permission-approval-modal"
import SessionView from "../session/session-view"
import SaipenBar from "../saipen-bar"
import SplitPicker from "../split-picker"
import { sessionSidebarVisible, setSessionSidebarVisible, showSaipenBar } from "../../stores/ui"
import {
  activatePane,
  closePaneAt,
  detachPaneAt,
  ensurePaneState,
  panesForInstance,
  splitPane,
} from "../../stores/panes"
import { visiblePanes } from "../../lib/panes"
import { buildSplitCandidates } from "../../lib/split-picker"
import { instances } from "../../stores/instances"
import { activeSessionId, sessions } from "../../stores/session-state"
import { isSessionPaneWindow } from "../../lib/runtime-env"
import MessageSection from "../message-section"
import PromptAttachmentsBar from "../prompt-input/PromptAttachmentsBar"
import ActionOverflowMenu, { type ActionOverflowMenuItem } from "../action-overflow-menu"
import { formatTokenTotal } from "../../lib/formatters"
import ContextMeter from "../context-meter"
import { sseManager } from "../../lib/sse-manager"
import { getLogger } from "../../lib/logger"
import { serverApi } from "../../lib/api-client"
import { loadBackgroundProcesses } from "../../stores/background-processes"
import { BackgroundProcessOutputDialog } from "../background-process-output-dialog"
import PromptInput from "../prompt-input"
import { useI18n } from "../../lib/i18n"
import { getPermissionQueueLength, getQuestionQueueLength } from "../../stores/instances"
import SessionSidebar from "./shell/SessionSidebar"
import { useSessionSidebarRequests } from "./shell/useSessionSidebarRequests"
import WorktreeSelector from "../worktree-selector"
import AgentSelector from "../agent-selector"
import ModelSelector from "../model-selector"
import ThinkingSelector from "../thinking-selector"
import RightPanel from "./shell/right-panel/RightPanel"
import { useDrawerChrome } from "./shell/useDrawerChrome"
import { getRetrySeconds, getSessionIdleFadeClass, getSessionRetry, getSessionStatus, shouldShowSessionStatus } from "../../stores/session-status"
import { Eye, Maximize2, MessageSquareText, PlusSquare, Search, ShieldAlert } from "lucide-solid"
import type { PromptInputApi } from "../prompt-input/types"
import type { Attachment } from "../../types/attachment"
import { setAgentModelPreference, useConfig } from "../../stores/preferences"
import { showPromptDialog } from "../../stores/alerts"
import { openSessionPreview, sessionPreviews, showSessionChat, showSessionPreview } from "../../stores/session-previews"
import { createSession, executeCustomCommand, getDefaultModel, providers, runShellCommand, sendMessage, setActiveParentSession, updateSessionModel } from "../../stores/sessions"
import { getAttachments, removeAttachment } from "../../stores/attachments"

import {
  DRAWER_INTERACTIVE_OVERLAY_SELECTOR,
  getSessionModeDrawerAction,
  isFloatingDrawerOpen,
  shouldDismissFloatingDrawer,
  type LayoutMode,
} from "./shell/types"
import {
  DEFAULT_SESSION_SIDEBAR_WIDTH,
  LEFT_DRAWER_STORAGE_KEY,
  RIGHT_DRAWER_STORAGE_KEY,
  RIGHT_DRAWER_WIDTH,
  clampRightWidth,
  clampWidth,
} from "./shell/storage"
import { useDrawerHostMeasure } from "./shell/useDrawerHostMeasure"
import { useDrawerResize } from "./shell/useDrawerResize"
import { useSessionCache } from "./shell/useSessionCache"
import { useInstanceSessionContext } from "./shell/useInstanceSessionContext"
import { isPermissionAutoAcceptEnabled } from "../../stores/permission-auto-accept"
import { readClientLayoutValue, writeClientLayoutValue } from "../../stores/client-state"
import { useNow } from "../../lib/hooks/use-now"

const log = getLogger("session")
const OPEN_SESSION_SEARCH_EVENT = "saiwork:open-session-search"
const NO_SESSION_DRAFT_SESSION_ID = "__no_session_draft__"
type SessionCenterWidthStep = "narrow" | "medium" | "wide"

function getSessionCenterWidthStep(width: number): SessionCenterWidthStep {
  if (width < 768) return "narrow"
  if (width < 1280) return "medium"
  return "wide"
}

interface InstanceShellProps {
  instance: Instance
  // Provided by App-level instance tabs; lets us pause heavy rendering
  // work for inactive instances while keeping them mounted for fast switching.
  isActiveInstance?: boolean
  escapeInDebounce: boolean
  paletteCommands: Accessor<Command[]>
  onCloseSession: (sessionId: string) => Promise<void> | void
  onNewSession: () => Promise<void> | void
  handleSidebarAgentChange: (sessionId: string, agent: string) => Promise<void>
  handleSidebarModelChange: (sessionId: string, model: { providerId: string; modelId: string }) => Promise<void>
  onExecuteCommand: (command: Command) => void
  tabBarOffset: number

  // In-memory only: mobile immersive/fullscreen mode.
  mobileFullscreenMode: boolean
  onEnterMobileFullscreen: () => void
  onExitMobileFullscreen: () => void
}

const InstanceShell2: Component<InstanceShellProps> = (props) => {
  const { t, locale } = useI18n()
  const { preferences } = useConfig()
  const isRTL = () => locale() === "he"

  const [sessionSidebarWidth, setSessionSidebarWidth] = createSignal(DEFAULT_SESSION_SIDEBAR_WIDTH)
  const [rightDrawerWidth, setRightDrawerWidth] = createSignal(
    typeof window !== "undefined" ? clampRightWidth(window.innerWidth * 0.35) : RIGHT_DRAWER_WIDTH,
  )
  const [rightDrawerWidthInitialized, setRightDrawerWidthInitialized] = createSignal(false)
  const [leftDrawerContentEl, setLeftDrawerContentEl] = createSignal<HTMLElement | null>(null)
  const [rightDrawerContentEl, setRightDrawerContentEl] = createSignal<HTMLElement | null>(null)
  const [leftToggleButtonEl, setLeftToggleButtonEl] = createSignal<HTMLElement | null>(null)
  const [rightToggleButtonEl, setRightToggleButtonEl] = createSignal<HTMLElement | null>(null)
  const [sessionCenterEl, setSessionCenterEl] = createSignal<HTMLElement | null>(null)
  const [sessionCenterWidthStep, setSessionCenterWidthStep] = createSignal<SessionCenterWidthStep>("wide")

  const [selectedBackgroundProcess, setSelectedBackgroundProcess] = createSignal<BackgroundProcess | null>(null)
  const [showBackgroundOutput, setShowBackgroundOutput] = createSignal(false)
  const [permissionModalOpen, setPermissionModalOpen] = createSignal(false)
  const now = useNow()
  const [sessionPromptApis, setSessionPromptApis] = createSignal<Record<string, PromptInputApi | null>>({})
  const [draftAgent, setDraftAgent] = createSignal("")
  const [draftModel, setDraftModel] = createSignal({ providerId: "", modelId: "" })
  const [draftModelManuallySelected, setDraftModelManuallySelected] = createSignal(false)
  const [draftPromptInputApi, setDraftPromptInputApi] = createSignal<PromptInputApi | null>(null)
  const [focusConversationSessionId, setFocusConversationSessionId] = createSignal<string | null>(null)

  // Worktree selector manages its own dialogs.
  const [showSessionSearch, setShowSessionSearch] = createSignal(false)

  const {
    allInstanceSessions,
    sessionThreads,
    activeSessions,
    activeSessionIdForInstance,
    activeSessionForInstance,
    latestTodoState,
    tokenStats,
    backgroundProcessList,
    handleSessionSelect,
  } = useInstanceSessionContext({
    instanceId: () => props.instance.id,
  })

  const showingInfoView = createMemo(() => activeSessionIdForInstance() === "info")
  /** Exactly one real session (the "info" pseudo-view is not a session). */
  const singleSessionMode = createMemo(() => !showingInfoView() && allInstanceSessions().size === 1)

  const desktopQuery = useMediaQuery("(min-width: 1280px)")

  const tabletQuery = useMediaQuery("(min-width: 768px)")
  const compactHeaderQuery = useMediaQuery("(max-width: 1024px)")

  const layoutMode = createMemo<LayoutMode>(() => {
    if (desktopQuery()) return "desktop"
    if (tabletQuery()) return "tablet"
    return "phone"
  })

  const isPhoneLayout = createMemo(() => layoutMode() === "phone")
  const narrowHeaderLayout = createMemo(() => sessionCenterWidthStep() === "narrow")
  const compactHeaderLayout = createMemo(() => narrowHeaderLayout() || compactHeaderQuery())
  const mobileFullscreen = createMemo(() => props.mobileFullscreenMode && isPhoneLayout())
  const showCompactFullscreenButton = createMemo(() => isPhoneLayout() && !props.mobileFullscreenMode)
  const compactPromptLayout = createMemo(() => layoutMode() !== "desktop")
  const leftPinningSupported = createMemo(() => layoutMode() !== "phone")
  const rightPinningSupported = createMemo(() => layoutMode() !== "phone")

  const { setDrawerHost, measureDrawerHost, floatingTopPx, floatingHeight } = useDrawerHostMeasure(
    () => props.tabBarOffset,
  )

  const drawerChrome = useDrawerChrome({
    t,
    active: () => Boolean(props.isActiveInstance),
    layoutMode,
    leftPinningSupported,
    leftForceFloating: singleSessionMode,
    rightPinningSupported,
    leftDrawerContentEl,
    rightDrawerContentEl,
    leftToggleButtonEl,
    rightToggleButtonEl,
    measureDrawerHost,
    onLeftClose: () => setSessionSidebarVisible(false),
  })

  const {
    leftPinned,
    leftOpen,
    rightPinned,
    rightOpen,
    setLeftOpen,
    setRightOpen,
    leftDrawerState,
    rightDrawerState,
    pinLeft: pinLeftDrawer,
    unpinLeft: unpinLeftDrawer,
    pinRight: pinRightDrawer,
    unpinRight: unpinRightDrawer,
    closeLeft: closeLeftDrawer,
    closeRight: closeRightDrawer,
    resetLeftDrawerLocally,
    closeFloatingDrawersIfAny,
    leftAppBarButtonLabel,
    rightAppBarButtonLabel,
    leftAppBarButtonIcon,
    rightAppBarButtonIcon,
    handleLeftAppBarButtonClick,
    handleRightAppBarButtonClick,
  } = drawerChrome

  // Alt+D (session-sidebar-toggle) shows/hides the sessions sidebar across any
  // active shell. Hidden = unpinned + closed; shown = drawer open (floating).
  // The initial run is skipped so it cannot fight the persisted pin/restore.
  createEffect(on(sessionSidebarVisible, (visible) => {
    if (!props.isActiveInstance) return
    if (visible) {
      if (leftPinned()) unpinLeftDrawer()
      if (!leftOpen()) setLeftOpen(true)
    } else {
      if (leftPinned()) unpinLeftDrawer()
      if (leftOpen()) setLeftOpen(false)
    }
  }, { defer: true }))

  const closeSessionSidebar = () => {
    setSessionSidebarVisible(false)
    if (leftPinned()) unpinLeftDrawer()
    closeLeftDrawer()
  }

  const handleFloatingDrawerSessionSelect = (sessionId: string) => {
    handleSessionSelect(sessionId)
    closeSessionSidebar()
  }

  const handleFloatingDrawerNewSession = () => {
    try {
      return props.onNewSession()
    } finally {
      closeSessionSidebar()
    }
  }

  let previousSingleSessionMode = singleSessionMode()
  createEffect(() => {
    const currentSingleSessionMode = singleSessionMode()
    const action = getSessionModeDrawerAction({
      active: Boolean(props.isActiveInstance),
      open: leftOpen(),
      pinned: leftPinned(),
      previousSingleSessionMode,
      currentSingleSessionMode,
    })
    if (action === "close") closeSessionSidebar()
    else if (action === "reset-local") resetLeftDrawerLocally()
    previousSingleSessionMode = currentSingleSessionMode
  })

  let previousActiveSessionId = activeSessionIdForInstance()
  createEffect(() => {
    const currentActiveSessionId = activeSessionIdForInstance()
    if (
      currentActiveSessionId !== previousActiveSessionId
      && props.isActiveInstance
      && isFloatingDrawerOpen(leftOpen(), leftPinned(), singleSessionMode())
    ) {
      closeSessionSidebar()
    }
    previousActiveSessionId = currentActiveSessionId
  })

  // When the user switches away from this instance (e.g., taps a different
  // instance/project tab while a floating drawer is open on phone), close any
  // open floating drawers so the previous instance's drawer doesn't remain
  // visually or interactively open when its tab regains focus later.
  let wasActiveInstance = Boolean(props.isActiveInstance)
  createEffect(() => {
    const isActive = Boolean(props.isActiveInstance)
    if (wasActiveInstance && !isActive) {
      if (isFloatingDrawerOpen(leftOpen(), leftPinned(), singleSessionMode())) {
        closeSessionSidebar()
      }
      closeFloatingDrawersIfAny()
    }
    if (!isActive) {
      if (isFloatingDrawerOpen(leftOpen(), leftPinned(), singleSessionMode())) setLeftOpen(false)
      if (isFloatingDrawerOpen(rightOpen(), rightPinned())) setRightOpen(false)
    }
    wasActiveInstance = isActive
  })

  onMount(() => {
    if (typeof document === "undefined") return

    const handleFloatingDrawerPointerDown = (event: PointerEvent) => {
      if (!props.isActiveInstance) return

      const target = event.target
      if (!(target instanceof Node)) return

      const leftContent = leftDrawerContentEl()
      const rightContent = rightDrawerContentEl()
      const leftPaper = leftContent?.closest(".MuiDrawer-paper")
      const rightPaper = rightContent?.closest(".MuiDrawer-paper")
      const targetInsideDrawer = Boolean(leftPaper?.contains(target) || rightPaper?.contains(target))
      const targetElement = target instanceof Element ? target : target.parentElement
      const targetInsideOverlay = Boolean(targetElement?.closest(DRAWER_INTERACTIVE_OVERLAY_SELECTOR))
      const dismissLeft = shouldDismissFloatingDrawer({
        open: leftOpen(),
        pinned: leftPinned(),
        forceFloating: singleSessionMode(),
        targetInsideDrawer,
        targetInsideOverlay,
      })
      const dismissRight = shouldDismissFloatingDrawer({
        open: rightOpen(),
        pinned: rightPinned(),
        targetInsideDrawer,
        targetInsideOverlay,
      })

      if (dismissLeft) closeSessionSidebar()
      if (dismissRight) closeRightDrawer()
    }

    document.addEventListener("pointerdown", handleFloatingDrawerPointerDown, true)
    onCleanup(() => document.removeEventListener("pointerdown", handleFloatingDrawerPointerDown, true))
  })

  createEffect(() => {
    const instanceId = props.instance.id
    loadBackgroundProcesses(instanceId).catch((error) => {
      log.warn("Failed to load background processes", error)
    })
  })

  onMount(() => {
    if (typeof window === "undefined") return

    const savedLeft = readClientLayoutValue(LEFT_DRAWER_STORAGE_KEY)
    if (savedLeft) {
      const parsed = Number.parseInt(savedLeft, 10)
      if (Number.isFinite(parsed)) {
        setSessionSidebarWidth(clampWidth(parsed))
      }
    }

    let didLoadRightWidth = false
    const savedRight = readClientLayoutValue(RIGHT_DRAWER_STORAGE_KEY)
    if (savedRight) {
      const parsed = Number.parseInt(savedRight, 10)
      if (Number.isFinite(parsed)) {
        setRightDrawerWidth(clampRightWidth(parsed))
        didLoadRightWidth = true
      }
    }

    if (!didLoadRightWidth) {
      setRightDrawerWidth(clampRightWidth(window.innerWidth * 0.35))
    }

    setRightDrawerWidthInitialized(true)

    const handleResize = () => {
      const width = clampWidth(window.innerWidth * 0.3)
      setSessionSidebarWidth((current) => clampWidth(current || width))
      const fallbackRight = window.innerWidth * 0.35
      setRightDrawerWidth((current) => clampRightWidth(current || fallbackRight))
      measureDrawerHost()
    }

    handleResize()
    window.addEventListener("resize", handleResize)
    onCleanup(() => window.removeEventListener("resize", handleResize))
  })

  createEffect(() => {
    writeClientLayoutValue(LEFT_DRAWER_STORAGE_KEY, sessionSidebarWidth().toString())
  })

  createEffect(() => {
    writeClientLayoutValue(RIGHT_DRAWER_STORAGE_KEY, rightDrawerWidth().toString())
  })

  createEffect(() => {
    const element = sessionCenterEl()
    if (!element || typeof ResizeObserver === "undefined") return

    const updateWidthStep = (width: number) => {
      setSessionCenterWidthStep(getSessionCenterWidthStep(width))
    }

    updateWidthStep(element.getBoundingClientRect().width)

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? element.getBoundingClientRect().width
      updateWidthStep(width)
    })
    observer.observe(element)

    onCleanup(() => observer.disconnect())
  })

  const connectionStatus = () => sseManager.getStatus(props.instance.id)
  const connectionStatusClass = () => {
    const status = connectionStatus()
    if (status === "connecting") return "connecting"
    if (status === "connected") return "connected"
    return "disconnected"
  }

  const connectionStatusLabel = () => {
    const status = connectionStatus()
    if (status === "connected") return t("instanceShell.connection.connected")
    if (status === "connecting") return t("instanceShell.connection.connecting")
    if (status === "error" || status === "disconnected") return t("instanceShell.connection.disconnected")
    return t("instanceShell.connection.unknown")
  }

  const hasPendingRequests = createMemo(() => {
    const permissions = getPermissionQueueLength(props.instance.id)
    const questions = getQuestionQueueLength(props.instance.id)
    return permissions + questions > 0
  })

  const activePromptInputApi = createMemo(() => {
    const sessionId = activeSessionIdForInstance()
    if (!sessionId || sessionId === "info") return null
    return sessionPromptApis()[sessionId] ?? null
  })

  const activeSessionPreview = createMemo(() => {
    const sessionId = activeSessionIdForInstance()
    return sessionId ? sessionPreviews().get(sessionId) ?? null : null
  })

  const registerSessionPromptApi = (sessionId: string, api: PromptInputApi | null) => {
    setSessionPromptApis((current) => ({
      ...current,
      [sessionId]: api,
    }))
  }

  async function handleOpenPreview() {
    const sessionId = activeSessionIdForInstance()
    if (!sessionId || sessionId === "info") return

    const url = await showPromptDialog(t("sessionPreview.open.prompt"), {
      title: t("sessionPreview.open.title"),
      inputLabel: t("sessionPreview.open.label"),
      inputPlaceholder: t("sessionPreview.open.placeholder"),
      confirmLabel: t("sessionPreview.open.confirm"),
      cancelLabel: t("sessionPreview.open.cancel"),
    })
    const normalized = url?.trim()
    if (!normalized) return
    await openSessionPreview(sessionId, normalized)
  }

  function handleShowPreview() {
    const sessionId = activeSessionIdForInstance()
    if (!sessionId || sessionId === "info") return
    showSessionPreview(sessionId)
  }

  function handlePreviewButtonClick() {
    const sessionId = activeSessionIdForInstance()
    if (!sessionId || sessionId === "info") return

    const preview = activeSessionPreview()
    if (preview?.mode === "preview") {
      showSessionChat(sessionId)
      return
    }

    if (preview) {
      showSessionPreview(sessionId)
      return
    }
    void handleOpenPreview()
  }

  const previewToggleLabel = createMemo(() => {
    const preview = activeSessionPreview()
    return preview?.mode === "preview" ? t("sessionPreview.chat.button") : t("sessionPreview.open.button")
  })

  const PreviewToggleIcon = createMemo(() => activeSessionPreview()?.mode === "preview" ? MessageSquareText : Eye)

  const yoloModeEnabled = createMemo(() => {
    const session = activeSessionForInstance()
    if (!session) return false
    return isPermissionAutoAcceptEnabled(props.instance.id, session.id)
  })

  const activeSessionStatusPill = createMemo(() => {
    const activeSessionId = activeSessionIdForInstance()
    if (!activeSessionId || activeSessionId === "info") return null

    const activeSession = activeSessionForInstance()
    const needsPermission = Boolean(activeSession?.pendingPermission)
    const needsQuestion = Boolean(activeSession?.pendingQuestion)
    const needsInput = needsPermission || needsQuestion

    if (needsInput) {
      return {
        className: "session-permission",
        text: needsPermission
          ? t("sessionList.status.needsPermission")
          : t("sessionList.status.needsInput"),
        showAlertIcon: true,
      }
    }

    const status = getSessionStatus(props.instance.id, activeSessionId)
    const retry = getSessionRetry(props.instance.id, activeSessionId)
    const showStatus = shouldShowSessionStatus(
      props.instance.id,
      activeSessionId,
      now(),
      preferences().keepUnseenSubagentIdleStatus,
    )
    if (!showStatus) {
      return null
    }
    const text = retry
      ? (() => {
          const seconds = getRetrySeconds(retry.next, now())
          return seconds > 0 ? t("sessionList.status.retryingIn", { seconds: String(seconds) }) : t("sessionList.status.retrying")
        })()
      : status === "working"
        ? t("sessionList.status.working")
        : status === "compacting"
          ? t("sessionList.status.compacting")
          : t("sessionList.status.idle")

    const baseClassName = `session-${retry ? "retrying" : status}`
    const fadeClassName = getSessionIdleFadeClass(props.instance.id, activeSessionId)

    return {
      className: fadeClassName ? `${baseClassName} ${fadeClassName}` : baseClassName,
      text,
      showAlertIcon: false,
      title: retry
        ? t("sessionList.status.retryTooltip", {
            message: retry.message,
            attempt: String(retry.attempt),
          })
        : undefined,
    }
  })

  const renderActiveSessionStatusPill = () => {
    const pill = activeSessionStatusPill()
    if (!pill) return null
    return (
      <span
        class={`status-indicator session-status session-status-list ${pill.className} notranslate`}
        title={pill.title}
        translate="no"
      >
        {pill.showAlertIcon ? <ShieldAlert class="w-3.5 h-3.5" aria-hidden="true" /> : <span class="status-dot" />}
        {pill.text}
      </span>
    )
  }

  const renderYoloModePill = () => {
    if (!yoloModeEnabled()) return null
    return (
      <span
        class="status-indicator session-status session-status-list session-yolo-mode"
        aria-label={t("instanceShell.yoloMode.badgeAriaLabel")}
        title={t("instanceShell.yoloMode.badgeAriaLabel")}
      >
        <span class="status-dot" />
        {t("instanceShell.yoloMode.badge")}
      </span>
    )
  }

  const renderSessionHeaderIndicators = () => (
    <div class="flex items-center flex-wrap justify-center gap-2">
      <Show when={hasPendingRequests()} fallback={renderActiveSessionStatusPill()}>
        <PermissionNotificationBanner
          instanceId={props.instance.id}
          onClick={() => setPermissionModalOpen(true)}
        />
      </Show>
      {renderYoloModePill()}
    </div>
  )

  const renderPreviewToggleButton = () => (
    <Show when={!showingInfoView()}>
      <IconButton
        color="inherit"
        onClick={handlePreviewButtonClick}
        aria-label={previewToggleLabel()}
        title={previewToggleLabel()}
        size="small"
      >
        {(() => {
          const Icon = PreviewToggleIcon()
          return <Icon class="w-5 h-5" aria-hidden="true" />
        })()}
      </IconButton>
    </Show>
  )

  const handleCommandPaletteClick = () => {
    showCommandPalette(props.instance.id)
  }

  const handleChatSearchClick = () => {
    if (typeof window === "undefined") return
    window.dispatchEvent(new CustomEvent(OPEN_SESSION_SEARCH_EVENT))
  }

  const narrowHeaderMenuItems = createMemo<ActionOverflowMenuItem[]>(() => {
    const PreviewIcon = PreviewToggleIcon()
    return [
      {
        key: "search",
        label: t("instanceShell.chatSearch.openAriaLabel"),
        icon: <Search class="w-3.5 h-3.5" aria-hidden="true" />,
        onSelect: handleChatSearchClick,
      },
      {
        key: "preview",
        label: previewToggleLabel(),
        icon: <PreviewIcon class="w-3.5 h-3.5" aria-hidden="true" />,
        onSelect: handlePreviewButtonClick,
      },
    ]
  })

  const openBackgroundOutput = (process: BackgroundProcess) => {
    setSelectedBackgroundProcess(process)
    setShowBackgroundOutput(true)
  }

  const closeBackgroundOutput = () => {
    setShowBackgroundOutput(false)
    setSelectedBackgroundProcess(null)
  }

  const stopBackgroundProcess = async (processId: string) => {
    try {
      await serverApi.stopBackgroundProcess(props.instance.id, processId)
    } catch (error) {
      log.warn("Failed to stop background process", error)
    }
  }

  const terminateBackgroundProcess = async (processId: string) => {
    try {
      await serverApi.terminateBackgroundProcess(props.instance.id, processId)
    } catch (error) {
      log.warn("Failed to terminate background process", error)
    }
  }

  const instancePaletteCommands = createMemo(() => props.paletteCommands())
  const paletteOpen = createMemo(() => isCommandPaletteOpen(props.instance.id))

   const keyboardShortcuts = createMemo(() =>
     [keyboardRegistry.get("session-prev"), keyboardRegistry.get("session-next")].filter(
       (shortcut): shortcut is KeyboardShortcut => Boolean(shortcut),
     ),
   )

   useSessionSidebarRequests({
     instanceId: () => props.instance.id,
     sidebarContentEl: leftDrawerContentEl,
     leftPinned,
     leftOpen,
     setLeftOpen,
     measureDrawerHost,
   })

  const { cachedSessionIds } = useSessionCache({
    instanceId: () => props.instance.id,
    instanceSessions: allInstanceSessions,
    activeSessionId: activeSessionIdForInstance,
  })

  // Split-pane picker popup (shell level, top-right).
  const [splitPickerOpen, setSplitPickerOpen] = createSignal(false)

  /** Pane layout for THIS instance; absent until the first session seeds it. */
  const paneStateForInstance = createMemo(() => panesForInstance(props.instance.id))
  /** Panes actually rendered in this shell (detached panes live in their own OS window). */
  const shellPanes = createMemo(() => (paneStateForInstance() ? visiblePanes(paneStateForInstance()!) : []))
  const splitActive = createMemo(() => shellPanes().length > 1)

  // Seed the single-pane state the first time a real session becomes active,
  // so the default layout equals today's behaviour (one active session).
  createEffect(() => {
    const sessionId = activeSessionIdForInstance()
    if (sessionId && sessionId !== "info" && !paneStateForInstance()) {
      ensurePaneState(props.instance.id, sessionId)
    }
  })

  const splitCandidates = createMemo(() => {
    const shown = new Set(shellPanes().map((pane) => `${pane.instanceId}:${pane.sessionId}`))
    const cached = cachedSessionIds().map((sessionId) => {
      const session = allInstanceSessions().get(sessionId)
      return { instanceId: props.instance.id, sessionId, title: session?.title ?? "" }
    })
    const others: Array<{ instanceId: string; sessionId: string; title: string }> = []
    for (const instanceId of instances().keys()) {
      if (instanceId === props.instance.id) continue
      const sessionId = activeSessionId().get(instanceId)
      if (!sessionId) continue
      const session = sessions().get(instanceId)?.get(sessionId)
      others.push({ instanceId, sessionId, title: session?.title ?? "" })
    }
    return buildSplitCandidates({
      currentInstanceId: props.instance.id,
      cachedSessions: cached,
      otherActiveSessions: others,
      shownPaneKeys: shown,
    })
  })

  const { handleDrawerResizeMouseDown, handleDrawerResizeTouchStart } = useDrawerResize({
    sessionSidebarWidth,
    rightDrawerWidth,
    setSessionSidebarWidth,
    setRightDrawerWidth,
    clampLeft: clampWidth,
    clampRight: clampRightWidth,
    measureDrawerHost,
  })


  const renderLeftPanel = () => {
    // With exactly one session the sessions sidebar is redundant clutter: it
    // must never be pinned (that is how it gets stuck), only open on demand
    // via the hamburger as a floating drawer.
    if (singleSessionMode()) {
      return renderLeftFloatingDrawer()
    }
    if (leftPinned()) {
      return (
        <Box
          class="session-sidebar-container"
          sx={{
            width: `${sessionSidebarWidth()}px`,
            flexShrink: 0,
            borderInlineEnd: "1px solid var(--border-base)",
            backgroundColor: "var(--surface-secondary)",
            height: "100%",
            minHeight: 0,
            position: "relative",
          }}
        >
          <div
            class="session-resize-handle session-resize-handle--left"
            onMouseDown={handleDrawerResizeMouseDown("left")}
            onTouchStart={handleDrawerResizeTouchStart("left")}
            role="presentation"
            aria-hidden="true"
          />
          <SessionSidebar
            t={t}
            instanceId={props.instance.id}
            threads={sessionThreads}
            activeSessionId={activeSessionIdForInstance}
            activeSession={activeSessionForInstance}
            draftAgent={draftAgent}
            draftModel={draftModel}
            showSearch={showSessionSearch}
            onToggleSearch={() => setShowSessionSearch((current) => !current)}
            keyboardShortcuts={keyboardShortcuts}
            isPhoneLayout={isPhoneLayout}
            drawerState={leftDrawerState}
            leftPinned={leftPinned}
            onSelectSession={handleSessionSelect}
            onNewSession={props.onNewSession}
            onSidebarAgentChange={props.handleSidebarAgentChange}
            onSidebarModelChange={props.handleSidebarModelChange}
            onDraftAgentChange={handleDraftAgentChange}
            onDraftModelChange={handleDraftModelChange}
            onPinLeftDrawer={pinLeftDrawer}
            onUnpinLeftDrawer={unpinLeftDrawer}
            onCloseLeftDrawer={closeSessionSidebar}
            setContentEl={setLeftDrawerContentEl}
          />
        </Box>
      )
    }
    return renderLeftFloatingDrawer()
  }

  const renderLeftFloatingDrawer = () => {
    return (
      <Drawer
        anchor={isRTL() ? "right" : "left"}
        variant="persistent"
        open={leftOpen()}
        sx={{
          zIndex: 60,
          // The tab bar sits outside the floating drawer. Let its controls
          // receive the gesture; click-away handling above still closes the
          // drawer when the target is not inside the drawer content.
          pointerEvents: "none",
          "& .MuiDrawer-paper": {
            pointerEvents: "auto",
            width: isPhoneLayout() ? "100vw" : `${sessionSidebarWidth()}px`,
            boxSizing: "border-box",
            borderInlineEnd: isPhoneLayout() ? "none" : "1px solid var(--border-base)",
            backgroundColor: "var(--surface-secondary)",
            backgroundImage: "none",
            color: "var(--text-primary)",
            boxShadow: "none",
            borderRadius: 0,
            top: floatingTopPx(),
            height: floatingHeight(),
          },
        }}
      >
        <Show when={!isPhoneLayout()}>
          <div
            class="session-resize-handle session-resize-handle--left"
            onMouseDown={handleDrawerResizeMouseDown("left")}
            onTouchStart={handleDrawerResizeTouchStart("left")}
            role="presentation"
            aria-hidden="true"
          />
        </Show>
        <SessionSidebar
          t={t}
          instanceId={props.instance.id}
          threads={sessionThreads}
          activeSessionId={activeSessionIdForInstance}
          activeSession={activeSessionForInstance}
          draftAgent={draftAgent}
          draftModel={draftModel}
          showSearch={showSessionSearch}
          onToggleSearch={() => setShowSessionSearch((current) => !current)}
          keyboardShortcuts={keyboardShortcuts}
          isPhoneLayout={isPhoneLayout}
          drawerState={leftDrawerState}
          leftPinned={leftPinned}
          onSelectSession={handleFloatingDrawerSessionSelect}
          onNewSession={handleFloatingDrawerNewSession}
          onSidebarAgentChange={props.handleSidebarAgentChange}
          onSidebarModelChange={props.handleSidebarModelChange}
          onDraftAgentChange={handleDraftAgentChange}
          onDraftModelChange={handleDraftModelChange}
          onPinLeftDrawer={pinLeftDrawer}
          onUnpinLeftDrawer={unpinLeftDrawer}
          onCloseLeftDrawer={closeSessionSidebar}
          setContentEl={setLeftDrawerContentEl}
        />
      </Drawer>
    )
  }


  const renderRightPanel = () => {
    if (rightPinned()) {
      return (
        <Box
          class="session-right-panel"
          sx={{
            width: `${rightDrawerWidth()}px`,
            flexShrink: 0,
            borderInlineStart: "1px solid var(--border-base)",
            backgroundColor: "var(--surface-secondary)",
            height: "100%",
            minHeight: 0,
            position: "relative",
          }}
        >
          <div
            class="session-resize-handle session-resize-handle--right"
            onMouseDown={handleDrawerResizeMouseDown("right")}
            onTouchStart={handleDrawerResizeTouchStart("right")}
            role="presentation"
            aria-hidden="true"
          />
          <RightPanel
            t={t}
            instanceId={props.instance.id}
            instance={props.instance}
            activeSessionId={activeSessionIdForInstance}
            activeSession={activeSessionForInstance}
            latestTodoState={latestTodoState}
            backgroundProcessList={backgroundProcessList}
            onOpenBackgroundOutput={openBackgroundOutput}
            onStopBackgroundProcess={stopBackgroundProcess}
            onTerminateBackgroundProcess={terminateBackgroundProcess}
            isPhoneLayout={isPhoneLayout}
            rightDrawerWidth={rightDrawerWidth}
            rightDrawerWidthInitialized={rightDrawerWidthInitialized}
            rightDrawerState={rightDrawerState}
            rightPinned={rightPinned}
            onCloseRightDrawer={closeRightDrawer}
            onPinRightDrawer={pinRightDrawer}
            onUnpinRightDrawer={unpinRightDrawer}
            promptInputApi={activePromptInputApi}
            setContentEl={setRightDrawerContentEl}
          />
        </Box>
      )
    }
    return (
      <Drawer
        anchor={isRTL() ? "left" : "right"}
        variant="persistent"
        open={rightOpen()}
        sx={{
          zIndex: 60,
          // See the matching override on the left drawer for rationale.
          pointerEvents: "none",
          "& .MuiDrawer-paper": {
            pointerEvents: "auto",
            width: isPhoneLayout() ? "100vw" : `${rightDrawerWidth()}px`,
            boxSizing: "border-box",
            borderInlineStart: isPhoneLayout() ? "none" : "1px solid var(--border-base)",
            backgroundColor: "var(--surface-secondary)",
            backgroundImage: "none",
            color: "var(--text-primary)",
            boxShadow: "none",
            borderRadius: 0,
            top: floatingTopPx(),
            height: floatingHeight(),
          },
        }}
      >
        <Show when={!isPhoneLayout()}>
          <div
            class="session-resize-handle session-resize-handle--right"
            onMouseDown={handleDrawerResizeMouseDown("right")}
            onTouchStart={handleDrawerResizeTouchStart("right")}
            role="presentation"
            aria-hidden="true"
          />
        </Show>
        {/* Mounted only while open. Its git status and diff views are the
            heaviest work in the shell, and a closed drawer has no business
            doing any of it. */}
        <Show when={rightOpen()}>
        <RightPanel
          t={t}
          instanceId={props.instance.id}
          instance={props.instance}
          activeSessionId={activeSessionIdForInstance}
          activeSession={activeSessionForInstance}
          latestTodoState={latestTodoState}
          backgroundProcessList={backgroundProcessList}
          onOpenBackgroundOutput={openBackgroundOutput}
          onStopBackgroundProcess={stopBackgroundProcess}
          onTerminateBackgroundProcess={terminateBackgroundProcess}
          isPhoneLayout={isPhoneLayout}
          rightDrawerWidth={rightDrawerWidth}
          rightDrawerWidthInitialized={rightDrawerWidthInitialized}
          rightDrawerState={rightDrawerState}
          rightPinned={rightPinned}
          onCloseRightDrawer={closeRightDrawer}
          onPinRightDrawer={pinRightDrawer}
          onUnpinRightDrawer={unpinRightDrawer}
          promptInputApi={activePromptInputApi}
          setContentEl={setRightDrawerContentEl}
        />
        </Show>
      </Drawer>

    )
  }

  const showEmbeddedSidebarToggle = createMemo(() => !singleSessionMode() && !leftPinned() && !leftOpen())
  const activeSessionTitle = createMemo(() => {
    if (showingInfoView()) return null
    const title = activeSessionForInstance()?.title?.trim()
    return title || t("sessionList.session.untitled")
  })
  const showHeaderLeftSlot = createMemo(() => !leftPinned() || singleSessionMode())
  const showHeaderSessionTitle = createMemo(() => !singleSessionMode() && !compactHeaderLayout() && showHeaderLeftSlot() && Boolean(activeSessionTitle()))
  const headerToolbarHorizontalInset = createMemo(() => (isPhoneLayout() ? 16 : 24))
  const headerLeftSlotWidth = createMemo(() => Math.max(0, sessionSidebarWidth() - headerToolbarHorizontalInset()))
  const headerLeftSlotStyle = createMemo(() => {
    if (singleSessionMode()) return undefined
    return leftDrawerState() === "floating-open" || showHeaderSessionTitle() ? { width: `${headerLeftSlotWidth()}px` } : undefined
  })

  const renderActiveSessionHeaderTitle = () => (
    <Show when={showHeaderSessionTitle()}>
      <div
        class="session-header-active-title"
        dir="auto"
        title={activeSessionTitle() ?? undefined}
      >
        <span class="session-header-active-title-text">{activeSessionTitle()}</span>
      </div>
    </Show>
  )

  const handleNewSessionClick = () => {
    const result = props.onNewSession()
    if (result instanceof Promise) {
      void result.catch((error) => log.error("Failed to create session:", error))
    }
  }

  /** Compact standalone controls used instead of the sessions sidebar when
      the instance holds exactly one session: the four session selectors plus
      a "new session" button, all in one toolbar row. */
  const renderSingleSessionControls = () => {
    const session = activeSessionForInstance()
    if (!session) return null
    return (
      <div class="session-single-controls">
        <button
          type="button"
          class="session-single-controls-new"
          title={t("sessionList.actions.newSession.title")}
          aria-label={t("sessionList.actions.newSession.ariaLabel")}
          onClick={handleNewSessionClick}
        >
          <PlusSquare class="w-4 h-4" aria-hidden="true" />
        </button>
        <div class="session-single-controls-item">
          <WorktreeSelector instanceId={props.instance.id} sessionId={session.id} />
        </div>
        <div class="session-single-controls-item">
          <AgentSelector
            instanceId={props.instance.id}
            sessionId={session.id}
            currentAgent={session.agent}
            onAgentChange={(agent) => props.handleSidebarAgentChange(session.id, agent)}
          />
        </div>
        <div class="session-single-controls-item">
          <ModelSelector
            instanceId={props.instance.id}
            sessionId={session.id}
            currentModel={session.model}
            onModelChange={(model) => props.handleSidebarModelChange(session.id, model)}
          />
        </div>
        <div class="session-single-controls-item">
          <ThinkingSelector instanceId={props.instance.id} currentModel={session.model} />
        </div>
      </div>
    )
  }

  const renderHeaderLeftSlot = () => (
    <Show when={showHeaderLeftSlot()}>
      <div class="session-header-left-slot" style={headerLeftSlotStyle()}>
        <Show when={singleSessionMode() ? !leftOpen() : leftDrawerState() === "floating-closed"}>
          <IconButton
            ref={setLeftToggleButtonEl}
            color="inherit"
            onClick={() => {
              setSessionSidebarVisible(true)
              if (singleSessionMode()) {
                setLeftOpen(true)
                measureDrawerHost()
                return
              }
              handleLeftAppBarButtonClick()
            }}
            aria-label={leftAppBarButtonLabel()}
            size="small"
            aria-expanded={leftDrawerState() !== "floating-closed"}
          >
            {leftAppBarButtonIcon()}
          </IconButton>
        </Show>
        <Show when={singleSessionMode() && leftDrawerState() === "floating-closed"}>
          {renderSingleSessionControls()}
        </Show>
        <Show when={!singleSessionMode()}>
          {renderActiveSessionHeaderTitle()}
        </Show>
      </div>
    </Show>
  )

  const isLaunching = createMemo(() => props.instance.status === "starting")

  createEffect(() => {
    const agent = draftAgent()
    providers().get(props.instance.id)
    if (!agent || draftModelManuallySelected()) return

    let cancelled = false
    void getDefaultModel(props.instance.id, agent).then((model) => {
      if (!cancelled) setDraftModel(model)
    }).catch((error) => log.warn("Failed to resolve draft model", error))

    onCleanup(() => {
      cancelled = true
    })
  })

  async function handleDraftAgentChange(agent: string) {
    setDraftAgent(agent)
    setDraftModelManuallySelected(false)
    const model = await getDefaultModel(props.instance.id, agent)
    setDraftModel(model)
  }

  async function handleDraftModelChange(model: { providerId: string; modelId: string }) {
    setDraftModel(model)
    setDraftModelManuallySelected(true)
  }

  const draftAttachments = createMemo(() => getAttachments(props.instance.id, NO_SESSION_DRAFT_SESSION_ID))

  function registerDraftPromptInputApi(api: PromptInputApi) {
    setDraftPromptInputApi(api)
    return () => {
      setDraftPromptInputApi((current) => (current === api ? null : current))
    }
  }

  function getActiveCreatedSessionPane(sessionId: string) {
    if (activeSessionIdForInstance() !== sessionId) return null
    const pane = sessionCenterEl()?.querySelector<HTMLElement>('.session-cache-pane[data-session-active="true"]')
    return pane?.dataset.sessionId === sessionId ? pane : null
  }

  function focusCreatedSessionPrompt(sessionId: string) {
    const textarea = getActiveCreatedSessionPane(sessionId)?.querySelector<HTMLTextAreaElement>(".prompt-input")
    if (!textarea || textarea.disabled) return
    try {
      textarea.focus({ preventScroll: true })
    } catch {
      textarea.focus()
    }
  }

  async function createAndActivateDraftSession() {
    const agent = draftAgent()
    const model = draftModel()
    if (agent && model.providerId && model.modelId) {
      await setAgentModelPreference(props.instance.id, agent, model)
    }
    const session = await createSession(props.instance.id, agent || undefined)
    if (model.providerId && model.modelId) {
      await updateSessionModel(props.instance.id, session.id, model)
    }
    if (!window.matchMedia?.("(pointer: coarse)")?.matches || window.matchMedia?.("(any-pointer: fine)")?.matches) {
      setFocusConversationSessionId(session.id)
    }
    setActiveParentSession(props.instance.id, session.id)
    return session
  }

  async function runFirstPromptSubmission(submit: (sessionId: string) => Promise<void>) {
    const session = await createAndActivateDraftSession()
    try {
      await submit(session.id)
    } catch (error) {
      focusCreatedSessionPrompt(session.id)
      throw error
    }
  }

  async function handleFirstPromptSend(prompt: string, attachments: Attachment[]) {
    await runFirstPromptSubmission((sessionId) => sendMessage(props.instance.id, sessionId, prompt, attachments))
  }

  async function handleFirstPromptCommand(commandName: string, args: string) {
    await runFirstPromptSubmission((sessionId) => executeCustomCommand(props.instance.id, sessionId, commandName, args))
  }

  async function handleFirstPromptShell(command: string) {
    await runFirstPromptSubmission((sessionId) => runShellCommand(props.instance.id, sessionId, command))
  }

  /** Return to the last conversation */
  const handleBackToConversation = () => {
    const sessionIds = cachedSessionIds()
    if (sessionIds.length > 0) {
      handleSessionSelect(sessionIds[0])
    }
  }

  const handleSplitPaneClick = () => setSplitPickerOpen(true)

  const handleSplitPick = (candidate: { instanceId: string; sessionId: string }) => {
    // A pane from this instance is a local split; a pane from another
    // instance is carried by the pane store as (instanceId, sessionId) and
    // rendered with that instance's own session data.
    const paneId = splitPane(props.instance.id, candidate.sessionId, candidate.instanceId)
    setSplitPickerOpen(false)
    const paneState = panesForInstance(props.instance.id)
    if (paneState && paneState.detachedIds.includes(paneId)) return
    activatePane(props.instance.id, paneId)
  }

  const handleDetachPane = (pane: { instanceId: string; sessionId: string; id: string }) => {
    detachPaneAt(props.instance.id, pane.id)
    const api = (globalThis as unknown as { electronAPI?: { openSessionPane?: (payload: { instanceId: string; sessionId: string }) => Promise<{ ok: boolean }> } }).electronAPI
    void api?.openSessionPane?.({ instanceId: pane.instanceId, sessionId: pane.sessionId })
  }

  const handleClosePane = (paneId: string) => {
    closePaneAt(props.instance.id, paneId)
  }

  /** A detached session-pane window asks the main window to re-insert it. */
  const handleReattachPane = () => {
    const api = (globalThis as unknown as {
      electronAPI?: { reattachSessionPane?: (payload: { instanceId: string; sessionId: string }) => Promise<{ ok: boolean }> }
    }).electronAPI
    const sessionId = activeSessionIdForInstance()
    if (!api?.reattachSessionPane || !sessionId || sessionId === "info") return
    void api.reattachSessionPane({ instanceId: props.instance.id, sessionId })
  }
  const sessionLayout = (
    <div
      class="session-shell-panels flex flex-1 min-h-0 overflow-x-hidden"
      ref={(element) => {
        setDrawerHost(element)
        measureDrawerHost()
      }}
    >
      {renderLeftPanel()}

      <Box
        class="session-center-column"
        ref={setSessionCenterEl}
        data-session-center-width={sessionCenterWidthStep()}
        sx={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowX: "hidden" }}
      >
        <Show when={!mobileFullscreen()}>
          <AppBar position="sticky" color="default" elevation={0} class="border-b border-base">
            <Toolbar variant="dense" class="session-toolbar flex flex-wrap items-center gap-2 py-0 min-h-[40px]">
              <Show
                when={!compactHeaderLayout()}
                fallback={
                  <div class="flex flex-col w-full gap-1.5">
                    <div class="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 w-full">
                      <div class="flex min-w-0 items-center gap-2">
                        {renderHeaderLeftSlot()}
                        {renderSessionHeaderIndicators()}
                      </div>

                      <div class="flex flex-wrap items-center justify-center gap-1">
                        <Show when={!showingInfoView() && !narrowHeaderLayout()}>
                          <IconButton
                            color="inherit"
                            onClick={handleChatSearchClick}
                            aria-label={t("instanceShell.chatSearch.openAriaLabel")}
                            title={t("instanceShell.chatSearch.openAriaLabel")}
                            size="small"
                          >
                            <Search class="w-5 h-5" aria-hidden="true" />
                          </IconButton>
                        </Show>
                        <button
                          type="button"
                          class="connection-status-button command-palette-button"
                          onClick={handleCommandPaletteClick}
                          aria-label={t("instanceShell.commandPalette.openAriaLabel")}
                          title={t("instanceShell.commandPalette.openAriaLabel")}
                        >
                          +
                        </button>
                      </div>

                      <div class="flex flex-1 items-center justify-end gap-1 min-w-0">
                        <span
                          class={`status-indicator ${connectionStatusClass()}`}
                          aria-label={t("instanceShell.connection.ariaLabel", { status: connectionStatusLabel() })}
                        >
                          <span class="status-dot" />
                        </span>

                        <Show when={!isPhoneLayout() && !narrowHeaderLayout()}>
                          {renderPreviewToggleButton()}
                        </Show>

                        <Show when={showCompactFullscreenButton() && !narrowHeaderLayout()}>
                          {renderPreviewToggleButton()}
                        </Show>

                        <Show when={rightDrawerState() === "floating-closed"}>
                          <IconButton
                            ref={setRightToggleButtonEl}
                            color="inherit"
                            onClick={handleRightAppBarButtonClick}
                            aria-label={rightAppBarButtonLabel()}
                            size="small"
                            aria-expanded={rightDrawerState() !== "floating-closed"}
                          >
                            {rightAppBarButtonIcon()}
                          </IconButton>
                        </Show>
                      </div>
                    </div>

                    <div
                      class={
                        narrowHeaderLayout() || showCompactFullscreenButton()
                          ? "grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 pb-1"
                          : "flex flex-wrap items-center justify-center gap-2 pb-1"
                      }
                    >
                      <Show when={narrowHeaderLayout() || showCompactFullscreenButton()}>
                        <div class="flex min-w-0 items-center justify-start">
                          <Show when={narrowHeaderLayout() && !showingInfoView()}>
                            <ActionOverflowMenu
                              items={narrowHeaderMenuItems()}
                              label={t("messageItem.actions.more")}
                              triggerClass="message-action-button"
                              minItems={1}
                            />
                          </Show>
                        </div>
                      </Show>

                      <div class="flex items-center justify-center">
                        <Show when={!showingInfoView()}>
                          <ContextMeter
                            usedTokens={tokenStats().used}
                            limitTokens={tokenStats().limit}
                            compactionThresholdTokens={tokenStats().threshold}
                            formatTokens={formatTokenTotal}
                            usedLabel={t("instanceShell.metrics.usedLabel")}
                            remainingLabel={t("instanceShell.metrics.availableLabel")}
                            compactionLabel={t("instanceShell.metrics.compactionLabel")}
                            limitLabel={t("instanceShell.metrics.limitLabel")}
                            centerValue={narrowHeaderLayout() || showCompactFullscreenButton()}
                          />
                        </Show>
                      </div>

                      <Show when={narrowHeaderLayout() || showCompactFullscreenButton()}>
                        <div class="flex items-center justify-end gap-1">
                          <Show when={showCompactFullscreenButton()}>
                            <IconButton
                              color="inherit"
                              onClick={props.onEnterMobileFullscreen}
                              aria-label={t("instanceShell.fullscreen.enter")}
                              title={t("instanceShell.fullscreen.enter")}
                              size="small"
                              sx={{ width: 30, height: 30 }}
                            >
                              <Maximize2 class="w-5 h-5" aria-hidden="true" />
                            </IconButton>
                          </Show>
                        </div>
                      </Show>
                    </div>
                </div>
              }
            >
              <div class="session-toolbar-left flex-1 flex items-center gap-3 min-w-0">
                {renderHeaderLeftSlot()}

                <Show when={!showingInfoView()}>
                  <ContextMeter
                    usedTokens={tokenStats().used}
                    limitTokens={tokenStats().limit}
                    compactionThresholdTokens={tokenStats().threshold}
                    formatTokens={formatTokenTotal}
                    usedLabel={t("instanceShell.metrics.usedLabel")}
                    remainingLabel={t("instanceShell.metrics.availableLabel")}
                    compactionLabel={t("instanceShell.metrics.compactionLabel")}
                    limitLabel={t("instanceShell.metrics.limitLabel")}
                  />
                </Show>

                <div class="ml-auto flex items-center session-header-hints">
                  {renderSessionHeaderIndicators()}
                </div>
              </div>

              <div class="session-toolbar-center flex items-center justify-center gap-2 min-w-[160px]">
                <button
                  type="button"
                  class="connection-status-button command-palette-button"
                  onClick={handleCommandPaletteClick}
                  aria-label={t("instanceShell.commandPalette.openAriaLabel")}
                  title={t("instanceShell.commandPalette.openAriaLabel")}
                >
                  +
                </button>
              </div>

              <div class="session-toolbar-right flex-1 flex items-center gap-3">
                <div class="ms-auto flex items-center gap-3">
                <div class="connection-status-meta flex items-center gap-3">
                    <Show when={isSessionPaneWindow()}>
                      <button
                        type="button"
                        class="session-split-pane-action"
                        title={t("saipenView.reattachHint")}
                        onClick={handleReattachPane}
                      >
                        {t("saipenView.reattach")}
                      </button>
                    </Show>
                    <Show when={!showingInfoView()}>
                      <IconButton
                        color="inherit"
                        onClick={handleChatSearchClick}
                        aria-label={t("instanceShell.chatSearch.openAriaLabel")}
                        title={t("instanceShell.chatSearch.openAriaLabel")}
                        size="small"
                      >
                        <Search class="w-5 h-5" aria-hidden="true" />
                      </IconButton>
                      {renderPreviewToggleButton()}
                    </Show>
                    <Show when={connectionStatus() === "connected"}>
                      <span class="status-indicator connected">
                        <span class="status-dot" />
                        <span class="status-text">{t("instanceShell.connection.connected")}</span>
                      </span>
                    </Show>
                    <Show when={connectionStatus() === "connecting"}>
                      <span class="status-indicator connecting">
                        <span class="status-dot" />
                        <span class="status-text">{t("instanceShell.connection.connecting")}</span>
                      </span>
                    </Show>
                    <Show when={connectionStatus() === "error" || connectionStatus() === "disconnected"}>
                      <span class="status-indicator disconnected">
                        <span class="status-dot" />
                        <span class="status-text">{t("instanceShell.connection.disconnected")}</span>
                      </span>
                    </Show>
                  </div>
                  <Show when={rightDrawerState() === "floating-closed"}>
                    <IconButton
                      ref={setRightToggleButtonEl}
                      color="inherit"
                      onClick={handleRightAppBarButtonClick}
                      aria-label={rightAppBarButtonLabel()}
                      size="small"
                      aria-expanded={rightDrawerState() !== "floating-closed"}
                    >
                      {rightAppBarButtonIcon()}
                    </IconButton>
                  </Show>
                </div>
              </div>
              </Show>
            </Toolbar>
          </AppBar>
        </Show>

        <Box
          component="main"
          sx={{ flexGrow: 1, minHeight: 0, display: "flex", flexDirection: "column", overflowX: "hidden" }}
          class="content-area"
        >
          <Show
            when={showingInfoView()}
            fallback={
              <Show
                when={cachedSessionIds().length > 0 && activeSessionIdForInstance()}
                fallback={
                  <div class="session-view">
                    <MessageSection
                      instanceId={props.instance.id}
                      sessionId={NO_SESSION_DRAFT_SESSION_ID}
                      loading={false}
                      emptyStateVariant="no-session"
                      isActive={props.isActiveInstance}
                      showSidebarToggle={showEmbeddedSidebarToggle()}
                      onSidebarToggle={() => setLeftOpen(true)}
                      forceCompactStatusLayout={showEmbeddedSidebarToggle()}
                    />

                    <Show when={draftAttachments().length > 0}>
                      <PromptAttachmentsBar
                        attachments={draftAttachments()}
                        onRemoveAttachment={(attachmentId) => {
                          const api = draftPromptInputApi()
                          if (api) {
                            api.removeAttachment(attachmentId)
                            return
                          }
                          removeAttachment(props.instance.id, NO_SESSION_DRAFT_SESSION_ID, attachmentId)
                        }}
                        onExpandTextAttachment={(attachmentId) => draftPromptInputApi()?.expandTextAttachment(attachmentId)}
                      />
                    </Show>

                    {/* The bar belongs here too: `cc`, `sss` and `hh` are all
                        legitimate first messages, and the queue is not -- it
                        keys on a session id that does not exist yet. */}
                    <Show when={showSaipenBar()}>
                      <SaipenBar
                        folder={props.instance.folder}
                        onRunShortcut={(shortcut) => void handleFirstPromptSend(shortcut, [])}
                        onInsertShortcut={(text) => draftPromptInputApi()?.setPromptText(text, { focus: true })}
                        onSplitPane={handleSplitPaneClick}
                      />
                    </Show>

                    <PromptInput
                      instanceId={props.instance.id}
                      instanceFolder={props.instance.folder}
                      sessionId={NO_SESSION_DRAFT_SESSION_ID}
                      isActive={props.isActiveInstance}
                      compactLayout={compactPromptLayout()}
                      onSend={handleFirstPromptSend}
                      onCommand={handleFirstPromptCommand}
                      onRunShell={handleFirstPromptShell}
                      escapeInDebounce={props.escapeInDebounce}
                      registerPromptInputApi={registerDraftPromptInputApi}
                    />
                  </div>
                }
              >
              <Show
                when={splitActive()}
                fallback={
                  <For each={cachedSessionIds()}>
                    {(sessionId) => {
                      const isActive = () => Boolean(props.isActiveInstance) && activeSessionIdForInstance() === sessionId
                      return (
                        <div
                          class="session-cache-pane flex flex-col flex-1 min-h-0"
                          style={{ display: isActive() ? "flex" : "none" }}
                          data-session-id={sessionId}
                          data-instance-id={props.instance.id}
                          data-session-active={isActive() ? "true" : "false"}
                          aria-hidden={!isActive()}
                        >
                          <SessionView
                            sessionId={sessionId}
                            activeSessions={activeSessions()}
                            instanceId={props.instance.id}
                            instanceFolder={props.instance.folder}
                            escapeInDebounce={props.escapeInDebounce}
                            isPhoneLayout={isPhoneLayout()}
                            compactPromptLayout={compactPromptLayout()}
                            focusConversationOnActivate={focusConversationSessionId() === sessionId}
                            onConversationFocusHandled={() => {
                              if (focusConversationSessionId() === sessionId) setFocusConversationSessionId(null)
                            }}
                            registerSessionPromptApi={registerSessionPromptApi}
                            showSidebarToggle={showEmbeddedSidebarToggle()}
                            onSidebarToggle={() => setLeftOpen(true)}
                            forceCompactStatusLayout={showEmbeddedSidebarToggle()}
                            isActive={isActive()}
                            isForegroundTab={Boolean(props.isActiveInstance)}
                            isSessionSelected={activeSessionIdForInstance() === sessionId}
                            onSplitPane={handleSplitPaneClick}
                          />
                        </div>
                      )
                    }}
                  </For>
                }
              >
                <div class="session-split-panes flex flex-row flex-1 min-h-0 overflow-x-hidden">
                  <For each={shellPanes()}>
                    {(pane, index) => {
                      const isPaneActive = () => Boolean(props.isActiveInstance) && paneStateForInstance()?.activePaneId === pane.id
                      return (
                        <>
                          <Show when={index() > 0}>
                            <div class="session-split-divider" role="separator" aria-orientation="vertical" />
                          </Show>
                          <div
                            class="session-cache-pane flex flex-col flex-1 min-h-0"
                            data-pane-id={pane.id}
                            data-session-id={pane.sessionId}
                            data-instance-id={pane.instanceId}
                            data-session-active={isPaneActive() ? "true" : "false"}
                          >
                            <div class="session-split-pane-toolbar flex items-center gap-1 px-1 border-b border-base min-h-[28px]">
                              <span class="session-split-pane-title flex-1 min-w-0 truncate px-1 text-xs">
                                {allInstanceSessions().get(pane.sessionId)?.title ?? ""}
                              </span>
                              <button
                                type="button"
                                class="session-split-pane-action"
                                title={t("saipenView.detachHint")}
                                aria-label={t("saipenView.detach")}
                                onClick={() => handleDetachPane(pane)}
                              >
                                {t("saipenView.detach")}
                              </button>
                              <button
                                type="button"
                                class="session-split-pane-action"
                                title={t("saipenView.closeHint")}
                                aria-label={t("saipenView.closeHint")}
                                onClick={() => handleClosePane(pane.id)}
                              >
                                ×
                              </button>
                            </div>
                            <SessionView
                              sessionId={pane.sessionId}
                              activeSessions={activeSessions()}
                              instanceId={pane.instanceId}
                              instanceFolder={pane.instanceId === props.instance.id ? props.instance.folder : ""}
                              escapeInDebounce={props.escapeInDebounce}
                              isPhoneLayout={isPhoneLayout()}
                              compactPromptLayout={compactPromptLayout()}
                              focusConversationOnActivate={focusConversationSessionId() === pane.sessionId}
                              onConversationFocusHandled={() => {
                                if (focusConversationSessionId() === pane.sessionId) setFocusConversationSessionId(null)
                              }}
                              registerSessionPromptApi={registerSessionPromptApi}
                              showSidebarToggle={showEmbeddedSidebarToggle()}
                              onSidebarToggle={() => setLeftOpen(true)}
                              forceCompactStatusLayout={showEmbeddedSidebarToggle()}
                              isActive={isPaneActive()}
                              isForegroundTab={Boolean(props.isActiveInstance)}
                              isSessionSelected={isPaneActive()}
                              onSplitPane={handleSplitPaneClick}
                            />
                          </div>
                        </>
                      )
                    }}
                  </For>
                </div>
              </Show>
              </Show>
            }
          >
            <div class="info-view-pane flex flex-col flex-1 min-h-0 overflow-y-auto">
              <InfoView instanceId={props.instance.id} onBackToConversation={handleBackToConversation} />
            </div>
          </Show>
        </Box>
      </Box>

      {renderRightPanel()}
    </div>
  )

  return (
    <>
      <div
        class="instance-shell2 flex flex-col flex-1 min-h-0"
        data-instance-id={props.instance.id}
      >
        <Show when={!isLaunching()} fallback={<InstanceWelcomeView instance={props.instance} />}>
          {sessionLayout}
        </Show>
      </div>

      <CommandPalette
        open={paletteOpen()}
        onClose={() => hideCommandPalette(props.instance.id)}
        commands={instancePaletteCommands()}
        onExecute={props.onExecuteCommand}
      />

      <BackgroundProcessOutputDialog
        open={showBackgroundOutput()}
        instanceId={props.instance.id}
        process={selectedBackgroundProcess()}
        onClose={closeBackgroundOutput}
      />

      <PermissionApprovalModal
        instanceId={props.instance.id}
        isOpen={permissionModalOpen()}
        onClose={() => setPermissionModalOpen(false)}
      />

      <SplitPicker
        open={splitPickerOpen()}
        candidates={splitCandidates()}
        onPick={handleSplitPick}
        onClose={() => setSplitPickerOpen(false)}
      />
    </>
  )
}

export default InstanceShell2
