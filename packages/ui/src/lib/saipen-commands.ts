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
  /** Sub-agent this shortcut drives, when it drives one. */
  sub?: "saiwiki" | "saitranslate" | "saipython" | "saihunt"
}

export const SAIPEN_COMMANDS: SaipenCommand[] = [
  {
    shortcut: "gg",
    verb: "saipen goal",
    summary: "New goal. Needs an objective.",
    argument: "required",
  },
  {
    shortcut: "hh",
    verb: "saipen hunt",
    summary: "Autonomous defect and improvement scan.",
    argument: "none",
    sub: "saihunt",
  },
  {
    shortcut: "cc",
    cyrillic: "сс",
    verb: "saipen continue",
    summary: "Continue context or converge.",
    argument: "none",
  },
  {
    shortcut: "ccc",
    cyrillic: "ссс",
    verb: "saipen continue (converge_target: ship) + ship + stages J-M",
    summary: "Converge, ship through every gate, then refresh ee and qq.",
    argument: "none",
  },
  {
    shortcut: "ss",
    verb: "saipen stop",
    summary: "Checkpoint, write digest, hand back control.",
    argument: "none",
  },
  {
    shortcut: "sss",
    verb: "saipen status",
    summary: "Where the run stands. Read-only.",
    argument: "none",
  },
  {
    shortcut: "dd",
    verb: "saipen plan",
    summary: "Plan. Bare proposes, with text inserts your items.",
    argument: "required",
  },
  {
    shortcut: "aa",
    cyrillic: "аа",
    verb: "saipen markhunt",
    summary: "Dry audit. Records to BOARD, never fixes.",
    argument: "none",
  },
  {
    shortcut: "qq",
    verb: "saipen prepare saiwiki",
    summary: "Force-fresh wiki regenerate and verify.",
    argument: "none",
    sub: "saiwiki",
  },
  {
    shortcut: "qqq",
    verb: "saipen collect saiwiki + ship",
    summary: "Wiki integration and push. Needs qq first.",
    argument: "none",
    sub: "saiwiki",
  },
  {
    shortcut: "ee",
    cyrillic: "ее",
    verb: "saipen prepare saitranslate",
    summary: "Force-fresh docs and in-app translation package.",
    argument: "none",
    sub: "saitranslate",
  },
  {
    shortcut: "eee",
    cyrillic: "еее",
    verb: "saipen collect saitranslate + ship",
    summary: "Translation integration and push. Needs ee first.",
    argument: "none",
    sub: "saitranslate",
  },
  {
    shortcut: "pp",
    cyrillic: "рр",
    verb: "saipen sub spawn saipython",
    summary: "Python tooling: spawn, maintain, refresh.",
    argument: "none",
    sub: "saipython",
  },
  {
    shortcut: "tt",
    verb: "saipen test",
    summary: "Run the declared suite. Read-only.",
    argument: "none",
  },
  {
    shortcut: "sc",
    verb: "saipen crew",
    summary: "Whole circuit in order, no gate waived.",
    argument: "none",
  },
]

export function findSaipenCommand(shortcut: string): SaipenCommand | undefined {
  const needle = shortcut.trim().toLowerCase()
  return SAIPEN_COMMANDS.find((command) => command.shortcut === needle || command.cyrillic === needle)
}
