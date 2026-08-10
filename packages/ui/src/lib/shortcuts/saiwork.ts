import { keyboardRegistry } from "../keyboard-registry"
import { isMac } from "../keyboard-utils"
import { preferences, toggleQueueEnabled } from "../../stores/preferences"
import { toggleSaipenBar, toggleShortcutsOverlay } from "../../stores/ui"
import { snapWindowToPreset } from "../native/window-snap"

type KeyboardShortcutModifiers = { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean }

/**
 * SAIWORK-only shortcuts.
 *
 * Kept in their own file rather than appended to the upstream shortcut modules
 * so a merge from upstream never has to reconcile them. Keys were picked from
 * what upstream leaves free: Ctrl/Cmd+Shift with K and Q, plus F1.
 */
export function registerSaiWorkShortcuts() {
  const override = (id: string, fallback: { key: string; modifiers: KeyboardShortcutModifiers }) => {
    const custom = preferences().shortcutOverrides?.[id]
    return custom && custom.key ? { key: custom.key, modifiers: custom.modifiers } : fallback
  }

  const saipenBar = override("saipen-bar-toggle", {
    key: "k",
    modifiers: { ctrl: !isMac(), meta: isMac(), shift: true },
  })
  keyboardRegistry.register({
    id: "saipen-bar-toggle",
    group: "panels",
    key: saipenBar.key,
    modifiers: saipenBar.modifiers,
    handler: () => toggleSaipenBar(),
    description: "toggle SAIPEN bar",
    context: "global",
  })

  const queueToggle = override("prompt-queue-toggle", {
    key: "q",
    modifiers: { ctrl: !isMac(), meta: isMac(), shift: true },
  })
  keyboardRegistry.register({
    id: "prompt-queue-toggle",
    group: "panels",
    key: queueToggle.key,
    modifiers: queueToggle.modifiers,
    handler: () => toggleQueueEnabled(),
    description: "toggle prompt queue mode",
    context: "global",
  })

  // Plain Ctrl+Q snaps the window to the active layout preset. Not Cmd+Q on
  // mac: that is the quit accelerator, so plain Control+Q everywhere avoids
  // stealing it.
  const snapPreset = override("window-snap-preset", {
    key: "q",
    modifiers: { ctrl: true },
  })
  keyboardRegistry.register({
    id: "window-snap-preset",
    group: "panels",
    key: snapPreset.key,
    modifiers: snapPreset.modifiers,
    handler: () => {
      const active = preferences().windowPresets.find(
        (preset) => preset.id === preferences().activeWindowPreset,
      )
      if (active) void snapWindowToPreset(active)
    },
    description: "snap window to layout preset",
    context: "global",
  })

  const overlay = override("shortcuts-overlay", {
    key: "F1",
    modifiers: {},
  })
  keyboardRegistry.register({
    id: "shortcuts-overlay",
    group: "panels",
    key: overlay.key,
    modifiers: overlay.modifiers,
    handler: () => toggleShortcutsOverlay(),
    description: "keyboard shortcuts",
    context: "global",
  })
}
