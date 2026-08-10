/**
 * Split-picker candidate computation.
 *
 * The Split button offers sessions worth putting into a second pane:
 * this instance's cached sessions plus other instances' active sessions,
 * minus any session already shown in a pane of this instance. Pure and
 * deterministic so the picker can be tested without a DOM.
 */

export interface SplitPickCandidate {
  /** The instance that owns the session (usually the current one). */
  instanceId: string
  sessionId: string
  title: string
}

export interface SplitPickSource {
  instanceId: string
  sessionId: string
  title: string
}

export function paneKey(instanceId: string, sessionId: string): string {
  return `${instanceId}:${sessionId}`
}

/**
 * Builds the ordered candidate list for a split picker.
 *
 * @param currentInstanceId the instance the picker was opened for
 * @param cachedSessions this instance's cached session list (active family)
 * @param otherActiveSessions sessions active in other instances/projects
 * @param shownPaneKeys keys already rendered as panes (`instance:session`),
 *   excluded from the result
 */
export function buildSplitCandidates(options: {
  currentInstanceId: string
  cachedSessions: SplitPickSource[]
  otherActiveSessions: SplitPickSource[]
  shownPaneKeys: Set<string>
}): SplitPickCandidate[] {
  const shown = options.shownPaneKeys
  const current = options.cachedSessions
    .filter((entry) => !shown.has(paneKey(entry.instanceId, entry.sessionId)))
    .map((entry) => ({ instanceId: entry.instanceId, sessionId: entry.sessionId, title: entry.title }))

  const others = options.otherActiveSessions
    .filter((entry) => entry.instanceId !== options.currentInstanceId)
    .filter((entry) => !shown.has(paneKey(entry.instanceId, entry.sessionId)))
    .map((entry) => ({ instanceId: entry.instanceId, sessionId: entry.sessionId, title: entry.title }))

  return [...current, ...others]
}
