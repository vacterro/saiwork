import { For, Match, Show, Switch, createMemo, createSignal, onCleanup, onMount, type Component, type JSX } from "solid-js"
import { useI18n } from "../lib/i18n"
import { serverApi, SaipenConflictError } from "../lib/api-client"
import { getLogger } from "../lib/logger"
import type { SaipenViewResponse } from "../../../server/src/api-types"
import { externalChangeAction, parseLogLines, parseStateFrontmatter } from "../lib/saipen-view"
import { serverEvents } from "../lib/server-events"
import "../styles/components/saipen-view.css"

const log = getLogger("actions")

/** Folder comparison tolerant of trailing separators and case differences. */
function sameFolder(a: string, b: string): boolean {
  const normalize = (value: string) => value.replace(/[\\/]+$/, "").toLowerCase()
  return normalize(a) === normalize(b)
}

export type SaipenViewTab = "status" | "board" | "log" | "state" | "plan"

interface SaipenViewPanelProps {
  folder: string
  tab: SaipenViewTab
  onTabChange: (tab: SaipenViewTab) => void
  /** Kept mounted but hidden so toggling never re-fetches. */
  collapsed?: boolean
  /** Re-fetches the Status tab's data too, so edits elsewhere stop it going stale. */
  onRefreshStatus?: () => void
  /** The existing status table body; rendered under the "Status" tab. */
  statusSlot?: () => JSX.Element
}

/**
 * SAIPENVIEW: the project's live STATE/BOARD/LOG in one panel.
 *
 * The status endpoint answers "is this healthy and does anything need me";
 * this panel answers "show me the actual files". Everything is read-only and
 * fetched on demand -- never polled, so content cannot move under the reader.
 */
