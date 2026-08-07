import { keyboardRegistry } from "../keyboard-registry"
import { isMac } from "../keyboard-utils"
import { activeInstanceId } from "../../stores/instances"
import { activeSessionId } from "../../stores/sessions"
import { toggleQueuePaused } from "../../stores/prompt-queue"
import { toggleSaipenBar, toggleShortcutsOverlay } from "../../stores/ui"

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
    key: "k",
    modifiers: { ctrl: !isMac(), meta: isMac(), shift: true },
    handler: () => toggleSaipenBar(),
    description: "toggle SAIPEN bar",
    context: "global",
  })

  keyboardRegistry.register({
    id: "prompt-queue-pause",
    key: "q",
    modifiers: { ctrl: !isMac(), meta: isMac(), shift: true },
    handler: () => {
      const instanceId = activeInstanceId()
      if (!instanceId) return
      const sessionId = activeSessionId().get(instanceId)
      if (!sessionId) return
      toggleQueuePaused(instanceId, sessionId)
    },
    description: "pause/resume prompt queue",
    context: "global",
  })

  keyboardRegistry.register({
    id: "shortcuts-overlay",
    key: "F1",
    modifiers: {},
    handler: () => toggleShortcutsOverlay(),
    description: "keyboard shortcuts",
    context: "global",
  })
}
