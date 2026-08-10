import { keyboardRegistry } from "../keyboard-registry"
import { isMac } from "../keyboard-utils"
import { preferences, toggleQueueEnabled } from "../../stores/preferences"
import { toggleSaipenBar, toggleShortcutsOverlay } from "../../stores/ui"
import { snapWindowToPreset } from "../native/window-snap"

/**
 * SAIWORK-only shortcuts.
 *
 * Kept in their own file rather than appended to the upstream shortcut modules
 * so a merge from upstream never has to reconcile them. Keys were picked from
 * what upstream leaves free: Ctrl/Cmd+Shift with K and Q, plus F1.
 */
export function registerSaiWorkShortcuts() {
  keyboardRegistry.register({
    id: "saipen-bar-toggle",
    group: "panels",
    key: "k",
    modifiers: { ctrl: !isMac(), meta: isMac(), shift: true },
    handler: () => toggleSaipenBar(),
    description: "toggle SAIPEN bar",
    context: "global",
  })

  keyboardRegistry.register({
    id: "prompt-queue-toggle",
    group: "panels",
    key: "q",
    modifiers: { ctrl: !isMac(), meta: isMac(), shift: true },
    handler: () => toggleQueueEnabled(),
    description: "toggle prompt queue mode",
    context: "global",
  })

  // Plain Ctrl+Q snaps the window to the active layout preset. Not Cmd+Q on
  // mac: that is the quit accelerator, so plain Control+Q everywhere avoids
  // stealing it.
  keyboardRegistry.register({
    id: "window-snap-preset",
    group: "panels",
    key: "q",
    modifiers: { ctrl: true },
    handler: () => {
      const active = preferences().windowPresets.find(
        (preset) => preset.id === preferences().activeWindowPreset,
      )
      if (active) void snapWindowToPreset(active)
    },
    description: "snap window to layout preset",
    context: "global",
  })

  keyboardRegistry.register({
    id: "shortcuts-overlay",
    group: "panels",
    key: "F1",
    modifiers: {},
    handler: () => toggleShortcutsOverlay(),
    description: "keyboard shortcuts",
    context: "global",
  })
}
