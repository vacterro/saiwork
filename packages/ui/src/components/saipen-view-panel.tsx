import { For, Match, Show, Switch, createMemo, createSignal, onCleanup, onMount, type Component, type JSX } from "solid-js"
import { useI18n } from "../lib/i18n"
import { serverApi, SaipenConflictError } from "../lib/api-client"
import { getLogger } from "../lib/logger"
import type { SaipenViewResponse } from "../../../server/src/api-types"
import {
  externalChangeAction,
  isSaipenDraftDirty,
  keepSaipenDraft,
  parseLogLines,
  parseStateFrontmatter,
  reconcileSaipenSave,
  reloadSaipenEditor,
  type SaipenEditingFile,
} from "../lib/saipen-view"
import { serverEvents } from "../lib/server-events"
import "../styles/components/saipen-view.css"

const log = getLogger("actions")

/** Folder equality for the no-workspaceId fallback: trailing separators trimmed, NO case folding. */
function sameFolder(a: string, b: string): boolean {
  const normalize = (value: string) => value.replace(/[\\/]+$/, "")
  return normalize(a) === normalize(b)
}

export type SaipenViewTab = "status" | "board" | "log" | "state" | "plan"

interface SaipenViewPanelProps {
  folder: string
  /** Canonical workspace identity for `saipen.changed` filtering. */
  workspaceId?: string
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
 * this panel answers "show me the actual files". LOG is read-only; editable
 * files use revisioned writes. Data is event-driven rather than polled.
 */
const SaipenViewPanel: Component<SaipenViewPanelProps> = (props) => {
  const { t } = useI18n()
  const [view, setView] = createSignal<SaipenViewResponse | null>(null)
  const [loadError, setLoadError] = createSignal<string | null>(null)
  const [openPlans, setOpenPlans] = createSignal<Set<string>>(new Set())
  const [editing, setEditing] = createSignal<SaipenEditingFile | null>(null)
  const [draft, setDraft] = createSignal("")
  const [conflict, setConflict] = createSignal<string | null>(null)
  let refreshGeneration = 0

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
    const submittedDraft = draft()
    try {
      const saved = await serverApi.writeSaipenFile(props.folder, current.path, submittedDraft, current.revision)
      if (editing()?.path === current.path) {
        const reconciled = reconcileSaipenSave(
          { editing: current, draft: draft(), conflict: conflict() },
          submittedDraft,
          saved.revision,
        )
        if (reconciled) {
          setEditing(reconciled.editing)
          setDraft(reconciled.draft)
        } else {
          setEditing(null)
          setDraft("")
        }
        setConflict(null)
      }
      await refresh()
    } catch (error) {
      if (error instanceof SaipenConflictError) {
        if (editing() !== current) return
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

  async function reloadCurrent() {
    const current = editing()
    if (!current) return
    const generation = ++refreshGeneration
    try {
      const freshView = await serverApi.fetchSaipenView(props.folder)
      if (generation !== refreshGeneration || editing()?.path !== current.path) return
      setView(freshView)
      const fresh = loadedFile(freshView, current.path)
      if (fresh.truncated) {
        setConflict(t("saipenView.externalChanged"))
        return
      }
      const next = reloadSaipenEditor(
        { editing: current, draft: draft(), conflict: conflict() },
        fresh.content,
        fresh.revision,
      )
      setEditing(next.editing)
      setDraft(next.draft)
      setConflict(next.conflict)
      setLoadError(null)
      props.onRefreshStatus?.()
    } catch (error) {
      if (generation !== refreshGeneration) return
      log.error("Failed to reload saipen file:", error)
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }

  /** Keeps the local draft editable; the user can copy it before deciding. */
  function keepDraft() {
    const current = editing()
    if (!current) return
    const next = keepSaipenDraft({ editing: current, draft: draft(), conflict: conflict() })
    setEditing(next.editing)
    setDraft(next.draft)
    setConflict(next.conflict)
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
    const action = externalChangeAction(
      current?.path ?? null,
      isSaipenDraftDirty(current, draft()),
      changedFiles,
    )
    if (action === "conflict") {
      setConflict(t("saipenView.externalChanged"))
      // Keep the draft untouched, but refresh the rendered view so "Reload
      // current" presents the genuinely current disk version.
      void refresh()
      return
    }
    void refresh(action === "refresh-editor" ? current?.path : undefined)
  }

  const currentTabPath = (): string | null => {
    if (props.tab === "board") return "BOARD.md"
    if (props.tab === "state") return "STATE.md"
    return null
  }

  async function refresh(syncEditingPath?: string) {
    const generation = ++refreshGeneration
    try {
      const next = await serverApi.fetchSaipenView(props.folder)
      if (generation !== refreshGeneration) return
      setView(next)
      const current = editing()
      // Do not overwrite keystrokes entered while the refresh request was in flight.
      if (syncEditingPath && current?.path === syncEditingPath && !isSaipenDraftDirty(current, draft())) {
        const fresh = loadedFile(next, syncEditingPath)
        if (fresh.truncated) {
          setConflict(t("saipenView.externalChanged"))
          return
        }
        const editor = reloadSaipenEditor(
          { editing: current, draft: draft(), conflict: conflict() },
          fresh.content,
          fresh.revision,
        )
        setEditing(editor.editing)
        setDraft(editor.draft)
        setConflict(editor.conflict)
      }
      setLoadError(null)
    } catch (error) {
      if (generation !== refreshGeneration) return
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
      // Identity is the workspace id, never the (case-folded) path. A panel for
      // workspace A must not refresh when B's files change, even if A and B
      // differ only by path case.
      if (props.workspaceId) {
        if (event.workspaceId !== props.workspaceId) return
      } else if (!sameFolder(event.folder, props.folder)) {
        return
      }
      handleExternalChange(event.files)
    })
    onCleanup(stopEvents)
  })

  const currentTabContent = (): string => {
    const value = view()
    if (props.tab === "board") return value?.board ?? ""
    if (props.tab === "state") return value?.state ?? ""
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
                  <Show when={!plan.truncated}>
                    <button
                      type="button"
                      class="saipen-view-plan-edit"
                      onClick={() => beginEdit(`kitchen/${plan.name}`, plan.content)}
                    >
                      {t("saipenView.edit")}
                    </button>
                  </Show>
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
              <button type="button" onClick={() => void reloadCurrent()}>
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

function loadedFile(view: SaipenViewResponse | null, relativePath: string): { content: string; revision: string; truncated: boolean } {
  let content = ""
  let truncated = false
  if (relativePath === "BOARD.md") content = view?.board ?? ""
  else if (relativePath === "STATE.md") content = view?.state ?? ""
  else if (relativePath.startsWith("kitchen/")) {
    const name = relativePath.slice("kitchen/".length)
    const plan = view?.plans?.find((candidate) => candidate.name === name)
    content = plan?.content ?? ""
    truncated = plan?.truncated ?? false
  }
  return { content, revision: view?.revisions?.[relativePath] ?? "", truncated }
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
