/**
 * Parsing for the SAIPENVIEW panel.
 *
 * The panel shows the raw `.saipen` files (STATE/BOARD/LOG) the way a developer
 * wants to read them: STATE as labelled fields, BOARD split into its sections,
 * LOG as a scannable tail. Pure functions here so the rendering stays dumb.
 */

export interface SaipenStateFields {
  phase: string | null
  task: string | null
  nextAction: string | null
  blocker: string | null
  executionIntent: string | null
  updated: string | null
}

export interface BoardTicket {
  id: string
  status: "todo" | "doing" | "done" | "blocked"
  text: string
}

export interface BoardSection {
  title: string
  tickets: BoardTicket[]
}

export function parseStateFrontmatter(stateText: string | null): SaipenStateFields {
  const fields: SaipenStateFields = {
    phase: null,
    task: null,
    nextAction: null,
    blocker: null,
    executionIntent: null,
    updated: null,
  }
  if (!stateText) return fields
  const match = stateText.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return fields
  for (const line of match[1].split(/\r?\n/)) {
    const entry = line.match(/^([a-zA-Z_]+):\s*(.*)$/)
    if (!entry) continue
    const value = entry[2].trim().replace(/^["']|["']$/g, "")
    switch (entry[1]) {
      case "phase": fields.phase = value; break
      case "task": fields.task = value; break
      case "next_action": fields.nextAction = value; break
      case "blocker": fields.blocker = value; break
      case "execution_intent": fields.executionIntent = value; break
      case "updated": fields.updated = value; break
    }
  }
  return fields
}

const TICKET_RE = /^- \[([ x/])\] (T-\d{3})\s+(.*)$/

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
    const status = ticket[1] === "x" ? "done" : ticket[1] === "/" ? "doing" : "todo"
    current.tickets.push({ id: ticket[2], status, text: ticket[3] })
  }
  return sections
}

export function parseLogLines(logText: string | null): string[] {
  if (!logText) return []
  return logText.split(/\r?\n/).filter((line) => line.trim().length > 0)
}
