import type { KeyboardShortcut, KeyboardShortcutGroup } from "./keyboard-registry"

/**
 * Builds the keyboard reference: what goes in which section, and in what order.
 *
 * The sheet used to dump every registered shortcut into one "Global" block in
 * whatever order the modules happened to register, then append three
 * hand-written rows. Reading it meant scanning an unsorted list for the one key
 * you wanted.
 *
 * Grouping lives here, as data, so it can be tested without a DOM and so the
 * order is one decision in one place rather than JSX ordering.
 */

/** Sections top to bottom. Most-used first, chrome last. */
export const SHORTCUT_GROUP_ORDER: KeyboardShortcutGroup[] = [
  "navigation",
  "session",
  "prompt",
  "agent",
  "panels",
]

export const SHORTCUT_GROUP_LABEL_KEY: Record<KeyboardShortcutGroup, string> = {
  navigation: "shortcuts.section.navigation",
  session: "shortcuts.section.session",
  prompt: "shortcuts.section.prompt",
  agent: "shortcuts.section.agent",
  panels: "shortcuts.section.panels",
}

export interface SheetRow {
  keys: string
  /** Either literal text or an i18n key, depending on `descriptionIsKey`. */
  description: string
  descriptionIsKey?: boolean
}

export interface SheetSection {
  group: KeyboardShortcutGroup
  labelKey: string
  rows: SheetRow[]
}

/**
 * Rows the registry cannot know about: they are handled inside a raw keydown
 * listener or inside the prompt textarea, so nothing registers them.
 *
 * Written out here rather than in JSX so they sort into the same sections as
 * the registered ones and cannot drift into a separate orphan block.
 */
export const UNREGISTERED_ROWS: Array<SheetRow & { group: KeyboardShortcutGroup }> = [
  { group: "navigation", keys: "Ctrl+1..9", description: "shortcuts.global.selectTab", descriptionIsKey: true },
  { group: "session", keys: "Ctrl+W", description: "shortcuts.global.closeTab", descriptionIsKey: true },
  { group: "panels", keys: "Ctrl+Shift+P", description: "shortcuts.global.commandPalette", descriptionIsKey: true },
  { group: "prompt", keys: "Enter / Ctrl+Enter", description: "shortcuts.prompt.send", descriptionIsKey: true },
  { group: "prompt", keys: "Alt+Enter", description: "shortcuts.prompt.queue", descriptionIsKey: true },
  { group: "prompt", keys: "Shift+Enter", description: "shortcuts.prompt.newline", descriptionIsKey: true },
  { group: "prompt", keys: "!", description: "shortcuts.prompt.shell", descriptionIsKey: true },
  { group: "prompt", keys: "/", description: "shortcuts.prompt.command", descriptionIsKey: true },
  { group: "prompt", keys: "@", description: "shortcuts.prompt.mention", descriptionIsKey: true },
  { group: "prompt", keys: "Up / Down", description: "shortcuts.prompt.history", descriptionIsKey: true },
]

export function formatShortcutKeys(shortcut: KeyboardShortcut, mac: boolean): string {
  const parts: string[] = []
  if (shortcut.modifiers.ctrl) parts.push("Ctrl")
  if (shortcut.modifiers.meta) parts.push(mac ? "Cmd" : "Meta")
  if (shortcut.modifiers.alt) parts.push("Alt")
  if (shortcut.modifiers.shift) parts.push("Shift")
  parts.push(shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key)
  return parts.join("+")
}

/**
 * Registered shortcuts plus the unregistered rows, split into ordered sections.
 * Sections with no rows are dropped -- an empty heading is noise.
 *
 * Within a section, registered shortcuts keep registration order and the
 * hand-written rows follow. Registration order is stable and matches how the
 * modules read, which beats an alphabetical sort nobody asked for.
 */
export function buildShortcutSections(shortcuts: KeyboardShortcut[], mac: boolean): SheetSection[] {
  const sections: SheetSection[] = []

  for (const group of SHORTCUT_GROUP_ORDER) {
    const rows: SheetRow[] = []

    for (const shortcut of shortcuts) {
      if ((shortcut.group ?? "panels") !== group) continue
      rows.push({ keys: formatShortcutKeys(shortcut, mac), description: shortcut.description })
    }

    for (const row of UNREGISTERED_ROWS) {
      if (row.group !== group) continue
      rows.push({ keys: row.keys, description: row.description, descriptionIsKey: row.descriptionIsKey })
    }

    if (rows.length === 0) continue
    sections.push({ group, labelKey: SHORTCUT_GROUP_LABEL_KEY[group], rows })
  }

  return sections
}
