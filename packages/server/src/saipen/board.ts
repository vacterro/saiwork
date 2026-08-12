/**
 * Canonical SAIPEN BOARD.md parser.
 *
 * The board's semantics live here and nowhere else: ticket status comes from
 * the section a ticket sits under, never from its checkbox alone (`- [ ]` under
 * `## BLOCKED` is blocked, not "todo"). This mirrors the normative BOARD shape
 * (`CORE.md` § 1.2: `## DOING`/`## TODO`/`## DONE`/`## BLOCKED`, checkbox
 * agrees with section) and feeds both the server's project-state counts and the
 * structured sections the embedded SAIPENVIEW renders.
 */

export interface BoardTicket {
  id: string
  status: "todo" | "doing" | "done" | "blocked"
  text: string
  /** True when the checkbox is `[x]` (the agent finished it). */
  checked: boolean
}

export interface BoardSection {
  title: string
  tickets: BoardTicket[]
}

const TICKET_RE = /^- \[([ x/])\] (T-\d{3})\s+(.*)$/

/**
 * Canonical section headings decide a ticket's status. Non-canonical headings
 * (Decisions, Wave notes, ...) keep checkbox semantics so prose sections render
 * what they actually are.
 */
const CANONICAL_SECTION_STATUS: Record<string, BoardTicket["status"]> = {
  "TODO": "todo",
  "DOING": "doing",
  "BLOCKED": "blocked",
  "DONE": "done",
}

export function parseBoardSections(boardText: string | null): BoardSection[] {
  if (!boardText) return []
  const sections: BoardSection[] = []
  let current: BoardSection | null = null
  for (const line of boardText.split(/\r?\n/)) {
    const heading = line.match(/^## (.*)$/)
    if (heading) {
      current = { title: heading[1].trim(), tickets: [] }
      sections.push(current)
      continue
    }
    if (!current) continue
    const ticket = line.match(TICKET_RE)
    if (!ticket) continue
    const sectionStatus = CANONICAL_SECTION_STATUS[current.title]
    const status: BoardTicket["status"] = sectionStatus ?? (
      ticket[1] === "x" ? "done" : ticket[1] === "/" ? "doing" : "todo"
    )
    current.tickets.push({ id: ticket[2], status, text: ticket[3], checked: ticket[1] === "x" })
  }
  return sections
}
