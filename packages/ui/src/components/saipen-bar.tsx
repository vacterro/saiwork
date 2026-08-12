import { For, Show, createSignal, createEffect, onCleanup, onMount, type Component } from "solid-js"
import { useI18n } from "../lib/i18n"
import { getLogger } from "../lib/logger"
import { serverApi } from "../lib/api-client"
import { SAIPEN_COMMANDS, SAIPEN_CATEGORIES, type SaipenCommand } from "../lib/saipen-commands"
import { getSaipenSubLifecycleKey, getSaipenSubPackageCounts, getSaipenSubPackageKey, isSaipenSubReady } from "../lib/saipen-sub-status"
import type { SaipenStatusResponse } from "../../../server/src/api-types"
import { formatElapsedClock } from "../lib/message-timing"
import SaipenViewPanel, { type SaipenViewTab } from "./saipen-view-panel"
import FreebuffBarStatus from "./freebuff-bar-status"

const log = getLogger("actions")

interface SaipenBarProps {
  /** Workspace folder, used to resolve the project's own .saipen state. */
  folder: string
  /** Instance id, used to read the active session's model for the FreeBuff chip. */
  instanceId?: string
  /** Sends the shortcut as the entire message, which is what the protocol expects. */
  onRunShortcut: (shortcut: string) => void
  /** Puts the shortcut in the prompt for the user to complete. */
  onInsertShortcut: (text: string) => void
  /** Goal Auto: keep sending `saipen continue` while the board has work. */
  goalAutoEnabled?: boolean
  /** Goal Auto needs the queue; when the queue is off it cannot run at all. */
  goalAutoBlockedByQueue?: boolean
  /** Goal Auto stands down when the session model's daily quota is exhausted. */
  goalAutoBlockedByQuota?: boolean
  onToggleGoalAuto?: () => void
  goalAutoLimit?: number | null
  onSetGoalAutoLimit?: (limit: number | null) => void
  /** Shortcuts send immediately when idle and queue while working (vs follow the queue policy). */
  shortcutsImmediate?: boolean
  onToggleShortcutsImmediate?: () => void
  /** Opens the split-session picker. */
  onSplitPane?: () => void
  /** Elapsed ms since the agent started responding; shown as a live clock. */
  responseElapsedMs?: number
}

/**
 * SAIPEN command bar.
 *
 * Two kinds of control, and each one always behaves the same way:
 * argument-less shortcuts run on click, argument-taking ones (`gg`, `dd`) land
 * in the prompt so the user can finish the sentence. The status list is loaded
 * on mount and on an explicit refresh -- never polled, because content moving
 * under a reading eye is the surprise the UI rules exist to prevent.
 */
