import { For, Show, createEffect, createMemo, createSignal, onCleanup, type Component } from "solid-js"

import type { Instance } from "../../../../../types/instance"
import type { FreebuffThreadView } from "../../../../../../../server/src/api-types"
import {
  freebuffBusy,
  freebuffError,
  freebuffQuota,
  freebuffStatus,
  freebuffThreads,
  freebuffActiveThreadId,
  freebuffEventsFor,
  refreshFreebuffStatus,
  startFreebuffEngine,
  stopFreebuffEngine,
  refreshFreebuffThreads,
  createFreebuffThread,
  freebuffPostMessage,
  freebuffStopTurn,
  selectFreebuffThread,
  clearFreebuffEvents,
  startFreebuffStatusPolling,
  ensureFreebuffEngine,
} from "../../../../../stores/freebuff"
import { FREEBUFF_MODELS } from "../../../../../../../server/src/freebuff/models"
import type { FreebuffRateLimit } from "../../../../../../../server/src/api-types"

interface FreebuffTabProps {
  t: (key: string, vars?: Record<string, any>) => string
  instance: Instance
}

const DEFAULT_MODEL = "deepseek/deepseek-v4-flash"

function modelDisplayName(modelId: string): string {
  return FREEBUFF_MODELS.find((model) => model.id === modelId)?.displayName ?? modelId
}

function formatResetAt(resetAt: string | undefined): string {
  if (!resetAt) return ""
  const date = new Date(resetAt)
  if (Number.isNaN(date.getTime())) return resetAt
  return date.toLocaleString()
}

interface ModelOption {
  id: string
  displayName: string
  limit: number
  recentCount: number
  usable: boolean
}

function buildModelOptions(limits: Record<string, FreebuffRateLimit> | undefined): ModelOption[] {
  if (!limits) {
    return FREEBUFF_MODELS.map((model) => ({
      id: model.id,
      displayName: model.displayName,
      limit: 0,
      recentCount: 0,
      usable: true,
    }))
  }
  return Object.values(limits)
    .filter((limit) => FREEBUFF_MODELS.some((model) => model.id === limit.model))
    .map((limit) => ({
      id: limit.model,
      displayName: modelDisplayName(limit.model),
      limit: limit.limit,
      recentCount: limit.recentCount,
      usable: limit.limit > 0,
    }))
}

