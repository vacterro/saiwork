import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, type Component } from "solid-js"

import type { FreebuffRateLimit } from "../../../server/src/api-types"
import { FREEBUFF_MODELS } from "../../../server/src/freebuff/models"
import { useI18n } from "../lib/i18n"
import { formatQuotaCount } from "../lib/format-quota"
import { getActiveSession } from "../stores/session-state"
import {
  freebuffActiveThreadId,
  freebuffBusy,
  freebuffError,
  freebuffEventsFor,
  freebuffSlotActive,
  freebuffStatus,
  freebuffThreads,
  refreshFreebuffStatus,
  refreshFreebuffThreads,
  releaseFreebuffSlot,
  startFreebuffStatusPolling,
} from "../stores/freebuff"

interface FreebuffBarStatusProps {
  instanceId: string
}

function modelDisplayName(modelId: string): string {
  return FREEBUFF_MODELS.find((model) => model.id === modelId)?.displayName ?? modelId
}

function quotaLabel(t: (key: string, vars?: Record<string, unknown>) => string, limit: FreebuffRateLimit | null | undefined): string {
  if (!limit || limit.limit <= 0) return t("freebuff.quota.exhausted")
  const used = Math.min(limit.recentCount, limit.limit)
  const remaining = Math.max(0, limit.limit - used)
  return t("freebuff.bar.left", { remaining: formatQuotaCount(remaining), limit: formatQuotaCount(limit.limit) })
}

/**
 * Compact FreeBuff status chip for the SAIPEN bar.
 *
 * Only appears while the active session runs a `freebuff/*` model. Shows the
 * engine state, the per-model session quota (how many of the daily hosted
 * turns are left), the open thread count and the active thread's turn state.
 * Clicking expands a detail panel with the account, tier, per-model quota and
 * the open threads. Live data comes from the shared FreeBuff store, which this
 * component keeps polling while the chip is visible.
 */
