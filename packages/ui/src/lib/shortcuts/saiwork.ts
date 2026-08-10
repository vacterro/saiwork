import { keyboardRegistry } from "../keyboard-registry"
import { isMac } from "../keyboard-utils"
import { preferences, toggleQueueEnabled } from "../../stores/preferences"
import { toggleSaipenBar, toggleShortcutsOverlay, toggleSessionSidebar } from "../../stores/ui"
import { snapWindowToPreset } from "../native/window-snap"

type KeyboardShortcutModifiers = { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean }
type KeyboardBinding = { key: string; modifiers: KeyboardShortcutModifiers; physical: boolean }

/**
 * SAIWORK-only shortcuts.
 *
 * Kept in their own file rather than appended to the upstream shortcut modules
 * so a merge from upstream never has to reconcile them. Keys were picked from
 * what upstream leaves free: Ctrl/Cmd+Shift with K and Q, plus F1.
 */
export function registerSaiWorkShortcuts() {
  const override = (id: string, fallback: { key: string; modifiers: KeyboardShortcutModifiers }): KeyboardBinding => {
    const custom = preferences().shortcutOverrides?.[id]
    return custom && custom.key
      ? { key: custom.key, modifiers: custom.modifiers, physical: custom.physical ?? false }
      : { ...fallback, physical: true }
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
    physical: saipenBar.physical,
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
    physical: queueToggle.physical,
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
    physical: snapPreset.physical,
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
    physical: overlay.physical,
    handler: () => toggleShortcutsOverlay(),
    description: "keyboard shortcuts",
    context: "global",
  })

  const sessionSidebar = override("session-sidebar-toggle", {
    key: "d",
    modifiers: { alt: true },
  })
  keyboardRegistry.register({
    id: "session-sidebar-toggle",
    group: "panels",
    key: sessionSidebar.key,
    modifiers: sessionSidebar.modifiers,
    physical: sessionSidebar.physical,
    handler: () => toggleSessionSidebar(),
    description: "toggle sessions sidebar",
    context: "global",
  })
}
