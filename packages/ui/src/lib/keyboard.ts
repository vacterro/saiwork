import { activeInstanceId } from "../stores/instances"
import { selectAppTabByIndex } from "../stores/app-tabs"
import { activeSessionId, setActiveSession, getSessionFamily, activeParentSessionId } from "../stores/sessions"
import { keyboardRegistry, shortcutKeyFromEvent } from "./keyboard-registry"
import { isMac } from "./keyboard-utils"

export function setupTabKeyboardShortcuts(
  handleNewInstance: () => void,
  handleCloseActiveTab: () => Promise<void>,
  handleNewSession: (instanceId: string) => void,
  handleCloseSession: (instanceId: string, sessionId: string) => void,
  handleCommandPalette: () => void,
) {
  keyboardRegistry.register({
    id: "session-new",
    group: "session",
    key: "n",
    modifiers: {
      shift: true,
      meta: isMac(),
      ctrl: !isMac(),
    },
    handler: () => {
      const instanceId = activeInstanceId()
      if (instanceId) void handleNewSession(instanceId)
    },
    description: "New Session",
    context: "global",
  })

  window.addEventListener("keydown", (e) => {
    const key = shortcutKeyFromEvent(e).toLowerCase()

    if ((e.metaKey || e.ctrlKey) && e.shiftKey && key === "p") {
      e.preventDefault()
      handleCommandPalette()
      return
    }

    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && key >= "1" && key <= "9") {
      e.preventDefault()
      selectAppTabByIndex(parseInt(key) - 1)
    }

    if ((e.metaKey || e.ctrlKey) && e.shiftKey && key >= "1" && key <= "9") {
      e.preventDefault()
      const instanceId = activeInstanceId()
      if (!instanceId) return

      const index = parseInt(key) - 1
      const parentId = activeParentSessionId().get(instanceId)
      if (!parentId) return

      const sessionFamily = getSessionFamily(instanceId, parentId)
      const allTabs = sessionFamily.map((s) => s.id).concat(["logs"])

      if (allTabs[index]) {
        setActiveSession(instanceId, allTabs[index])
      }
    }

    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && key === "n") {
      e.preventDefault()
      handleNewInstance()
    }

    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && key === "w") {
      e.preventDefault()
      void handleCloseActiveTab()
    }

    if ((e.metaKey || e.ctrlKey) && e.shiftKey && key === "w") {
      e.preventDefault()
      const instanceId = activeInstanceId()
      if (!instanceId) return

      const sessionId = activeSessionId().get(instanceId)
      if (sessionId && sessionId !== "logs") {
        handleCloseSession(instanceId, sessionId)
      }
    }
  })
}