const FreebuffBarStatus: Component<FreebuffBarStatusProps> = (props) => {
  const { t } = useI18n()
  const [expanded, setExpanded] = createSignal(false)
  const [anchor, setAnchor] = createSignal<{ left: number; bottom: number } | null>(null)
  let chipRef: HTMLButtonElement | undefined

  const activeSessionModel = createMemo(() => {
    const session = getActiveSession(props.instanceId)
    return session?.model ?? null
  })
  const isFreebuff = createMemo(() => activeSessionModel()?.providerId === "freebuff")
  const modelId = createMemo(() => activeSessionModel()?.modelId ?? "")

  const status = freebuffStatus
  const quota = createMemo(() => status()?.quota?.snapshot ?? null)
  const currentLimit = createMemo(() => {
    const limits = quota()?.rateLimitsByModel
    if (!limits) return null
    return Object.values(limits).find((entry) => entry.model === modelId())
      ?? Object.values(limits)[0]
      ?? null
  })
  const openThreads = createMemo(() => freebuffThreads().filter((thread) => thread.status === "open"))
  const activeThread = createMemo(() => openThreads().find((thread) => thread.id === freebuffActiveThreadId()) ?? null)
  const running = createMemo(() => activeThread()?.turnState === "running")
  const engineDot = createMemo(() => {
    if (freebuffBusy()) return "busy"
    if (status()?.ready) return "ready"
    return "off"
  })

  createEffect(() => {
    if (!isFreebuff()) return
    const stopPolling = startFreebuffStatusPolling()
    onCleanup(stopPolling)
  })

  createEffect(() => {
    if (isFreebuff()) {
      void refreshFreebuffStatus()
      void refreshFreebuffThreads()
    }
  })

  createEffect(() => {
    if (isFreebuff() && status()?.ready) void refreshFreebuffThreads()
  })

  // The bar's container clips overflow on both axes, so an absolutely
  // positioned panel above the chip is cut off (the chip looked dead). Anchor
  // the panel with position:fixed to the chip's viewport rect instead, and
  // close it on an outside click.
  createEffect(() => {
    if (!expanded()) return
    const close = (event: MouseEvent) => {
      if (chipRef && !chipRef.contains(event.target as Node)) setExpanded(false)
    }
    document.addEventListener("mousedown", close)
    onCleanup(() => document.removeEventListener("mousedown", close))
  })

  const openPanel = (event: MouseEvent) => {
    if (chipRef) {
      const rect = chipRef.getBoundingClientRect()
      setAnchor({ left: rect.left, bottom: window.innerHeight - rect.top + 4 })
    }
    setExpanded((current) => !current)
    event.preventDefault()
    event.stopPropagation()
  }

  return (
    <Show when={isFreebuff()}>
      <div class="saipen-freebuff">
        <button
          type="button"
          ref={chipRef}
          class="saipen-freebuff-chip"
          data-state={engineDot()}
          aria-expanded={expanded()}
          onClick={openPanel}
          title={t("freebuff.bar.title")}
        >
          <span class="saipen-freebuff-dot" />
          <span class="saipen-freebuff-model">{modelId() ? modelDisplayName(modelId()) : "FreeBuff"}</span>
          <span class="saipen-freebuff-meta">
            {quotaLabel(t, currentLimit())}
            <Show when={running()}> · {t("freebuff.turn.running")}</Show>
            <Show when={openThreads().length > 0}> · {t("freebuff.threads.count", { count: openThreads().length })}</Show>
          </span>
          <span class="saipen-freebuff-chevron">{expanded() ? "▾" : "▸"}</span>
        </button>

        <Show when={expanded() && anchor()}>
          <div
            class="saipen-freebuff-panel"
            role="region"
            style={{ left: `${anchor()!.left}px`, bottom: `${anchor()!.bottom}px` }}
          >
            <Show when={freebuffError()} keyed>
              {(message) => <p class="saipen-freebuff-error">{message}</p>}
            </Show>

            <div class="saipen-freebuff-row">
              <span class="saipen-freebuff-label">{t("freebuff.engine.title")}</span>
              <span>
                {freebuffBusy()
                  ? t("freebuff.engine.starting")
                  : status()?.ready
                    ? t("freebuff.engine.ready")
                    : t("freebuff.engine.stopped")}
                <Show when={status()?.ready && status()?.port}> · :{status()?.port}</Show>
              </span>
            </div>

            <Show when={status()?.auth?.email}>
              <div class="saipen-freebuff-row">
                <span class="saipen-freebuff-label">{t("freebuff.bar.account")}</span>
                <span class="saipen-freebuff-truncate">{status()?.auth?.email}</span>
              </div>
            </Show>

            <Show when={quota()}>
              <div class="saipen-freebuff-row">
                <span class="saipen-freebuff-label">{t("freebuff.quota.tier", { tier: quota()?.accessTier ?? "" })}</span>
                <span>{t("freebuff.bar.slot")}</span>
              </div>
              <div class="saipen-freebuff-row">
                <span class="saipen-freebuff-label">{t("freebuff.slot.title")}</span>
                <span>{freebuffSlotActive() ? t("freebuff.slot.busy") : t("freebuff.slot.free")}</span>
              </div>
            </Show>

            <button
              type="button"
              class="saipen-freebuff-action"
              disabled={freebuffBusy()}
              onClick={() => void releaseFreebuffSlot()}
            >
              {freebuffBusy() ? t("freebuff.slot.releasing") : t("freebuff.slot.release")}
            </button>

            <Show when={quota()?.rateLimitsByModel}>
              <div class="saipen-freebuff-sub">
                <p class="saipen-freebuff-subtitle">{t("freebuff.quota.title")}</p>
                <For each={Object.values(quota()?.rateLimitsByModel ?? {})}>
                  {(entry) => (
                    <div class="saipen-freebuff-row">
                      <span class="saipen-freebuff-truncate">{modelDisplayName(entry.model)}</span>
                      <span>{quotaLabel(t, entry)}</span>
                    </div>
                  )}
                </For>
              </div>
            </Show>

            <div class="saipen-freebuff-sub">
              <p class="saipen-freebuff-subtitle">{t("freebuff.threads.title")}</p>
              <Show
                when={openThreads().length > 0}
                fallback={<p class="saipen-freebuff-empty">{t("freebuff.threads.none")}</p>}
              >
                <For each={openThreads()}>
                  {(thread) => (
                    <div class="saipen-freebuff-row">
                      <span class="saipen-freebuff-truncate">{thread.title ?? thread.id}</span>
                      <span>
                        {modelDisplayName(thread.model ?? modelId())}
                        <Show when={thread.turnState === "running"}> · {t("freebuff.turn.running")}</Show>
                        <Show when={freebuffEventsFor(thread.id).length > 0}>
                          · {t("freebuff.bar.events", { count: freebuffEventsFor(thread.id).length })}
                        </Show>
                      </span>
                    </div>
                  )}
                </For>
              </Show>
            </div>
          </div>
        </Show>
      </div>
    </Show>
  )
}

export default FreebuffBarStatus
