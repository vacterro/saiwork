import { Show, createMemo, createEffect, createSignal, on, onCleanup, type Component } from "solid-js"
import type { Session } from "../../types/session"
import type { Attachment } from "../../types/attachment"
import type { ClientPart } from "../../types/message"
import MessageSection from "../message-section"
import { messageStoreBus } from "../../stores/message-v2/bus"
import PromptInput from "../prompt-input"
import PromptAttachmentsBar from "../prompt-input/PromptAttachmentsBar"
import PromptQueuePanel from "../prompt-queue-panel"
import SaipenBar from "../saipen-bar"
import { clearQueue, dequeuePrompt, enqueuePrompt, enqueuePromptFanOut, getQueue, getQueueLength, isQueuePaused, restoreDequeuedPrompt, restoreDequeuedPrompts } from "../../stores/prompt-queue"
import { getAttachments, removeAttachment } from "../../stores/attachments"
import { instances, updateInstance, waitForInstanceWorkspaceMetadataHydration } from "../../stores/instances"
import { activeSessionId, loadMessages, sendMessage, forkSession, renameSession, isSessionMessagesLoading, getSessionMessagesLoadError, markSessionIdleSeen, ensureSessionAncestorsExpanded, setActiveSessionFromList, runShellCommand, abortSession, sessions } from "../../stores/sessions"
import { clearResponseStartedAt, responseStartedAtSignal, setResponseStartedAt } from "../../stores/response-timer"
import { confirmModelSend, modelQuotaBlockedNow } from "../../lib/freebuff-send-guard"
import { ensureAntigravityQuota } from "../../stores/model-quota"
import { clearSessionIdleFade, IDLE_STATUS_VISIBILITY_MS, getSessionStatus, isSessionBusy as getSessionBusyStatus, markSessionIdleFadeStarted } from "../../stores/session-status"
import { deleteMessage, didSessionPromptReachServer } from "../../stores/session-actions"
import { showAlertDialog } from "../../stores/alerts"
import { getLogger } from "../../lib/logger"
import { serverApi } from "../../lib/api-client"
import { normalizeShortcutMessage } from "../../lib/saipen-commands"
import { createDrainGate } from "../../lib/drain-gate"
import {
  SAIPEN_CONTINUE_PROMPT,
  beginGoalAutoCheck,
  clearDispatchedContinue,
  endGoalAutoCheck,
  goalAutoCooldownRemainingMs,
  hasDispatchedContinue,
  isGoalAutoCooldownActive,
  markContinueDispatched,
  markGoalAutoAborted,
  noteGoalAutoTurnIdle,
  shouldCheckSaipenGoalAuto,
  shouldEnqueueSaipenContinue,
} from "../../lib/saipen-goal-auto"
import {
  GOAL_AUTO_RETRY_DELAY_MS,
  GOAL_AUTO_RETRY_MAX,
  createGoalAutoRetry,
  type GoalAutoRetry,
} from "../../lib/saipen-goal-auto-retry"
import { dispatchOrdinaryPrompt, shouldDrainPromptQueue } from "../../lib/prompt-dispatch"
import { dispatchSaipenShortcut } from "../../lib/saipen-shortcut-dispatch"
import { requestData } from "../../lib/opencode-api"
import { useI18n } from "../../lib/i18n"
import type { PromptInputApi, PromptInsertMode } from "../prompt-input/types"
import { clearConversationPlaybackForSession } from "../../stores/conversation-speech"
import { isSaipenGoalAutoEnabled, useConfig } from "../../stores/preferences"
import { closeSessionPreview, getSessionPreview, showSessionChat } from "../../stores/session-previews"
import { showQueuePanel, showSaipenBar } from "../../stores/ui"
import { SessionPreviewView } from "../session-preview-view"
import { isSnapshotAutoFollowing } from "../virtual-follow-behavior"
import { getSubmitBottomPinTargetCount, resolveSessionBottomPinIntent, shouldClearSessionBottomPinIntent, type SessionBottomPinIntent } from "./session-bottom-pin-intent"
import { focusConversationStream } from "../focus-conversation"

const log = getLogger("session")

function isTextPart(part: ClientPart): part is ClientPart & { type: "text"; text: string } {
  return part?.type === "text" && typeof (part as any).text === "string"
}

interface SessionViewProps {
  sessionId: string
  activeSessions: Map<string, Session>
  instanceId: string
  instanceFolder: string
  escapeInDebounce: boolean
  isPhoneLayout?: boolean
  compactPromptLayout?: boolean
  focusConversationOnActivate?: boolean
  onConversationFocusHandled?: () => void
  showSidebarToggle?: boolean
  onSidebarToggle?: () => void
  forceCompactStatusLayout?: boolean
  isActive?: boolean
  isForegroundTab?: boolean
  isSessionSelected?: boolean
  /** Opens the split-session picker. */
  onSplitPane?: () => void
  /** Opens the model / worktree controls. */
  onOpenModelControls?: () => void
  /** Starts a new conversation in the same session (fork). */
  onNewConversation?: () => void
  registerSessionPromptApi?: (sessionId: string, api: PromptInputApi | null) => void
}

