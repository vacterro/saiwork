/**
 * What a shortcut is *for*, so the reference sheet can group by meaning instead
 * of by the order modules happened to register in.
 *
 * Unset means `panels` -- the catch-all for app chrome. That default is
 * deliberate: an ungrouped shortcut should land somewhere plausible rather than
 * vanish from the sheet.
 */
export type KeyboardShortcutGroup = "navigation" | "session" | "prompt" | "agent" | "panels"

export interface KeyboardShortcut {
  id: string
  group?: KeyboardShortcutGroup
  key: string
  modifiers: {
    ctrl?: boolean
    meta?: boolean
    shift?: boolean
    alt?: boolean
  }
  handler: () => void
  description: string
  context?: "global" | "input" | "messages"
  condition?: () => boolean
  physical?: boolean
}

const CODE_KEY_ALIASES: Record<string, string> = {
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Space: "Space",
}

/** Resolve a layout-independent shortcut key from the physical key code. */
export function shortcutKeyFromEvent(event: Pick<KeyboardEvent, "key" | "code">): string {
  const code = event.code ?? ""
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1].toLowerCase()

  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code)
  if (digit) return digit[1]

  if (CODE_KEY_ALIASES[code]) return CODE_KEY_ALIASES[code]
  if (code && code !== "Unidentified") return code
  return event.key === " " ? "Space" : event.key
}

class KeyboardRegistry {
  private shortcuts = new Map<string, KeyboardShortcut>()

  register(shortcut: KeyboardShortcut) {
    this.shortcuts.set(shortcut.id, shortcut)
  }

  unregister(id: string) {
    this.shortcuts.delete(id)
  }

  /** Replace the key/modifiers of an already-registered shortcut. */
  reconfigure(id: string, key: string, modifiers: KeyboardShortcut["modifiers"], physical = true) {
    const existing = this.shortcuts.get(id)
    if (!existing) return
    this.shortcuts.set(id, { ...existing, key, modifiers, physical })
  }

  get(id: string) {
    return this.shortcuts.get(id)
  }

  findMatch(event: KeyboardEvent): KeyboardShortcut | null {
    for (const shortcut of this.shortcuts.values()) {
      if (this.matches(event, shortcut)) {
        if (shortcut.context === "input" && !this.isInputFocused()) continue
        if (shortcut.context === "messages" && this.isInputFocused()) continue

        if (shortcut.condition && !shortcut.condition()) continue

        return shortcut
      }
    }
    return null
  }

  private matches(event: KeyboardEvent, shortcut: KeyboardShortcut): boolean {
    const shortcutKey = shortcut.key.toLowerCase()
    const eventKey = event.key === " " ? "space" : event.key?.toLowerCase() ?? ""
    const physicalKey = shortcutKeyFromEvent(event).toLowerCase()

    const keyMatch = shortcut.physical === false
      ? eventKey === shortcutKey
      : physicalKey === shortcutKey
    const ctrlMatch = event.ctrlKey === (shortcut.modifiers.ctrl ?? false)
    const metaMatch = event.metaKey === (shortcut.modifiers.meta ?? false)
    const shiftMatch = event.shiftKey === (shortcut.modifiers.shift ?? false)
    const altMatch = event.altKey === (shortcut.modifiers.alt ?? false)

    return keyMatch && ctrlMatch && metaMatch && shiftMatch && altMatch
  }

  private isInputFocused(): boolean {
    const active = document.activeElement
    return (
      active?.tagName === "TEXTAREA" ||
      active?.tagName === "INPUT" ||
      (active?.hasAttribute("contenteditable") ?? false)
    )
  }

  /** Every registered shortcut, in registration order. */
  list(): KeyboardShortcut[] {
    return Array.from(this.shortcuts.values())
  }

  getByContext(context: string): KeyboardShortcut[] {
    return Array.from(this.shortcuts.values()).filter((s) => !s.context || s.context === context)
  }
}

export const keyboardRegistry = new KeyboardRegistry()