const SaipenBar: Component<SaipenBarProps> = (props) => {
  const { t } = useI18n()
  const [status, setStatus] = createSignal<SaipenStatusResponse | null>(null)
  const [loadError, setLoadError] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [expanded, setExpanded] = createSignal(false)
  const [viewTab, setViewTab] = createSignal<SaipenViewTab>("status")
  const [limitMenuOpen, setLimitMenuOpen] = createSignal(false)
  const [limitMenuPos, setLimitMenuPos] = createSignal({ x: 0, y: 0 })
  let limitMenuRef: HTMLDivElement | undefined

  createEffect(() => {
    if (limitMenuOpen()) {
      const close = (e: MouseEvent) => {
        if (limitMenuRef && !limitMenuRef.contains(e.target as Node)) {
          setLimitMenuOpen(false)
        }
      }
      document.addEventListener("mousedown", close)
      onCleanup(() => document.removeEventListener("mousedown", close))
    }
  })

  async function refresh() {
    setLoading(true)
    try {
      const next = await serverApi.fetchSaipenStatus(props.folder)
      setStatus(next)
      setLoadError(null)
    } catch (error) {
      log.error("Failed to load SAIPEN status:", error)
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }

  onMount(() => {
    void refresh()
  })

  let scrollContainer: HTMLDivElement | undefined
  let dragState: { pointerId: number; startX: number; scrollLeft: number } | undefined

  function endScrollDrag(event?: PointerEvent) {
    if (!dragState || (event && dragState.pointerId !== event.pointerId)) return
    const pointerId = dragState.pointerId
    dragState = undefined
    if (!scrollContainer?.hasPointerCapture(pointerId)) return
    try {
      scrollContainer.releasePointerCapture(pointerId)
    } catch {
      // Capture may already have been released by the browser.
    }
  }

  function handlePointerDown(event: PointerEvent) {
    if (event.button !== 1 || !scrollContainer) return
    event.preventDefault()
    dragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      scrollLeft: scrollContainer.scrollLeft,
    }
    try {
      scrollContainer.setPointerCapture(event.pointerId)
    } catch {
      dragState = undefined
    }
  }

  function handlePointerMove(event: PointerEvent) {
    if (!dragState || dragState.pointerId !== event.pointerId || !scrollContainer) return
    if ((event.buttons & 4) === 0) {
      endScrollDrag(event)
      return
    }
    event.preventDefault()
    scrollContainer.scrollLeft = dragState.scrollLeft - (event.clientX - dragState.startX)
  }

  function handleWheel(event: WheelEvent) {
    if (!scrollContainer || scrollContainer.scrollWidth <= scrollContainer.clientWidth) return
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
    if (delta === 0) return
    const maxScrollLeft = scrollContainer.scrollWidth - scrollContainer.clientWidth
    const nextScrollLeft = Math.max(0, Math.min(maxScrollLeft, scrollContainer.scrollLeft + delta))
    if (nextScrollLeft === scrollContainer.scrollLeft) return
    event.preventDefault()
    scrollContainer.scrollLeft = nextScrollLeft
  }

  function activate(command: SaipenCommand) {
    if (command.argument === "required") {
      props.onInsertShortcut(`${command.shortcut} `)
      return
    }
    props.onRunShortcut(command.shortcut)
  }

  /** Production round-trips are the first to hide on a narrow bar. */
  function commandTier(command: SaipenCommand): string {
    return ["ccc", "ee", "eee", "qq", "qqq", "pp"].includes(command.shortcut) ? "rare" : "core"
  }

  /**
   * Reports what the running session actually has, not what the settings say.
   *
   * Injection happens once at workspace launch, so after a settings change the
   * configured answer describes a session that does not exist yet. When a
   * workspace is running, its launch state is the truth.
   */
  const coreLine = () => {
    const current = status()
    if (!current) return t("saipen.core.unknown")

    const effective = current.effective
    if (effective) {
      if (!effective.enabled) return t("saipen.core.disabled")
      if (effective.instructions.length === 0) return t("saipen.core.noFiles")
      return t("saipen.core.loaded", {
        count: effective.instructions.length,
        dir: effective.protocolDir ?? "",
      })
    }

    if (!current.enabled) return t("saipen.core.disabled")
    if (current.error) return current.error
    if (current.instructions.length === 0) return t("saipen.core.noFiles")
    return t("saipen.core.loaded", { count: current.instructions.length, dir: current.protocolDir ?? "" })
  }

  /**
   * Three states, not two: "on", "off", and "on but the queue is off so it
   * cannot actually run". Collapsing the third into "on" is what made Goal Auto
   * feel broken -- the switch said yes and nothing ever happened.
   */
  const goalAutoState = () => {
    if (!props.goalAutoEnabled) return "off"
    return props.goalAutoBlockedByQueue || props.goalAutoBlockedByQuota ? "blocked" : "on"
  }

  const goalAutoLabelKey = () => {
    const state = goalAutoState()
    if (state === "off") return "saipen.goalAuto.off"
    return state === "blocked" ? "saipen.goalAuto.blocked" : "saipen.goalAuto.on"
  }

  const goalAutoTitle = () => {
    const state = goalAutoState()
    if (state === "off") return t("saipen.goalAuto.offHint")
    if (state === "blocked" && props.goalAutoBlockedByQuota) return t("saipen.goalAuto.blockedByQuotaHint")
    if (state === "blocked") return t("saipen.goalAuto.blockedHint")
    const project = status()?.project
    if (!project) return t("saipen.goalAuto.onHint")
    // A WAIT next_action is a human brake (e.g. untriaged MARKHUNT findings):
    // Goal Auto must not push past it, and the reason must be visible.
    if (project.nextAction?.startsWith("WAIT:")) return t("saipen.goalAuto.onWaitHint")
    const pending = project.todoCount + project.doingCount
    if (pending === 0) return t("saipen.goalAuto.onIdleHint")
    return t("saipen.goalAuto.onWorkHint", { count: pending })
  }

  function packageTitle(sub: SaipenStatusResponse["subs"][number]): string | undefined {
    const counts = getSaipenSubPackageCounts(sub.packageCounts)
    const details = counts.map(([status, count]) => `${t(getSaipenSubPackageKey(status))}: ${count}`)
    return details.join("; ") || undefined
  }

  /** The live sub state for a shortcut's `sub`, if the server reported it. */
  function subState(sub?: string): SaipenStatusResponse["subs"][number] | undefined {
    if (!sub) return undefined
    return status()?.subs.find((entry) => entry.name === sub)
  }

  /** True when the sub's package is ready. */
  function isSubReady(sub?: string): boolean {
    return isSaipenSubReady(subState(sub)?.packageStatus)
  }

  /** Status tooltip: verdict plus the package-count breakdown. */
  function subReadyTitle(sub?: string): string {
    const state = subState(sub)
    if (!state) return t("saipen.subs.ready.unknown")
    const counts = packageTitle(state)
    return counts ? `${t(getSaipenSubPackageKey(state.packageStatus))} — ${counts}` : t(getSaipenSubPackageKey(state.packageStatus))
  }

  return (
    <section class="saipen-bar" aria-label={t("saipen.title")}>
      <div 
        class="saipen-bar-commands"
        ref={scrollContainer}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endScrollDrag}
        onPointerCancel={endScrollDrag}
        onLostPointerCapture={() => {
          dragState = undefined
        }}
        onAuxClick={(event) => {
          if (event.button === 1) event.preventDefault()
        }}
        onWheel={handleWheel}
      >
        <div class="saipen-bar-group saipen-bar-left">
          <Show when={props.instanceId}>
            <FreebuffBarStatus instanceId={props.instanceId!} />
          </Show>
          <Show when={props.onToggleGoalAuto}>
            <button
              type="button"
              class="saipen-goal-auto"
              data-state={goalAutoState()}
              aria-pressed={Boolean(props.goalAutoEnabled)}
              onClick={() => props.onToggleGoalAuto?.()}
              onContextMenu={(e) => {
                e.preventDefault()
                setLimitMenuPos({ x: e.clientX, y: e.clientY })
                setLimitMenuOpen(true)
              }}
              title={goalAutoTitle()}
            >
              {t(goalAutoLabelKey())}
              <Show when={props.goalAutoLimit != null}>
                <span style={{ "font-size": "0.85em", opacity: 0.8, "margin-left": "4px" }}>({props.goalAutoLimit})</span>
              </Show>
            </button>
            <Show when={limitMenuOpen()}>
              <div 
                ref={limitMenuRef}
                style={{
                  position: "fixed",
                  top: `${limitMenuPos().y}px`,
                  left: `${limitMenuPos().x}px`,
                  "z-index": 10000,
                  "background-color": "var(--color-surface)",
                  border: "2px solid var(--color-border-subtle)",
                  "border-right-color": "var(--color-border-shadow)",
                  "border-bottom-color": "var(--color-border-shadow)",
                  padding: "4px",
                  display: "flex",
                  "flex-direction": "column",
                  gap: "2px",
                  "min-width": "120px",
                  "box-shadow": "2px 2px 5px rgba(0,0,0,0.5)"
                }}
              >
                <div style={{ padding: "4px 8px", "font-weight": "bold", "border-bottom": "1px solid var(--color-border-shadow)", "margin-bottom": "4px" }}>
                  Limit Goal Auto
                </div>
                <button 
                  class="flat-button" 
                  style={{ "text-align": "left", "padding": "4px 8px", width: "100%", "background-color": props.goalAutoLimit === null ? "var(--color-surface-sunken)" : "transparent" }}
                  onClick={() => { props.onSetGoalAutoLimit?.(null); setLimitMenuOpen(false) }}
                >
                  Infinitely
                </button>
                <For each={[1, 3, 5, 10, 20]}>
                  {(num) => (
                    <button 
                      class="flat-button" 
                      style={{ "text-align": "left", "padding": "4px 8px", width: "100%", "background-color": props.goalAutoLimit === num ? "var(--color-surface-sunken)" : "transparent" }}
                      onClick={() => { props.onSetGoalAutoLimit?.(num); setLimitMenuOpen(false) }}
                    >
                      Up to {num} times
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </Show>

          <Show when={props.responseElapsedMs != null && props.responseElapsedMs > 0}>
            <span
              class="saipen-response-timer"
              title={t("saipen.responseTimer.hint")}
            >
              {formatElapsedClock(props.responseElapsedMs)}
            </span>
          </Show>
        </div>

        <div class="saipen-bar-group saipen-bar-center">
          <For each={SAIPEN_CATEGORIES}>
            {(category) => (
              <div
                class="saipen-command-category"
                role="group"
                aria-label={t(`saipen.category.${category}`)}
              >
                <For each={SAIPEN_COMMANDS.filter((command) => command.category === category)}>
                  {(command) => (
                    <span class="saipen-command-unit">
                      <button
                        type="button"
                        class="saipen-command"
                        data-tier={commandTier(command)}
                        data-sub-state={command.sub && !command.ships && subState(command.sub)
                          ? isSubReady(command.sub) ? "ready" : "pending"
                          : undefined}
                        onClick={() => activate(command)}
                        title={`${command.shortcut} — ${command.verb} - ${command.summary}${
                          command.argument === "required"
                            ? ` (${t("saipen.insertsIntoPrompt")})`
                            : typeof props.shortcutsImmediate === "boolean"
                              ? ` · ${props.shortcutsImmediate ? t("saipen.shortcutMode.runsNow") : t("saipen.shortcutMode.followsQueue")}`
                              : ""
                        }${command.sub && !command.ships ? ` · ${subReadyTitle(command.sub)}` : ""}`}
                      >
                        {command.shortcut}
                      </button>
                    </span>
                  )}
                </For>
              </div>
            )}
          </For>

          <Show when={props.onToggleShortcutsImmediate}>
            <button
              type="button"
              class="saipen-shortcut-mode"
              data-mode={props.shortcutsImmediate ? "immediate" : "queue"}
              aria-pressed={Boolean(props.shortcutsImmediate)}
              onClick={() => props.onToggleShortcutsImmediate?.()}
              title={
                props.shortcutsImmediate
                  ? t("saipen.shortcutMode.immediateHint")
                  : t("saipen.shortcutMode.queueHint")
              }
            >
              {props.shortcutsImmediate
                ? t("saipen.shortcutMode.immediate")
                : t("saipen.shortcutMode.queue")}
            </button>
          </Show>
        </div>

        <div class="saipen-bar-group saipen-bar-right">
          <Show when={props.onSplitPane}>
            <button
              type="button"
              class="saipen-split"
              title={t("saipenView.splitHint")}
              onClick={() => props.onSplitPane?.()}
            >
              {t("saipenView.split")}
            </button>
          </Show>
          <For each={[
            ["status", t("saipenView.tab.status")],
            ["board", t("saipenView.tab.board")],
            ["log", t("saipenView.tab.log")],
            ["state", t("saipenView.tab.state")],
            ["plan", t("saipenView.tab.plan")],
          ] as Array<[SaipenViewTab, string]>}>
            {(entry) => (
              <button
                type="button"
                class="saipen-view-toggle"
                data-expanded={viewTab() === entry[0] && expanded() ? "true" : "false"}
                aria-pressed={viewTab() === entry[0]}
                onClick={() => {
                  if (viewTab() === entry[0] && expanded()) {
                    setExpanded(false)
                    return
                  }
                  setViewTab(entry[0])
                  setExpanded(true)
                }}
              >
                {entry[1]}
              </button>
            )}
          </For>
          <button type="button" onClick={() => void refresh()} disabled={loading()}>
            {loading() ? "..." : t("saipen.refresh")}
          </button>
        </div>
      </div>

      {/* The settings moved but the running session did not. Said plainly,
          because the alternative is a bar that reports a state no session has. */}
      <Show when={status()?.restartRequired}>
        <p class="saipen-restart-required">{t("saipen.core.restartRequired")}</p>
      </Show>

      <SaipenViewPanel
        folder={props.folder}
        tab={viewTab()}
        collapsed={!expanded()}
        onTabChange={setViewTab}
        onRefreshStatus={() => void refresh()}
        statusSlot={() => (
            <div class="saipen-bar-status">
              <Show when={loadError()}>
                <p class="saipen-bar-error">{loadError()}</p>
              </Show>

              <Show when={(status()?.missing.length ?? 0) > 0}>
                <p class="saipen-bar-error">
                  {t("saipen.missingFiles", { files: (status()?.missing ?? []).join(", ") })}
                </p>
              </Show>

              <Show
                when={(status()?.subs.length ?? 0) > 0}
                fallback={<p class="saipen-bar-empty">{t("saipen.noSubs")}</p>}
              >
                <table class="saipen-subs">
                  <thead>
                    <tr>
                      <th>{t("saipen.subs.name")}</th>
                      <th>{t("saipen.subs.lifecycle")}</th>
                      <th>{t("saipen.subs.phase")}</th>
                      <th>{t("saipen.subs.task")}</th>
                      <th>{t("saipen.subs.package")}</th>
                      <th>{t("saipen.subs.updated")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={status()?.subs ?? []}>
                      {(sub) => (
                        <tr>
                          <td>{sub.name}</td>
                          <td
                            class="saipen-sub-verdict"
                            data-verdict={sub.lifecycle}
                          >
                            {t(getSaipenSubLifecycleKey(sub.lifecycle))}
                          </td>
                          <td>{sub.phase ?? "-"}</td>
                          <td title={sub.nextAction ?? undefined}>{sub.task ?? "-"}</td>
                          <td
                            class="saipen-sub-verdict"
                            data-verdict={sub.packageStatus}
                            title={packageTitle(sub)}
                          >
                            {t(getSaipenSubPackageKey(sub.packageStatus))}
                          </td>
                          <td>{sub.updated ?? "-"}</td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </Show>
            </div>
          )}
        />
    </section>
  )
}

export default SaipenBar