export const SessionView: Component<SessionViewProps> = (props) => {
  const { t } = useI18n()
  const { preferences, toggleQueueEnabled, toggleQueueSendMode, toggleSaipenGoalAuto, toggleSaipenShortcutsImmediate, getSaipenGoalAutoLimit, setSaipenGoalAutoLimit } = useConfig()
  // A split pane can show a session outside the active family (another project
  // or another thread); resolve from the full session list when it is.
  const session = () =>
    props.activeSessions.get(props.sessionId) ??
    sessions().get(props.instanceId)?.get(props.sessionId) ??
    null
  const messagesLoading = createMemo(() => isSessionMessagesLoading(props.instanceId, props.sessionId))
  const messagesLoadError = createMemo(() => getSessionMessagesLoadError(props.instanceId, props.sessionId))
  const messageStore = createMemo(() => messageStoreBus.getOrCreate(props.instanceId))
  const sessionBusy = createMemo(() => {
    const currentSession = session()
    if (!currentSession) return false
    return getSessionBusyStatus(props.instanceId, currentSession.id)
  })
  const sessionStreamingActive = createMemo(() => {
    const currentSession = session()
    if (!currentSession) return false
    return getSessionStatus(props.instanceId, currentSession.id) === "working"
  })
  const sessionNeedsInput = createMemo(() => {
    const currentSession = session()
    if (!currentSession) return false
    return Boolean(currentSession.pendingPermission || (currentSession as any).pendingQuestion)
  })

  const attachments = createMemo(() => getAttachments(props.instanceId, props.sessionId))
  const preview = createMemo(() => getSessionPreview(props.sessionId))

  // Response elapsed timer: ticks every second while the agent is working. The
  // start time lives in a per-session store so switching tabs (which remounts
  // this component) never resets the clock to zero -- each session counts its
  // own elapsed time independently.
  const [responseElapsed, setResponseElapsed] = createSignal(0)
  let responseTimerInterval: ReturnType<typeof setInterval> | undefined
  const responseStartedAt = responseStartedAtSignal(props.instanceId, props.sessionId)

  createEffect(
    on(sessionBusy, (busy) => {
      if (busy) {
        if (responseStartedAt() == null) {
          const currentSession = session()
          let realStartedAt = Date.now()
          const messageIds = currentSession ? (messageStore()?.getSessionMessageIds(currentSession.id) ?? []) : []
          if (currentSession && messageIds.length > 0) {
            const storeState = messageStore()?.state
            if (storeState?.messages) {
              const lastId = messageIds[messageIds.length - 1]
              const msg = storeState.messages[lastId]
              if (msg && msg.createdAt) {
                realStartedAt = msg.createdAt
              }
            }
          }
          setResponseStartedAt(props.instanceId, props.sessionId, realStartedAt)
        }

        setResponseElapsed(Math.max(0, Date.now() - (responseStartedAt() ?? Date.now())))
        clearInterval(responseTimerInterval)
        responseTimerInterval = setInterval(() => {
          const startedAt = responseStartedAt()
          if (startedAt != null) {
            setResponseElapsed(Math.max(0, Date.now() - startedAt))
          }
        }, 1000)
      } else {
        clearInterval(responseTimerInterval)
        responseTimerInterval = undefined
        setResponseElapsed(0)
        clearResponseStartedAt(props.instanceId, props.sessionId)
      }
    }),
  )

  onCleanup(() => {
    clearInterval(responseTimerInterval)
  })

  const MESSAGE_SCROLL_CACHE_SCOPE = "message-stream"

  let promptInputApi: PromptInputApi | null = null
  let pendingPromptText: string | null = null
  let pendingSelectionInsert: { text: string; mode: PromptInsertMode } | null = null
  let pendingCommentText: string | null = null

  let scrollToBottomHandle: (() => void) | undefined
  let rootRef: HTMLDivElement | undefined
  const pendingIdleSeenTimers = new Set<string>()
  const [submitBottomPinIntent, setSubmitBottomPinIntent] = createSignal<SessionBottomPinIntent | null>(null)
  let submitBottomPinIntentSequence = 0

  function shouldScrollToBottomOnActivate() {
    const current = session()
    if (!current) return true
    const snapshot = messageStore().getScrollSnapshot(current.id, MESSAGE_SCROLL_CACHE_SCOPE)
    return isSnapshotAutoFollowing(snapshot)
  }

  function scheduleScrollToBottom(options?: { force?: boolean; sessionId?: string }) {
    if (!scrollToBottomHandle) return false
    const targetSessionId = options?.sessionId ?? props.sessionId
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const current = session()
        if (!current || current.id !== targetSessionId) return
        if (!options?.force && !shouldScrollToBottomOnActivate()) return
        scrollToBottomHandle?.()
      })
    })
    return true
  }

  // Scroll to the newest message when the session's initial message load
  // finishes: the list mounts empty and the async hydration lands after, so a
  // mount-time scroll would land above the content.
  const [prevMessagesLoading, setPrevMessagesLoading] = createSignal<boolean | null>(null)
  createEffect(() => {
    const loading = isSessionMessagesLoading(props.instanceId, props.sessionId)
    const was = prevMessagesLoading()
    setPrevMessagesLoading(loading)
    if (props.isActive === false) return
    if (was === true && loading === false) {
      scheduleScrollToBottom({ force: true })
    }
  })

  function startSubmitBottomPinIntent(
    minItemCount: number,
    options?: { createdMessageCount?: number; preserveObservedStreaming?: boolean },
  ) {
    submitBottomPinIntentSequence += 1
    const previous = submitBottomPinIntent()
    const createdMessageCount = options?.createdMessageCount ?? messageStore().getSessionMessageIds(props.sessionId).length
    const shouldPreserveObservedStreaming = Boolean(
      options?.preserveObservedStreaming &&
      previous?.sessionId === props.sessionId &&
      previous.createdMessageCount === createdMessageCount,
    )
    const intent: SessionBottomPinIntent = {
      sessionId: props.sessionId,
      token: submitBottomPinIntentSequence,
      minItemCount,
      createdMessageCount,
      observedStreaming: shouldPreserveObservedStreaming ? previous?.observedStreaming === true : false,
    }
    setSubmitBottomPinIntent(intent)
    return intent
  }

  function forceSubmittedExchangeToBottom(
    minItemCount: number,
    options?: { createdMessageCount?: number; preserveObservedStreaming?: boolean },
  ) {
    const intent = startSubmitBottomPinIntent(minItemCount, options)
    scrollToBottomHandle?.()
    return intent
  }

  const activeSubmitBottomPinIntent = createMemo(() => {
    const intent = submitBottomPinIntent()
    const currentSession = session()
    if (!intent || !currentSession) return null

    const messageCount = messageStore().getSessionMessageIds(currentSession.id).length
    if (shouldClearSessionBottomPinIntent(intent, {
      sessionId: currentSession.id,
      messageCount,
      streamingActive: sessionStreamingActive(),
    })) {
      return null
    }

    return resolveSessionBottomPinIntent(intent, currentSession.id)
  })

  function getSeenIdleEntries(currentSession: Session, keepUnseenSubagentIdleStatus: boolean): Array<{ id: string; idleSince: number }> {
    const entries: Array<{ id: string; idleSince: number }> = []

    if (currentSession.status === "idle" && typeof currentSession.idleSince === "number") {
      entries.push({ id: currentSession.id, idleSince: currentSession.idleSince })
    }

    if (currentSession.parentId === null && !keepUnseenSubagentIdleStatus) {
      for (const child of props.activeSessions.values()) {
        if (child.id === currentSession.id) continue
        if (child.status !== "idle") continue
        if (typeof child.idleSince !== "number") continue
        entries.push({ id: child.id, idleSince: child.idleSince })
      }
    }

    return entries
  }

  createEffect(
    on(
      () => props.sessionId,
      () => setSubmitBottomPinIntent(null),
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => props.isActive,
      (isActive, wasActive) => {
        if (!isActive) return
        if (wasActive === true) return
        if (!shouldScrollToBottomOnActivate()) return
        scheduleScrollToBottom()
      },
    ),
  )

  createEffect(() => {
    const intent = submitBottomPinIntent()
    const currentSession = session()
    if (!intent || !currentSession) return

    if (sessionStreamingActive() && intent.sessionId === currentSession.id && !intent.observedStreaming) {
      setSubmitBottomPinIntent({ ...intent, observedStreaming: true })
      return
    }

    const messageCount = messageStore().getSessionMessageIds(currentSession.id).length
    if (shouldClearSessionBottomPinIntent(intent, {
      sessionId: currentSession.id,
      messageCount,
      streamingActive: sessionStreamingActive(),
    })) {
      setSubmitBottomPinIntent(null)
    }
  })

  createEffect(() => {
    const currentSession = session()
    if (!props.isActive || !currentSession) return

    const seenIdleEntries = getSeenIdleEntries(currentSession, preferences().keepUnseenSubagentIdleStatus)
    for (const entry of seenIdleEntries) {
      const timerKey = `${props.instanceId}:${entry.id}:${entry.idleSince}`
      if (pendingIdleSeenTimers.has(timerKey)) continue
      pendingIdleSeenTimers.add(timerKey)
      markSessionIdleFadeStarted(props.instanceId, entry.id)
      markSessionIdleSeen(props.instanceId, entry.id)

      window.setTimeout(() => {
        pendingIdleSeenTimers.delete(timerKey)
        clearSessionIdleFade(props.instanceId, entry.id, entry.idleSince)
      }, IDLE_STATUS_VISIBILITY_MS)
    }
  })

  createEffect(
    on(
      () => props.isActive,
      (isActive) => {
        if (!isActive) {
          if (props.focusConversationOnActivate) props.onConversationFocusHandled?.()
          clearConversationPlaybackForSession(props.instanceId, props.sessionId)
          return
        }

        // On phones, focusing the prompt on session switch is disruptive (it raises the OSK).
        if (props.isPhoneLayout && !props.focusConversationOnActivate) return

        // Don't steal focus from other inputs (command palette, dialogs, selectors, etc.)
        if (typeof document === "undefined") return
        const activeEl = document.activeElement as HTMLElement | null
        const activeIsInput =
          activeEl?.tagName === "INPUT" ||
          activeEl?.tagName === "TEXTAREA" ||
          activeEl?.tagName === "SELECT" ||
          Boolean(activeEl?.isContentEditable)
        if (activeIsInput) return

        const modalOpen = Boolean(document.querySelector('[role="dialog"][aria-modal="true"]'))
        if (modalOpen) return

        // Defer until the session pane is visible and the textarea is mounted.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (!props.isActive) return
            if (props.focusConversationOnActivate) {
              const activeElement = document.activeElement
              const focusIsUnclaimed =
                !activeElement || activeElement === document.body || activeElement === document.documentElement
              const modalIsOpen = Boolean(document.querySelector('[role="dialog"][aria-modal="true"]'))
              if (focusIsUnclaimed && !modalIsOpen && focusConversationStream(rootRef)) {
                props.onConversationFocusHandled?.()
                return
              }
              props.onConversationFocusHandled?.()
              if (!focusIsUnclaimed || modalIsOpen) return
            }
            if (promptInputApi) {
              promptInputApi.focus()
              return
            }

            const textarea = rootRef?.querySelector<HTMLTextAreaElement>(".prompt-input")
            if (!textarea) return
            if (textarea.disabled) return

            try {
              textarea.focus({ preventScroll: true } as any)
            } catch {
              textarea.focus()
            }
          })
        })
      },
    ),
  )

  createEffect(() => {
    if (!props.isActive) return
    const currentSession = session()
    if (!currentSession) return
    const sessionId = currentSession.id
    void waitForInstanceWorkspaceMetadataHydration(props.instanceId)
      .then(() => {
        if (!props.isActive || session()?.id !== sessionId) return
        return loadMessages(props.instanceId, sessionId)
      })
      .catch((error) => log.error("Failed to load messages", error))
  })

  function handleReloadMessages() {
    const currentSession = session()
    if (!currentSession) return
    loadMessages(props.instanceId, currentSession.id, { force: true }).catch((error) =>
      log.error("Failed to reload messages", error),
    )
  }

  function registerPromptInputApi(api: PromptInputApi) {
    promptInputApi = api
    props.registerSessionPromptApi?.(props.sessionId, api)

    if (pendingPromptText) {
      api.setPromptText(pendingPromptText, { focus: true })
      pendingPromptText = null
    }

    if (pendingSelectionInsert) {
      api.insertSelection(pendingSelectionInsert.text, pendingSelectionInsert.mode)
      pendingSelectionInsert = null
    }

    if (pendingCommentText) {
      api.insertComment(pendingCommentText)
      pendingCommentText = null
    }

    return () => {
      if (promptInputApi === api) {
        promptInputApi = null
        props.registerSessionPromptApi?.(props.sessionId, null)
      }
    }
  }

  function handleQuoteSelection(text: string, mode: PromptInsertMode) {
    if (promptInputApi) {
      promptInputApi.insertSelection(text, mode)
    } else {
      pendingSelectionInsert = { text, mode }
    }
  }

  function handleInsertPreviewComment(markdown: string) {
    if (promptInputApi) {
      promptInputApi.insertComment(markdown)
    } else {
      pendingCommentText = `${pendingCommentText ?? ""}${markdown}`
    }
  }

  async function handleSendMessage(prompt: string, attachments: Attachment[]) {
    // A bare shortcut (`cc`, `ee`, ...) is expanded to its canonical verb here,
    // deterministically, so the model never has to parse a raw key from chat
    // (two keys sent back-to-back were merged into `ccee` before).
    prompt = normalizeShortcutMessage(prompt) ?? prompt
    const messageCount = messageStore().getSessionMessageIds(props.sessionId).length
    const submittedExchangeTargetCount = getSubmitBottomPinTargetCount(messageCount, sessionStreamingActive())
    const initialPinIntent = forceSubmittedExchangeToBottom(submittedExchangeTargetCount, { createdMessageCount: messageCount })
    try {
      await sendMessage(props.instanceId, props.sessionId, prompt, attachments)
      const latestMessageCount = messageStore().getSessionMessageIds(props.sessionId).length
      if (latestMessageCount < submittedExchangeTargetCount && !sessionStreamingActive()) {
        setSubmitBottomPinIntent(null)
      } else if (submitBottomPinIntent()?.token === initialPinIntent.token) {
        forceSubmittedExchangeToBottom(Math.max(submittedExchangeTargetCount, latestMessageCount), {
          createdMessageCount: messageCount,
          preserveObservedStreaming: true,
        })
      }
    } catch (error) {
      setSubmitBottomPinIntent(null)
      throw error
    }
  }

  async function handleRunShell(command: string) {
    await runShellCommand(props.instanceId, props.sessionId, command)
  }

  /** Returns false when the prompt was refused, so the editor keeps the text. */
  async function handleQueuePrompt(prompt: string, attachments: Attachment[]): Promise<boolean> {
    const result = await enqueuePrompt(props.instanceId, props.sessionId, prompt, attachments)
    if (!result.ok) {
      reportQueueRefusal(result.reason)
      return false
    }
    return true
  }

  function reportQueueRefusal(reason: string) {
    if (reason === "empty") return
    if (reason === "conflict") {
      showAlertDialog(t("promptQueue.refused.conflict"), { title: t("promptQueue.refused.title"), variant: "error" })
      return
    }
    showAlertDialog(
      reason === "too-large" ? t("promptQueue.refused.tooLarge") : t("promptQueue.refused.quota"),
      { title: t("promptQueue.refused.title"), variant: "error" },
    )
  }

  async function handleDispatchMessage(prompt: string, attachments: Attachment[]) {
    // FreeBuff one-tab rule + daily-quota reminder: asking before the first
    // send of a new FreeBuff conversation or before burning the last quota.
    // Declining keeps the draft text without enqueuing anything.
    if (!(await confirmModelSend(props.instanceId, props.sessionId))) return
    const outcome = await dispatchOrdinaryPrompt({
      queueEnabled: preferences().queueEnabled,
      instanceId: props.instanceId,
      sessionId: props.sessionId,
      prompt,
      attachments,
      enqueue: enqueuePrompt,
      send: async (_instanceId, _sessionId, nextPrompt, nextAttachments) => {
        await handleSendMessage(nextPrompt, nextAttachments)
      },
    })

    if (outcome.result === "rejected" && outcome.reason) {
      reportQueueRefusal(outcome.reason)
    }
  }

  /** SAIPEN bar shortcuts: immediate mode sends now when idle and queues while working. */
  function handleRunShortcut(shortcut: string) {
    const mode = dispatchSaipenShortcut({
      immediate: preferences().saipenShortcutsImmediate,
      busy: sessionBusy(),
      needsInput: sessionNeedsInput(),
      paused: isQueuePaused(props.instanceId, props.sessionId),
      queueEnabled: preferences().queueEnabled,
    })
    if (mode === "queue") {
      void handleQueuePrompt(shortcut, [])
      return
    }
    void handleSendMessage(shortcut, [])
  }

  async function handleQueueAll(prompt: string): Promise<number> {
    const targets = Array.from(instances().values()).flatMap((instance) => {
      if (instance.status !== "ready") return []
      const sessionId = activeSessionId().get(instance.id)
      return sessionId && sessionId !== "info" ? [{ instanceId: instance.id, sessionId }] : []
    })
    const result = await enqueuePromptFanOut(targets, prompt)
    if (!result.ok) {
      reportQueueRefusal(result.reason)
      return 0
    }
    return result.items.length
  }

  let autoContinueCheck = 0
  let goalAutoRetry: GoalAutoRetry | undefined
  let previousGoalAutoBusy = false
  let goalAutoCooldownTimer: ReturnType<typeof setTimeout> | undefined

  // Warm the Antigravity quota so quota-aware guards and Goal Auto see it.
  createEffect(() => {
    void ensureAntigravityQuota()
  })

  function runGoalAutoStatusCheck() {
    // The dispatched mark is set only after the fetch resolves, so a concurrent
    // effect pass would double-enqueue; one check at a time per session.
    if (!beginGoalAutoCheck(props.instanceId, props.sessionId)) return
    const check = ++autoContinueCheck
    void serverApi
      .fetchSaipenStatus(props.instanceFolder)
      .then(async (status) => {
        if (check !== autoContinueCheck || props.isSessionSelected === false || sessionBusy() || sessionNeedsInput()) return
        // Re-check after the await: the status fetch is the window in which a
        // parallel evaluation could have dispatched one already.
        if (hasDispatchedContinue(props.instanceId, props.sessionId)) return
        const queuedPrompts = getQueue(props.instanceId, props.sessionId).map((item) => item.text)
        if (!shouldEnqueueSaipenContinue(status, queuedPrompts)) return
        markContinueDispatched(props.instanceId, props.sessionId)
        await enqueuePrompt(props.instanceId, props.sessionId, SAIPEN_CONTINUE_PROMPT)

        const limit = getSaipenGoalAutoLimit(props.instanceFolder)
        if (limit !== null && limit > 0) {
          const next = limit - 1
          setSaipenGoalAutoLimit(props.instanceFolder, next)
          if (next === 0) {
            toggleSaipenGoalAuto(props.instanceFolder)
          }
        }

        if (props.isForegroundTab === false) {
          updateInstance(props.instanceId, { unreadGoalAuto: true })
        }
      })
      .catch((error) => {
        // A transient failure must not silently kill Goal Auto for the rest of
        // the idle stretch: schedule one bounded retry while still eligible.
        log.error("Failed to check SAIPEN Goal Mode Auto:", error)
        getGoalAutoRetry().retry()
      })
      .finally(() => {
        endGoalAutoCheck(props.instanceId, props.sessionId)
      })
  }

  function getGoalAutoRetry(): GoalAutoRetry {
    if (!goalAutoRetry) {
      goalAutoRetry = createGoalAutoRetry({
        shouldRetry: () => {
          if (props.isSessionSelected === false) return false
          if (!preferences().queueEnabled || !isSaipenGoalAutoEnabled(props.instanceFolder)) return false
          if (sessionBusy() || sessionNeedsInput()) return false
          if (isQueuePaused(props.instanceId, props.sessionId)) return false
          return !hasDispatchedContinue(props.instanceId, props.sessionId)
        },
        runCheck: () => runGoalAutoStatusCheck(),
        delayMs: GOAL_AUTO_RETRY_DELAY_MS,
        maxRetries: GOAL_AUTO_RETRY_MAX,
      })
    }
    return goalAutoRetry
  }

  onCleanup(() => {
    autoContinueCheck += 1
    // A retry left pending by an unmounted pane must never fire against a dead
    // session.
    goalAutoRetry?.cancel()
    if (goalAutoCooldownTimer) {
      clearTimeout(goalAutoCooldownTimer)
      goalAutoCooldownTimer = undefined
    }
    // A mark left behind by an unmounted pane would block the next legitimate
    // continue for this session, which looks exactly like Goal Auto dying.
    clearDispatchedContinue(props.instanceId, props.sessionId)
  })

  createEffect(
    on(
      () => ({
        active: props.isActive !== false,
        // Goal Auto needs the queue (it enqueues) AND its own switch. The two
        // used to be one flag, so the only way to stop the automatic continues
        // was to give up queue mode entirely.
        enabled: preferences().queueEnabled && isSaipenGoalAutoEnabled(props.instanceFolder),
        busy: sessionBusy(),
        needsInput: sessionNeedsInput(),
        paused: isQueuePaused(props.instanceId, props.sessionId),
        quotaBlocked: modelQuotaBlockedNow(props.instanceId),
        folder: props.instanceFolder,
        sessionId: props.sessionId,
      }),
      (state) => {
        // Any state change closes the previous check's retry window; the new
        // evaluation starts with a fresh budget.
        goalAutoRetry?.cancel()
        if (goalAutoCooldownTimer) {
          clearTimeout(goalAutoCooldownTimer)
          goalAutoCooldownTimer = undefined
        }

        // A turn just ended (busy -> idle): start the continue cooldown so Goal
        // Auto does not immediately fire again -- and much longer after an
        // explicit abort.
        if (previousGoalAutoBusy && !state.busy) {
          noteGoalAutoTurnIdle(props.instanceId, state.sessionId)
        }
        previousGoalAutoBusy = state.busy

        // Going busy is the agent picking the last continue up, which is what
        // makes the next one legitimate. Nothing else clears the mark.
        if (state.busy) {
          clearDispatchedContinue(props.instanceId, state.sessionId)
          return
        }

        // Daily quota exhausted (FreeBuff/Antigravity): continuing would only
        // produce quota errors, so Goal Auto stands down until the quota resets
        // or the model changes.
        if (state.quotaBlocked) return

        // Cooldown after the last turn/abort: schedule a resume so the next
        // continue fires only once the pause has elapsed.
        if (isGoalAutoCooldownActive(props.instanceId, state.sessionId)) {
          const remaining = goalAutoCooldownRemainingMs(props.instanceId, state.sessionId)
          goalAutoCooldownTimer = setTimeout(() => {
            goalAutoCooldownTimer = undefined
            runGoalAutoStatusCheck()
          }, Math.max(500, remaining + 200))
          return
        }

        if (!shouldCheckSaipenGoalAuto(state)) return
        if (hasDispatchedContinue(props.instanceId, state.sessionId)) return
        runGoalAutoStatusCheck()
      },
    ),
  )

  /**
   * Sends the head of the queue.
   *
   * `draining` is a plain flag rather than a signal on purpose: it guards
   * against re-entry inside a single tick, and making it reactive would feed
   * the effect below back into itself.
   */
  let draining = false

  /**
   * Gate that blocks the next drain until the session reports busy. It is only
   * disarmed by an observed busy transition OR a bounded timeout: a session
   * stopped mid-send never reports busy, and without the timeout the queue
   * would stay wedged forever (sends look fine but nothing leaves the queue).
   */
  const drainGate = createDrainGate({ timeoutMs: 60_000 })

  /**
   * Set while the queue is waiting for the session to report working after a
   * send. Two quick enqueues used to drain in a row before the session's busy
   * status flipped, so the opencode session received both prompts in one turn
   * and the chat showed one message with both texts. The next drain waits until
   * the session has actually gone busy since the last one.
   */

  async function drainQueueHead() {
    if (draining) return

    // Send-all mode: everything queued goes out as one combined message, so it
    // gets one answer. Attachments cannot be combined, so they are dropped.
    if (preferences().queueSendMode === "all") {
      const all = getQueue(props.instanceId, props.sessionId)
      if (all.length === 0) return
      const cleared = await clearQueue(props.instanceId, props.sessionId)
      if (!cleared) {
        // Another window moved the queue while we read it; the mirror already
        // re-synced, so never send a stale snapshot.
        return
      }
      draining = true
      try {
        await handleSendMessage(all.map((item) => item.text).join("\n\n"), [])
      } catch (error) {
        log.error("Failed to send queued prompts:", error)
        let detail = error instanceof Error ? error.message : String(error)
        if (!didSessionPromptReachServer(error)) {
          const restored = await restoreDequeuedPrompts(props.instanceId, props.sessionId, all)
          drainGate.disarm()
          if (!restored) detail = `${t("promptQueue.recoveryFailed")}\n\n${all.map((item) => item.text).join("\n\n")}`
        }
        showAlertDialog(t("promptInput.send.errorFallback"), {
          title: t("promptInput.send.errorTitle"),
          detail,
          variant: "error",
        })
      } finally {
        draining = false
      }
      return
    }

    const next = await dequeuePrompt(props.instanceId, props.sessionId)
    if (!next) return

    draining = true
    try {
      await handleSendMessage(next.text, next.attachments)
    } catch (error) {
      log.error("Failed to send queued prompt:", error)
      let detail = error instanceof Error ? error.message : String(error)
      if (!didSessionPromptReachServer(error)) {
        // No promptAsync call occurred, so restoring cannot duplicate a send.
        // Pause prevents a broken session from repeatedly draining and failing.
        const restored = await restoreDequeuedPrompt(props.instanceId, props.sessionId, next)
        drainGate.disarm()
        if (!restored) detail = `${t("promptQueue.recoveryFailed")}\n\n${next.text}`
      }
      showAlertDialog(t("promptInput.send.errorFallback"), {
        title: t("promptInput.send.errorTitle"),
        detail,
        variant: "error",
      })
      // Ambiguous failures keep the durable dequeue and wait for observed busy
      // state rather than risking a duplicate dispatch.
    } finally {
      draining = false
    }
  }

  // Drains one entry each time the session settles into idle. One per idle
  // transition, not a loop: the next send flips the session back to working,
  // which re-arms this effect for the entry after it.
  createEffect(
    on(
      () => ({
        busy: sessionBusy(),
        needsInput: sessionNeedsInput(),
        pending: getQueueLength(props.instanceId, props.sessionId),
        paused: isQueuePaused(props.instanceId, props.sessionId),
      }),
      (state) => {
        // The send was picked up: the next drain is allowed once the session
        // goes idle again.
        if (state.busy) drainGate.disarm()
        if (!shouldDrainPromptQueue(state)) return
        if (drainGate.blocked()) return
        drainGate.arm()
        void drainQueueHead()
      },
    ),
  )
 
  async function handleAbortSession() {
    const currentSession = session()
    if (!currentSession) return
  
    try {
      await abortSession(props.instanceId, currentSession.id)
      // The user stopped the work; Goal Auto must not instantly restart it.
      markGoalAutoAborted(props.instanceId, currentSession.id)
      log.info("Abort requested", { instanceId: props.instanceId, sessionId: currentSession.id })
    } catch (error) {
      log.error("Failed to abort session", error)
      showAlertDialog(t("sessionView.alerts.abortFailed.message"), {
        title: t("sessionView.alerts.abortFailed.title"),
        detail: error instanceof Error ? error.message : String(error),
        variant: "error",
      })
    }
  }
 
  function getUserMessageText(messageId: string): string | null {

    const normalizedMessage = messageStore().getMessage(messageId)
    if (normalizedMessage && normalizedMessage.role === "user") {
      const parts = normalizedMessage.partIds
        .map((partId) => normalizedMessage.parts[partId]?.data)
        .filter((part): part is ClientPart => Boolean(part))
      const textParts = parts.filter(isTextPart)
      if (textParts.length > 0) {
        return textParts.map((part) => part.text).join("\n")
      }
    }
 
    return null
  }


  async function handleRevert(messageId: string) {
    const instance = instances().get(props.instanceId)
    if (!instance || !instance.client) return

    try {
      await requestData(
        instance.client.session.revert({
          sessionID: props.sessionId,
          messageID: messageId,
        }),
        "session.revert",
      )

      const restoredText = getUserMessageText(messageId)
      if (restoredText) {
        if (promptInputApi) {
          promptInputApi.setPromptText(restoredText, { focus: true })
        } else {
          pendingPromptText = restoredText
        }
      }
    } catch (error) {
      log.error("Failed to revert message", error)
      showAlertDialog(t("sessionView.alerts.revertFailed.message"), {
        title: t("sessionView.alerts.revertFailed.title"),
        variant: "error",
      })
    }
  }

  async function handleDeleteMessagesUpTo(messageId: string) {
    const ids = messageStore().getSessionMessageIds(props.sessionId)
    const index = ids.indexOf(messageId)
    if (index === -1) return

    const restoredText = getUserMessageText(messageId)
    const toDelete = ids.slice(index)

    try {
      for (let idx = toDelete.length - 1; idx >= 0; idx -= 1) {
        await deleteMessage(props.instanceId, props.sessionId, toDelete[idx])
      }
    } catch (error) {
      log.error("Failed to delete messages up to", error)
      showAlertDialog(t("sessionView.alerts.deleteUpToFailed.message"), {
        title: t("sessionView.alerts.deleteUpToFailed.title"),
        variant: "error",
      })
    } finally {
      if (restoredText) {
        if (promptInputApi) {
          promptInputApi.setPromptText(restoredText, { focus: true })
        } else {
          pendingPromptText = restoredText
        }
      }
    }
  }

  async function handleFork(messageId?: string) {
    if (!messageId) {
      log.warn("Fork requires a user message id")
      return
    }

    const restoredText = getUserMessageText(messageId)
    const parentTitle = (session()?.title ?? "").trim() || t("sessionList.session.untitled")

    try {
      const forkedSession = await forkSession(props.instanceId, props.sessionId, { messageId })

      renameSession(props.instanceId, forkedSession.id, `Fork: ${parentTitle}`).catch((error) => {
        log.error("Failed to rename forked session", error)
      })

      ensureSessionAncestorsExpanded(props.instanceId, forkedSession.id)
      setActiveSessionFromList(props.instanceId, forkedSession.id)

      await loadMessages(props.instanceId, forkedSession.id).catch((error) => log.error("Failed to load forked session messages", error))

       if (restoredText) {
         if (promptInputApi) {
           promptInputApi.setPromptText(restoredText, { focus: true })
         } else {
           pendingPromptText = restoredText
         }
       }
    } catch (error) {
      log.error("Failed to fork session", error)
      showAlertDialog(t("sessionView.alerts.forkFailed.message"), {
        title: t("sessionView.alerts.forkFailed.title"),
        variant: "error",
      })
    }
  }
  return (
    <Show
      when={session()}
      fallback={
        <div class="flex items-center justify-center h-full">
          <div class="text-center text-gray-500">{t("sessionView.fallback.sessionNotFound")}</div>
        </div>
      }
    >
      {(sessionAccessor) => {
        const activeSession = sessionAccessor()
        if (!activeSession) return null
        return (
          <div ref={rootRef} class="session-view">
            <Show
              when={preview()?.mode === "preview" && preview()}
              fallback={
                <MessageSection
                  instanceId={props.instanceId}
                  sessionId={activeSession.id}
                  loading={messagesLoading()}
                  loadError={messagesLoadError()}
                  onReloadMessages={handleReloadMessages}
                  sessionStreamingActive={sessionStreamingActive()}
                  explicitBottomPinIntent={activeSubmitBottomPinIntent()}
                  onExplicitBottomPinCancelled={() => setSubmitBottomPinIntent(null)}
                  onRevert={handleRevert}
                  onDeleteMessagesUpTo={handleDeleteMessagesUpTo}
                  onFork={handleFork}
                  isActive={props.isActive}
                  registerScrollToBottom={(fn) => {
                    scrollToBottomHandle = fn ?? undefined
                  }}
                  showSidebarToggle={props.showSidebarToggle}
                  onSidebarToggle={props.onSidebarToggle}
                  forceCompactStatusLayout={props.forceCompactStatusLayout}
                  onQuoteSelection={handleQuoteSelection}
                />
              }
            >
              {(activePreview) => (
                <SessionPreviewView
                  preview={activePreview()}
                  onBackToChat={() => showSessionChat(props.sessionId)}
                  onClose={() => void closeSessionPreview(props.sessionId)}
                  onInsertComment={handleInsertPreviewComment}
                />
              )}
            </Show>

            <Show when={attachments().length > 0}>
              <PromptAttachmentsBar
                attachments={attachments()}
                onRemoveAttachment={(attachmentId) => {
                  if (promptInputApi) {
                    promptInputApi.removeAttachment(attachmentId)
                    return
                  }
                  removeAttachment(props.instanceId, props.sessionId, attachmentId)
                }}
                onExpandTextAttachment={(attachmentId) => promptInputApi?.expandTextAttachment(attachmentId)}
              />
            </Show>

            <Show when={showSaipenBar()}>
              <SaipenBar
                folder={props.instanceFolder}
                instanceId={props.instanceId}
                onRunShortcut={handleRunShortcut}
                onInsertShortcut={(text) => promptInputApi?.setPromptText(text, { focus: true })}
                goalAutoEnabled={isSaipenGoalAutoEnabled(props.instanceFolder)}
                goalAutoBlockedByQueue={!preferences().queueEnabled}
                goalAutoBlockedByQuota={modelQuotaBlockedNow(props.instanceId)}
                onToggleGoalAuto={() => toggleSaipenGoalAuto(props.instanceFolder)}
                goalAutoLimit={getSaipenGoalAutoLimit(props.instanceFolder)}
                onSetGoalAutoLimit={(limit) => setSaipenGoalAutoLimit(props.instanceFolder, limit)}
                shortcutsImmediate={preferences().saipenShortcutsImmediate}
                onToggleShortcutsImmediate={toggleSaipenShortcutsImmediate}
                onSplitPane={props.onSplitPane}
                responseElapsedMs={responseElapsed()}
              />
            </Show>

            <Show when={showQueuePanel()}>
              <PromptQueuePanel
                instanceId={props.instanceId}
                sessionId={activeSession.id}
                sessionBusy={sessionBusy()}
                queueEnabled={preferences().queueEnabled}
                onToggleQueueEnabled={toggleQueueEnabled}
                sendMode={preferences().queueSendMode}
                onToggleSendMode={toggleQueueSendMode}
                onSendNext={() => void drainQueueHead()}
              />
            </Show>

            <PromptInput
              instanceId={props.instanceId}
              instanceFolder={props.instanceFolder}
              sessionId={activeSession.id}
              isActive={props.isActive}
              compactLayout={props.compactPromptLayout}
              onOpenModelControls={props.onOpenModelControls}
              onNewConversation={props.onNewConversation}
              onSend={handleDispatchMessage}
              onQueue={preferences().queueEnabled ? handleQueuePrompt : undefined}
              onQueueAll={preferences().queueEnabled ? handleQueueAll : undefined}
              queuedCount={getQueueLength(props.instanceId, activeSession.id)}
              onRunShell={handleRunShell}
              escapeInDebounce={props.escapeInDebounce}
              isSessionBusy={sessionBusy()}
              disabled={sessionNeedsInput()}
              onAbortSession={handleAbortSession}
              registerPromptInputApi={registerPromptInputApi}
            />
            </div>
          )
        }}
    </Show>
  )
}

export default SessionView