const FreebuffTab: Component<FreebuffTabProps> = (props) => {
  const [composer, setComposer] = createSignal("")
  const [titleInput, setTitleInput] = createSignal("")
  const [selectedModel, setSelectedModel] = createSignal(DEFAULT_MODEL)
  const [creating, setCreating] = createSignal(false)
  const [sending, setSending] = createSignal(false)
  const [starting, setStarting] = createSignal(false)
  const [autoStartTried, setAutoStartTried] = createSignal(false)

  const status = freebuffStatus
  const quota = createMemo(() => freebuffQuota())
  const modelOptions = createMemo(() => buildModelOptions(quota()?.rateLimitsByModel))
  const selectedModelOption = createMemo(() => {
    const options = modelOptions()
    const chosen = options.find((option) => option.id === selectedModel())
    if (chosen?.usable) return chosen
    const fallback = options.find((option) => option.usable)
    return fallback ?? options[0] ?? null
  })
  const threadsForFolder = createMemo<FreebuffThreadView[]>(() => {
    const folder = props.instance.folder
    const list = freebuffThreads()
    return folder ? list.filter((thread) => thread.status === "open") : list
  })
  const activeThread = createMemo(() => {
    const id = freebuffActiveThreadId()
    return threadsForFolder().find((thread) => thread.id === id) ?? null
  })
  const activeThreadEvents = createMemo(() => freebuffEventsFor(freebuffActiveThreadId()))
  const running = createMemo(() => activeThread()?.turnState === "running")
  const sendDisabled = createMemo(() => sending() || running() || !composer().trim())

  const stopPolling = startFreebuffStatusPolling()
  onCleanup(stopPolling)

  createEffect(() => {
    void refreshFreebuffStatus()
  })
  createEffect(() => {
    if (status()?.ready) void refreshFreebuffThreads()
  })
  createEffect(() => {
    // Auto-start the engine once when the surface opens and an install exists.
    // Guarded so a persistent start failure does not retry on every status
    // change; the manual Start engine button remains the recovery path.
    if (autoStartTried()) return
    if (status()?.installFound && !status()?.ready && !freebuffBusy()) {
      setAutoStartTried(true)
      setStarting(true)
      void ensureFreebuffEngine().finally(() => setStarting(false))
    }
  })

  const handleStart = () => {
    setStarting(true)
    void startFreebuffEngine().finally(() => setStarting(false))
  }
  const handleStopEngine = () => {
    void stopFreebuffEngine()
  }
  const handleNewThread = () => {
    const model = selectedModelOption()?.id ?? DEFAULT_MODEL
    setCreating(true)
    void createFreebuffThread(props.instance.folder, model, titleInput() || undefined).finally(() => {
      setCreating(false)
      setTitleInput("")
    })
  }
  const handleSend = () => {
    const threadId = freebuffActiveThreadId()
    const text = composer().trim()
    if (!threadId || !text) return
    setSending(true)
    void freebuffPostMessage(threadId, text).finally(() => {
      setComposer("")
      setSending(false)
      void refreshFreebuffThreads()
    })
  }
  const handleStopTurn = () => {
    const threadId = freebuffActiveThreadId()
    if (threadId) void freebuffStopTurn(threadId)
  }

  const resetAtLabel = createMemo(() => {
    const limits = quota()?.rateLimitsByModel
    if (!limits) return null
    const entry = Object.values(limits)[0]
    return entry?.resetAt ? formatResetAt(entry.resetAt) : null
  })

  return (
    <div class="flex flex-col gap-2 px-3 py-2">
      <Show when={freebuffError()} keyed>
        {(message) => <p class="text-xs text-danger">{message}</p>}
      </Show>

      <section class="right-panel-section">
        <h3 class="section-label">{props.t("freebuff.engine.title")}</h3>
        <div class="flex items-center justify-between gap-2 border border-base bg-surface-secondary px-3 py-2">
          <div class="min-w-0">
            <Show
              when={status()?.installFound}
              fallback={<p class="text-xs text-secondary">{props.t("freebuff.engine.notFound")}</p>}
            >
              <p class="text-xs text-secondary">
                {starting() ? props.t("freebuff.engine.starting") : status()?.ready ? props.t("freebuff.engine.ready") : props.t("freebuff.engine.stopped")}
                <Show when={freebuffAccountEmail()} keyed>
                  {(email) => <span> - {email}</span>}
                </Show>
              </p>
              <p class="text-[10px] text-tertiary">{status()?.root}</p>
            </Show>
          </div>
          <Show when={status()?.installFound}>
            <Show
              when={status()?.ready}
              fallback={
                <button type="button" class="shrink-0" disabled={freebuffBusy() || starting()} onClick={handleStart}>
                  {props.t("freebuff.engine.start")}
                </button>
              }
            >
              <button type="button" class="shrink-0" disabled={freebuffBusy()} onClick={handleStopEngine}>
                {props.t("freebuff.engine.stop")}
              </button>
            </Show>
          </Show>
        </div>
      </section>

      <Show when={quota()}>
        <section class="right-panel-section">
          <h3 class="section-label">{props.t("freebuff.quota.title")}</h3>
          <p class="text-[10px] text-tertiary">
            {props.t("freebuff.quota.tier", { tier: quota()?.accessTier ?? "" })}
            <Show when={resetAtLabel()} keyed>
              {(resetAt) => <span> - {props.t("freebuff.quota.resetAt", { time: resetAt })}</span>}
            </Show>
          </p>
          <For each={modelOptions()}>
            {(option) => (
              <div
                class={`flex items-center justify-between border border-base px-3 py-1 ${selectedModelOption()?.id === option.id ? "bg-surface-alt" : "bg-surface-secondary"}`}
              >
                <span class="min-w-0 truncate text-xs text-primary">{option.displayName}</span>
                <span class={`shrink-0 text-xs ${option.usable ? "text-secondary" : "text-danger"}`}>
                  {option.usable ? quotaUsedText(option.limit, option.recentCount) : props.t("freebuff.quota.exhausted")}
                </span>
              </div>
            )}
          </For>
        </section>
      </Show>

      <section class="right-panel-section">
        <h3 class="section-label">{props.t("freebuff.threads.title")}</h3>
        <Show when={status()?.ready}>
          <div class="flex items-center justify-between gap-2 border border-base bg-surface-secondary px-3 py-1">
            <span class="text-xs text-secondary">{props.t("freebuff.threads.count", { count: threadsForFolder().length })}</span>
            <button
              type="button"
              class="shrink-0"
              onClick={() => void refreshFreebuffThreads()}
              title={props.t("freebuff.threads.refresh")}
            >
              {props.t("freebuff.threads.refresh")}
            </button>
          </div>
          <Show when={modelOptions().length > 0}>
            <div class="flex flex-col gap-1 border border-base bg-surface-secondary px-3 py-1">
              <label class="text-[10px] text-tertiary" for="freebuff-model">
                {props.t("freebuff.threads.model")}
              </label>
              <select
                id="freebuff-model"
                value={selectedModelOption()?.id ?? ""}
                onChange={(event) => setSelectedModel(event.currentTarget.value)}
              >
                <For each={modelOptions()}>
                  {(option) => <option value={option.id} disabled={!option.usable}>{option.displayName}</option>}
                </For>
              </select>
              <label class="text-[10px] text-tertiary" for="freebuff-title">
                {props.t("freebuff.threads.titleLabel")}
              </label>
              <input
                id="freebuff-title"
                value={titleInput()}
                onInput={(event) => setTitleInput(event.currentTarget.value)}
                placeholder={props.t("freebuff.threads.titlePlaceholder")}
              />
              <button type="button" disabled={freebuffBusy() || creating() || !selectedModelOption()?.usable} onClick={handleNewThread}>
                {props.t("freebuff.threads.new")}
              </button>
            </div>
          </Show>
          <Show when={threadsForFolder().length > 0}>
            <div class="flex max-h-48 flex-col gap-1 overflow-y-auto">
              <For each={threadsForFolder()}>
                {(thread) => <FreebuffThreadRow t={props.t} thread={thread} active={freebuffActiveThreadId() === thread.id} onSelect={() => selectFreebuffThread(thread.id)} />}
              </For>
            </div>
          </Show>
          <Show when={threadsForFolder().length === 0}>
            <p class="text-xs text-tertiary">{props.t("freebuff.threads.none")}</p>
          </Show>
        </Show>
        <Show when={!status()?.ready && status()?.installFound}>
          <p class="text-xs text-secondary">{props.t("freebuff.threads.engineNeeded")}</p>
        </Show>
      </section>

      <Show when={activeThread()}>
        <section class="right-panel-section">
          <h3 class="section-label">{props.t("freebuff.turn.title")}</h3>
          <div class="flex items-center justify-between gap-2">
            <span class="min-w-0 truncate text-xs text-secondary">
              {activeThread()?.title ?? activeThread()?.id}
              <Show when={running()}> - {props.t("freebuff.turn.running")}</Show>
            </span>
            <Show when={running()}>
              <button type="button" onClick={handleStopTurn}>
                {props.t("freebuff.turn.stop")}
              </button>
            </Show>
          </div>
          <div class="max-h-64 overflow-y-auto border border-base bg-compare-back px-2 py-1">
            <Show
              when={activeThreadEvents().length > 0}
              fallback={<p class="text-xs text-tertiary">{props.t("freebuff.turn.empty")}</p>}
            >
              <For each={activeThreadEvents()}>
                {(event) => <FreebuffEventRow t={props.t} event={event} />}
              </For>
            </Show>
          </div>
          <div class="flex gap-2">
            <textarea
              class="min-h-16 flex-1"
              value={composer()}
              onInput={(event) => setComposer(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault()
                  if (!sendDisabled()) handleSend()
                }
              }}
              placeholder={props.t("freebuff.turn.composerPlaceholder")}
            />
            <button type="button" disabled={sendDisabled()} onClick={handleSend}>
              {props.t("freebuff.turn.send")}
            </button>
          </div>
          <Show when={running()}>
            <p class="text-[10px] text-tertiary">{props.t("freebuff.turn.disabledReason")}</p>
          </Show>
        </section>
      </Show>

      <Show when={freebuffActiveThreadId()}>
        <button
          type="button"
          onClick={() => {
            const id = freebuffActiveThreadId()
            if (id) clearFreebuffEvents(id)
          }}
        >
          {props.t("freebuff.turn.clear")}
        </button>
      </Show>
    </div>
  )
}

