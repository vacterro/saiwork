/**
 * The saipen shortcut surface.
 *
 * Mirrors CORE.md section 1.10's command table. The protocol is explicit that
 * this table must be read from the source rather than recalled, so the entries
 * below are transcribed once, here, and every consumer reads them from this
 * module -- a second transcription elsewhere is how the table drifts.
 *
 * `argument: "required"` marks the two shortcuts that are meaningless bare:
 * `gg` replies `Use: gg <objective text>` and stops, and `dd` without text
 * means something different (autonomous proposal) than the user usually wants.
 * Those insert into the prompt instead of firing.
 */

export type SaipenArgumentMode = "none" | "required" | "optional"

/** Semantic bucket shown as a labelled group in the shortcut bar. */
export type SaipenCommandCategory = "continue" | "plan" | "subs"

export interface SaipenCommand {
  /** The shortcut the user types, e.g. `qq`. */
  shortcut: string
  /** Cyrillic twin, where the protocol defines one. */
  cyrillic?: string
  /** The full verb the shortcut expands to, shown as the button's tooltip. */
  verb: string
  /** One-line description, kept short enough for a 20px control. */
  summary: string
  argument: SaipenArgumentMode
  /** Group label the button lives under in the shortcut bar. */
  category: SaipenCommandCategory
  /** Sub-agent this shortcut drives, when it drives one. */
  sub?: "saiwiki" | "saitranslate" | "saipython" | "saihunt"
  /** The prepare shortcut this ship command collects, e.g. `eee` ships `ee`. */
  ships?: string
}

/**
 * Order is the surface order: the most-used commands come first, left to
 * right. `cc` (continue), `sss` (status) and `ss` (stop) are the daily
 * drivers; the production round-trips (`qq`/`qqq`, `ee`/`eee`) sit later.
 */
export const SAIPEN_COMMANDS: SaipenCommand[] = [
  {
    shortcut: "cc",
    cyrillic: "сс",
    verb: "saipen continue",
    summary: "Continue context or converge.",
    argument: "none",
    category: "continue",
  },
  {
    shortcut: "ccc",
    cyrillic: "ссс",
    verb: "saipen continue (converge_target: ship) + ship + stages J-M",
    summary: "Converge, ship through every gate, then refresh ee and qq.",
    argument: "none",
    category: "continue",
  },
  {
    shortcut: "sss",
    verb: "saipen status",
    summary: "Where the run stands. Read-only.",
    argument: "none",
    category: "continue",
  },
  {
    shortcut: "ss",
    verb: "saipen stop",
    summary: "Checkpoint, write digest, hand back control.",
    argument: "none",
    category: "continue",
  },
  {
    shortcut: "gg",
    verb: "saipen goal",
    summary: "New goal. Needs an objective.",
    argument: "required",
    category: "plan",
  },
  {
    shortcut: "aa",
    cyrillic: "аа",
    verb: "saipen markhunt",
    summary: "Dry audit. Records to BOARD, never fixes.",
    argument: "none",
    category: "plan",
  },
  {
    shortcut: "hh",
    verb: "saipen hunt",
    summary: "Autonomous defect and improvement scan.",
    argument: "none",
    category: "subs",
    sub: "saihunt",
  },
  {
    shortcut: "dd",
    verb: "saipen plan",
    summary: "Plan. Bare proposes, with text inserts your items.",
    argument: "required",
    category: "plan",
  },
  {
    shortcut: "tt",
    verb: "saipen test",
    summary: "Run the declared suite. Read-only.",
    argument: "none",
    category: "plan",
  },
  {
    shortcut: "sc",
    verb: "saipen crew",
    summary: "Whole circuit in order, no gate waived.",
    argument: "none",
    category: "plan",
  },
  {
    shortcut: "ee",
    cyrillic: "ее",
    verb: "saipen prepare saitranslate",
    summary: "Force-fresh docs and in-app translation package.",
    argument: "none",
    category: "subs",
    sub: "saitranslate",
  },
  {
    shortcut: "eee",
    cyrillic: "еее",
    verb: "saipen collect saitranslate + ship",
    summary: "Translation integration and push. Needs ee first.",
    argument: "none",
    category: "subs",
    sub: "saitranslate",
    ships: "ee",
  },
  {
    shortcut: "qq",
    verb: "saipen prepare saiwiki",
    summary: "Force-fresh wiki regenerate and verify.",
    argument: "none",
    category: "subs",
    sub: "saiwiki",
  },
  {
    shortcut: "qqq",
    verb: "saipen collect saiwiki + ship",
    summary: "Wiki integration and push. Needs qq first.",
    argument: "none",
    category: "subs",
    sub: "saiwiki",
    ships: "qq",
  },
  {
    shortcut: "pp",
    cyrillic: "рр",
    verb: "saipen sub spawn saipython",
    summary: "Python tooling: spawn, maintain, refresh.",
    argument: "none",
    category: "subs",
    sub: "saipython",
  },
]

export function findSaipenCommand(shortcut: string): SaipenCommand | undefined {
  const needle = shortcut.trim().toLowerCase()
  return SAIPEN_COMMANDS.find((command) => command.shortcut === needle || command.cyrillic === needle)
}

/**
 * Expand a bare declared shortcut to its canonical verb before it reaches the
 * model. Bare keys are exact-whole-message commands (CORE §1.10), but models
 * have proven unreliable at parsing them from chat: two consecutive keys
 * (`cc` then `ee`) got merged into `ccee` and the agent stopped. Sending the
 * full verb instead makes the model's job trivial and keeps command handling
 * deterministic. Returns null when the message is not a declared shortcut.
 */
export function normalizeShortcutMessage(message: string): string | null {
  const trimmed = message.trim()
  if (!trimmed) return null
  const command = findSaipenCommand(trimmed)
  if (!command) return null
  return command.verb
}

/** Surface order of the labelled groups in the shortcut bar. */
export const SAIPEN_CATEGORIES: SaipenCommandCategory[] = ["continue", "plan", "subs"]
