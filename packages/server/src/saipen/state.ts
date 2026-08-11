/**
 * Canonical SAIPEN STATE.md scalar parser.
 *
 * The protocol's STATE.md is YAML frontmatter delimited by `---`, and every
 * field a consumer needs is a single-line scalar (`phase: BUILD`,
 * `next_action: "PHASE BUILD T-086"`). This module is the one place that
 * turns those lines into typed scalars; server and UI must agree on the same
 * semantics:
 *
 * - frontmatter-scoped: only lines inside the leading `--- ... ---` block count
 * - first-match wins on a duplicated key
 * - a duplicated key is reported as an issue, never silently resolved
 * - surrounding quotes are stripped; `saipen_home` backslash unescaping stays
 *   the caller's concern because it is path-specific, not scalar-general
 */

export interface ParsedStateScalars {
  /** First value per scalar key, in file order. Unknown keys are preserved. */
  values: ReadonlyMap<string, string>
  /** Non-fatal findings such as duplicated scalar definitions. */
  issues: string[]
}

const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---/
const SCALAR_RE = /^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/

export function parseStateScalars(stateText: string | null | undefined): ParsedStateScalars {
  const values = new Map<string, string>()
  if (!stateText) return { values, issues: [] }

  const match = stateText.match(FRONTMATTER_RE)
  if (!match) return { values, issues: [] }

  const issues: string[] = []
  for (const line of match[1].split(/\r?\n/)) {
    const entry = line.match(SCALAR_RE)
    if (!entry) continue
    if (values.has(entry[1])) {
      issues.push(`Duplicate scalar ${entry[1]}`)
      continue
    }
    const value = entry[2].trim().replace(/^["']|["']$/g, "")
    values.set(entry[1], value)
  }
  return { values, issues }
}

/** Reads a single canonical scalar; returns null for absent or empty values. */
export function readStateScalar(stateText: string | null | undefined, field: string): string | null {
  const value = parseStateScalars(stateText).values.get(field)
  return value ? value : null
}