function freebuffAccountEmail(): string | null {
  return freebuffStatus()?.auth?.email ?? null
}

function quotaUsedText(limit: number, recentCount: number): string {
  const used = Math.min(recentCount, limit)
  const remaining = Math.max(0, limit - used)
  return `${remaining} / ${limit}`
}

interface FreebuffThreadRowProps {
  t: (key: string, vars?: Record<string, any>) => string
  thread: FreebuffThreadView
  active: boolean
  onSelect: () => void
}

const FreebuffThreadRow: Component<FreebuffThreadRowProps> = (props) => {
  const running = () => props.thread.turnState === "running"
  return (
    <button
      type="button"
      class={`text-left ${props.active ? "right-panel-tab-active" : "right-panel-tab-inactive"}`}
      onClick={props.onSelect}
    >
      <span class="block truncate text-xs">{props.thread.title ?? props.thread.id}</span>
      <span class="block text-[10px] text-tertiary">
        {modelDisplayName(props.thread.model ?? DEFAULT_MODEL)}
        <Show when={running()}> - {props.t("freebuff.turn.running")}</Show>
      </span>
    </button>
  )
}

interface FreebuffEventRowProps {
  t: (key: string, vars?: Record<string, any>) => string
  event: { seq?: number; type: string; text?: string; toolName?: string; stage?: string; input?: unknown }
}

