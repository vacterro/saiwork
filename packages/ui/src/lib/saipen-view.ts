/**
 * Parsing for the SAIPENVIEW panel.
 *
 * The panel shows the raw `.saipen` files (STATE/BOARD/LOG) the way a developer
 * wants to read them: STATE as labelled fields, LOG as a scannable tail. Pure
 * functions here so the rendering stays dumb.
 *
 * STATE parsing is NOT re-implemented: it delegates to the canonical server
 * parser (`server/src/saipen/state.ts`) so one source of truth decides
 * frontmatter scope, first-match and quote handling. BOARD sections are parsed
 * server-side too and arrive structured in the view payload.
 */
import { parseStateScalars } from "../../../server/src/saipen/state"

export interface SaipenStateFields {
  phase: string | null
  task: string | null
  nextAction: string | null
  blocker: string | null
  executionIntent: string | null
  updated: string | null
  agent: string | null
  roleRevision: string | null
  saipenHome: string | null
}

export function parseStateFrontmatter(stateText: string | null): SaipenStateFields {
  const fields: SaipenStateFields = {
    phase: null,
    task: null,
    nextAction: null,
    blocker: null,
    executionIntent: null,
    updated: null,
    agent: null,
    roleRevision: null,
    saipenHome: null,
  }
  if (!stateText) return fields
  const parsed = parseStateScalars(stateText)
  const value = (key: string): string | null => parsed.values.get(key) ?? null
  return {
    phase: value("phase"),
    task: value("task"),
    nextAction: value("next_action"),
    blocker: value("blocker"),
    executionIntent: value("execution_intent"),
    updated: value("updated"),
    agent: value("agent"),
    roleRevision: value("role_revision"),
    saipenHome: value("saipen_home"),
  }
}

export function parseLogLines(logText: string | null): string[] {  if (!logText) return []
  return logText.split(/\r?\n/).filter((line) => line.trim().length > 0)
}

/**
 * Dirty-editor rule for live protocol changes:
 * - clean editor (nothing open, or a different file open): refresh automatically
 * - dirty editor on the touched file: preserve the draft, mark the conflict
 * No automatic merge; the user resolves it explicitly.
 */
export function externalChangeAction(
  editingPath: string | null,
  changedFiles: string[],
): "refresh" | "conflict" {
  return editingPath && changedFiles.includes(editingPath) ? "conflict" : "refresh"
}