const SaipenViewPanel: Component<SaipenViewPanelProps> = (props) => {
  const { t } = useI18n()
  const [view, setView] = createSignal<SaipenViewResponse | null>(null)
  const [loadError, setLoadError] = createSignal<string | null>(null)
  const [openPlans, setOpenPlans] = createSignal<Set<string>>(new Set())
  const [editing, setEditing] = createSignal<{ path: string; content: string; revision: string } | null>(null)
  const [draft, setDraft] = createSignal("")
  const [conflict, setConflict] = createSignal<string | null>(null)

  function togglePlan(name: string) {
    setOpenPlans((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  function beginEdit(path: string, content: string) {
    setDraft(content)
    setEditing({ path, content, revision: view()?.revisions?.[path] ?? "" })
    setConflict(null)
  }

  function cancelEdit() {
    setEditing(null)
    setDraft("")
    setConflict(null)
  }

  async function saveEdit() {
    const current = editing()
    if (!current) return
    try {
      await serverApi.writeSaipenFile(props.folder, current.path, draft(), current.revision)
      setEditing(null)
      setDraft("")
      setConflict(null)
      await refresh()
    } catch (error) {
      if (error instanceof SaipenConflictError) {
        setConflict(error.message)
        // Fetch the real current disk state so "Reload current" cannot hand the
        // user the stale bytes the failed save was based on.
        void refresh()
        return
      }
      log.error("Failed to save saipen file:", error)
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }

  function reloadCurrent() {
    const current = editing()
    if (!current) return
    const value = view()
    let fresh = ""
    if (current.path === "BOARD.md") fresh = value?.board ?? ""
    else if (current.path === "STATE.md") fresh = value?.state ?? ""
    else if (current.path.startsWith("kitchen/")) {
      const name = current.path.slice("kitchen/".length)
      fresh = value?.plans?.find((plan) => plan.name === name)?.content ?? ""
    }
    setDraft(fresh)
    setConflict(null)
  }

  /** Keeps the local draft editable; the user can copy it before deciding. */
  function keepDraft() {
    setConflict(null)
  }

  /**
   * Live protocol mutations: the server watcher publishes a debounced,
   * workspace-scoped `saipen.changed` event. A clean editor refreshes
   * automatically; a dirty editor for the touched file keeps its draft and
   * marks the conflict so the user resolves it explicitly. A change to some
   * other file never disturbs an open draft.
   */
  function handleExternalChange(changedFiles: string[]) {
    const current = editing()
    const action = externalChangeAction(current?.path ?? null, changedFiles)
    if (action === "conflict") {
      setConflict(t("saipenView.externalChanged"))
      // Keep the draft untouched, but refresh the rendered view so "Reload
      // current" presents the genuinely current disk version.
      void refresh()
      return
    }
    void refresh()
  }

  const currentTabPath = (): string | null => {
    if (props.tab === "board") return "BOARD.md"
    if (props.tab === "state") return "STATE.md"
    if (props.tab === "log") return "LOG.md"
    return null
  }

  async function refresh() {
    try {
      const next = await serverApi.fetchSaipenView(props.folder)
      setView(next)
      setLoadError(null)
    } catch (error) {
      log.error("Failed to load SAIPEN view:", error)
      setLoadError(error instanceof Error ? error.message : String(error))
    }
    // A project edit can change the parsed status too; refresh both.
    props.onRefreshStatus?.()
  }

  onMount(() => {
    void refresh()
    const stopEvents = serverEvents.on("saipen.changed", (event) => {
      if (event.type !== "saipen.changed") return
      if (!sameFolder(event.folder, props.folder)) return
      handleExternalChange(event.files)
    })
    onCleanup(stopEvents)
  })

  const currentTabContent = (): string => {
    const value = view()
    if (props.tab === "board") return value?.board ?? ""
    if (props.tab === "state") return value?.state ?? ""
    if (props.tab === "log") return value?.log ?? ""
    return ""
  }

  return (
    <div class="saipen-view" data-collapsed={props.collapsed ? "true" : "false"}>
      <div class="saipen-view-actions">
        <Show when={currentTabPath() && !editing()}>
          <button
            type="button"
            class="saipen-view-edit-toggle"
            onClick={() => beginEdit(currentTabPath()!, currentTabContent())}
          >
            {t("saipenView.edit")}
          </button>
        </Show>
        <button type="button" class="saipen-view-refresh" onClick={() => void refresh()}>
          {t("saipen.refresh")}
        </button>
      </div>

      <Show when={loadError()}>
        <p class="saipen-bar-error">{loadError()}</p>
      </Show>

      <Show when={props.tab === "status"}>
        <div class="saipen-view-body">{props.statusSlot?.()}</div>
      </Show>

      <Show when={props.tab === "plan"}>
        <div class="saipen-view-plans">
          <Show
            when={(view()?.plans.length ?? 0) > 0}
            fallback={<p class="saipen-view-empty">{t("saipenView.noPlans")}</p>}
          >
            <For each={view()?.plans ?? []}>
              {(plan) => (
                <div class="saipen-view-plan">
                  <button
                    type="button"
                    class="saipen-view-plan-toggle"
                    aria-expanded={openPlans().has(plan.name)}
                    onClick={() => togglePlan(plan.name)}
                  >
                    {openPlans().has(plan.name) ? "-" : "+"} {plan.name}
                  </button>
                  <button
                    type="button"
                    class="saipen-view-plan-edit"
                    onClick={() => beginEdit(`kitchen/${plan.name}`, plan.content)}
                  >
                    {t("saipenView.edit")}
                  </button>
                  <Show when={openPlans().has(plan.name)}>
                    <pre class="saipen-view-plan-content">{plan.content}</pre>
                  </Show>
                </div>
              )}
            </For>
          </Show>
        </div>
      </Show>

      <Show when={props.tab === "board" || props.tab === "log" || props.tab === "state"}>
        <Show when={view()?.missing} fallback={<BoardLogState tab={props.tab} view={view()} />}>
          <p class="saipen-view-empty">{t("saipenView.empty")}</p>
        </Show>
      </Show>

      <Show when={editing()}>
        <Show when={conflict()}>
          <div class="saipen-view-conflict">
            <p class="saipen-view-conflict-text">
              {t("saipenView.conflict")} {conflict()}
            </p>
            <div class="saipen-view-edit-actions">
              <button type="button" onClick={reloadCurrent}>
                {t("saipenView.conflictReload")}
              </button>
              <button type="button" onClick={keepDraft}>
                {t("saipenView.conflictKeepDraft")}
              </button>
            </div>
          </div>
        </Show>
        <div class="saipen-view-edit">
          <textarea
            class="saipen-view-edit-area"
            value={draft()}
            onInput={(event) => setDraft(event.currentTarget.value)}
          />
          <div class="saipen-view-edit-actions">
            <button type="button" onClick={() => void saveEdit()}>
              {t("promptQueue.save")}
            </button>
            <button type="button" onClick={cancelEdit}>
              {t("promptQueue.cancel")}
            </button>
          </div>
        </div>
      </Show>
    </div>
  )
}

/**
 * Board, Log and State.
 *
 * Branches with `Switch`, not `if`. A Solid component body runs once, so an
 * `if (props.tab === ...)` chain froze on whichever tab happened to be active
 * at mount -- Board -- and the Log and State tabs then rendered Board's
 * markup for the rest of the session while their own tab looked selected.
 * The parser calls are memos for the same reason: read at render, not once.
 */
function BoardLogState(props: { tab: SaipenViewTab; view: SaipenViewResponse | null }) {
  const { t } = useI18n()

  // Sections are parsed server-side by the canonical BOARD parser; the panel
  // only renders the structured payload.
  const sections = () => props.view?.boardSections ?? []
  const lines = createMemo(() => parseLogLines(props.view?.log ?? null))
  const fields = createMemo(() => parseStateFrontmatter(props.view?.state ?? null))
  const hasState = () => (props.view?.state?.trim().length ?? 0) > 0

  return (
    <Switch>
      <Match when={props.tab === "board"}>
        <Show
          when={sections().some((section) => section.tickets.length > 0)}
          fallback={<p class="saipen-view-empty">{t("saipenView.boardEmpty")}</p>}
        >
          <div class="saipen-view-board">
            <For each={sections()}>
              {(section) => (
                <Show when={section.tickets.length > 0}>
                  <section>
                    <h4>{section.title}</h4>
                    <For each={section.tickets}>
                      {(ticket) => (
                        <p class="saipen-view-ticket" data-status={ticket.status}>
                          <span class="saipen-view-ticket-id">{ticket.id}</span>
                          <span class="saipen-view-ticket-text">{ticket.text}</span>
                        </p>
                      )}
                    </For>
                  </section>
                </Show>
              )}
            </For>
          </div>
        </Show>
      </Match>

      <Match when={props.tab === "log"}>
        <div class="saipen-view-log">
          <Show when={props.view?.logTruncated}>
            <p class="saipen-view-note">{t("saipenView.logTruncated", { count: 200 })}</p>
          </Show>
          <Show when={lines().length > 0} fallback={<p class="saipen-view-empty">{t("saipenView.logEmpty")}</p>}>
            <For each={lines()}>
              {(line) => <p class="saipen-view-log-line">{line}</p>}
            </For>
          </Show>
        </div>
      </Match>

      <Match when={props.tab === "state"}>
        <Show when={hasState()} fallback={<p class="saipen-view-empty">{t("saipenView.stateEmpty")}</p>}>
          <StateFields fields={fields()} />
        </Show>
      </Match>
    </Switch>
  )
}

function StateFields(props: { fields: ReturnType<typeof parseStateFrontmatter> }) {
  const fields = () => props.fields
  return (
    <div class="saipen-view-state">
      <For each={[
        ["phase", fields().phase],
        ["task", fields().task],
        ["next_action", fields().nextAction],
        ["blocker", fields().blocker],
        ["execution_intent", fields().executionIntent],
        ["updated", fields().updated],
        ["agent", fields().agent],
        ["role_revision", fields().roleRevision],
        ["saipen_home", fields().saipenHome],
      ]}>
        {(entry) => (
          <p class="saipen-view-field">
            <span class="saipen-view-field-key">{entry[0]}</span>
            <span class="saipen-view-field-value">{entry[1] ?? "-"}</span>
          </p>
        )}
      </For>
    </div>
  )
}

export default SaipenViewPanel