const FreebuffEventRow: Component<FreebuffEventRowProps> = (props) => {
  const event = () => props.event
  return (
    <div class="py-0.5">
      <Show when={event().type === "user"}>
        <p class="whitespace-pre-wrap text-xs text-primary">
          <span class="text-tertiary">{props.t("freebuff.turn.user")}:</span> {event().text}
        </p>
      </Show>
      <Show when={event().type === "text"}>
        <p class="whitespace-pre-wrap text-xs text-primary">{event().text}</p>
      </Show>
      <Show when={event().type === "reasoning" || event().type === "reasoning_delta"}>
        <p class="whitespace-pre-wrap text-xs text-tertiary">{event().text}</p>
      </Show>
      <Show when={event().type === "tool_call"}>
        <p class="text-xs text-secondary">
          <span class="text-tertiary">{props.t("freebuff.turn.tool")}:</span> {event().toolName}
        </p>
      </Show>
      <Show when={event().type === "status" || event().type === "start" || event().type === "finish"}>
        <p class="text-[10px] text-tertiary">{event().stage ?? event().type}</p>
      </Show>
      <Show when={event().type === "subagent_start"}>
        <p class="text-[10px] text-tertiary">{props.t("freebuff.turn.agent")}: {String(event().stage ?? "")}</p>
      </Show>
      <Show when={event().type === "error"}>
        <p class="text-xs text-danger">{event().text ?? event().stage}</p>
      </Show>
    </div>
  )
}

export default FreebuffTab
