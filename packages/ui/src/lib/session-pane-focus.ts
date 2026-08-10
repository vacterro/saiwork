/**
 * A detached session-pane window boots the normal app, then focuses the
 * instance + session it was opened for. Safe by construction: if the route is
 * missing or the instance never appears, the window just behaves as a normal
 * app window.
 */

import { isSessionPaneWindow, readSessionPaneRoute } from "./runtime-env"
import { getInstanceAppTabId, selectAppTab } from "../stores/app-tabs"
import { setActiveSessionFromList } from "../stores/sessions"
import { sessions } from "../stores/session-state"
import { instances } from "../stores/instances"

const FOCUS_DEADLINE_MS = 15000

export function focusSessionPaneRoute(): void {
  if (!isSessionPaneWindow()) return
  const route = readSessionPaneRoute()
  if (!route.instanceId || !route.sessionId) return

  const startedAt = Date.now()
  const attempt = () => {
    const instance = instances().get(route.instanceId!)
    if (!instance) {
      if (Date.now() - startedAt > FOCUS_DEADLINE_MS) return
      setTimeout(attempt, 250)
      return
    }
    // The session must be hydrated before selection, or the shell falls into
    // its "Session not found" fallback. Wait for it, not just the instance.
    const sessionKnown = sessions().get(route.instanceId!)?.has(route.sessionId!)
    if (!sessionKnown) {
      if (Date.now() - startedAt > FOCUS_DEADLINE_MS) return
      setTimeout(attempt, 250)
      return
    }
    selectAppTab(getInstanceAppTabId(route.instanceId!))
    setActiveSessionFromList(route.instanceId!, route.sessionId!)
  }
  attempt()
}
