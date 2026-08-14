/**
 * In-memory permission auto-accept (Yolo) state, owned by the server.
 *
 * This is a faithful port of the previous frontend implementation
 * (`packages/ui/src/stores/permission-auto-accept.ts`) so the inheritance
 * semantics are preserved exactly:
 *   - state is keyed by the resolved *family root* session id
 *   - a session with a `revert` snapshot is treated as its own root (fork)
 *   - enabling any session enables its whole family root and vice-versa
 *
 * This store remains in-memory; AutoAcceptManager hydrates and persists it
 * through OpenCode session metadata.
 */

export interface AutoAcceptSessionInfo {
  id: string
  parentId?: string | null
  /** Truthy value marks the session as a fork that roots at itself. */
  revert?: unknown
}

type SessionLookup = (sessionId: string) => AutoAcceptSessionInfo | undefined

/**
 * Resolve the family-root session id for `sessionId` by walking the parent
 * chain. Mirrors `resolvePermissionAutoAcceptFamilyRoot` from the UI so
 * inheritance behaviour does not change.
 */
export function resolveFamilyRoot(sessionId: string, getSession: SessionLookup): string {
  let currentId = sessionId
  let lastKnownId = sessionId
  const seen = new Set<string>()

  while (currentId && !seen.has(currentId)) {
    seen.add(currentId)
    const session = getSession(currentId)
    if (!session) return lastKnownId
    lastKnownId = session.id
    if (session.revert) return session.id
    if (!session.parentId) return session.id
    currentId = session.parentId
  }

  return currentId || sessionId
}

/**
 * The effective Yolo (permission auto-accept) default, decided once at the
 * wiring layer.
 *
 * An explicit `SAIWORK_YOLO_DEFAULT=true|false|1|0|on|off` always wins.
 * Without an explicit setting the trust decision is host-aware: a loopback-
 * only server defaults ON (local automation), while a server reachable from
 * the network defaults OFF and requires an explicit policy -- "authenticated"
 * never implies remote trust.
 *
 * What the flag does: every permission request the agent raises is approved
 * without asking, including file writes, deletions and shell commands.
 */
export function resolveYoloDefault(options: { isLoopback: boolean } = { isLoopback: true }): boolean {
  const raw = process.env.SAIWORK_YOLO_DEFAULT?.trim().toLowerCase()
  if (raw === "true" || raw === "1" || raw === "on") return true
  if (raw === "false" || raw === "0" || raw === "off") return false
  return options.isLoopback
}

export class AutoAcceptStore {
  /** instanceId -> set of explicitly enabled family-root session ids */
  private readonly enabled = new Map<string, Set<string>>()
  /**
   * instanceId -> set of explicitly disabled family-root session ids.
   * Needed only because the default is on: without it there would be no way to
   * distinguish "never touched" from "the user turned this one off".
   */
  private readonly disabled = new Map<string, Set<string>>()
  /** instanceId -> (sessionId -> info) */
  private readonly sessions = new Map<string, Map<string, AutoAcceptSessionInfo>>()

  private readonly defaultEnabled: boolean

  constructor(options: { defaultEnabled?: boolean } = {}) {
    this.defaultEnabled = options.defaultEnabled ?? false
  }

  isEnabled(instanceId: string, sessionId: string): boolean {
    const root = this.familyRoot(instanceId, sessionId)
    if (this.disabled.get(instanceId)?.has(root)) return false
    if (this.enabled.get(instanceId)?.has(root)) return true
    return this.defaultEnabled
  }

  setEnabled(instanceId: string, sessionId: string, enabled: boolean): void {
    const root = this.familyRoot(instanceId, sessionId)
    const add = enabled ? this.enabled : this.disabled
    const remove = enabled ? this.disabled : this.enabled

    let roots = add.get(instanceId)
    if (!roots) {
      roots = new Set()
      add.set(instanceId, roots)
    }
    roots.add(root)

    const opposite = remove.get(instanceId)
    if (opposite) {
      opposite.delete(root)
      if (opposite.size === 0) {
        remove.delete(instanceId)
      }
    }
  }

  toggle(instanceId: string, sessionId: string): boolean {
    const next = !this.isEnabled(instanceId, sessionId)
    this.setEnabled(instanceId, sessionId, next)
    return next
  }

  upsertSession(instanceId: string, info: AutoAcceptSessionInfo): void {
    let tree = this.sessions.get(instanceId)
    if (!tree) {
      tree = new Map()
      this.sessions.set(instanceId, tree)
    }
    tree.set(info.id, {
      id: info.id,
      parentId: info.parentId ?? null,
      revert: info.revert,
    })
    this.migrateEnabledRoots(instanceId)
  }

  removeSession(instanceId: string, sessionId: string): void {
    this.sessions.get(instanceId)?.delete(sessionId)
  }

  clearInstance(instanceId: string): void {
    this.sessions.delete(instanceId)
    this.enabled.delete(instanceId)
    this.disabled.delete(instanceId)
  }

  /** Resolves the family-root session id for the given session. */
  familyRoot(instanceId: string, sessionId: string): string {
    const tree = this.sessions.get(instanceId)
    return resolveFamilyRoot(sessionId, (id) => tree?.get(id))
  }

  enabledRoots(instanceId: string): string[] {
    return [...(this.enabled.get(instanceId) ?? [])]
  }

  /**
   * Re-resolves every enabled family root for an instance after the session
   * tree changes (new session, updated parent/revert). If a root now resolves
   * to a different id, the enabled entry is migrated so toggles survive late
   * ancestry discovery.
   */
  private migrateEnabledRoots(instanceId: string): void {
    for (const map of [this.enabled, this.disabled]) {
      const roots = map.get(instanceId)
      if (!roots || roots.size === 0) continue
      for (const oldRoot of Array.from(roots)) {
        const newRoot = this.familyRoot(instanceId, oldRoot)
        if (newRoot !== oldRoot) {
          roots.delete(oldRoot)
          roots.add(newRoot)
        }
      }
    }

    // Migration can land two sessions' markers on the same root -- e.g. a
    // disabled parent and an enabled child that just discovered its ancestry.
    // The sets have to stay mutually exclusive, and the enabled marker wins,
    // because it is the one that just moved onto this root.
    const enabledRoots = this.enabled.get(instanceId)
    const disabledRoots = this.disabled.get(instanceId)
    if (!enabledRoots || !disabledRoots) return
    for (const root of enabledRoots) {
      disabledRoots.delete(root)
    }
    if (disabledRoots.size === 0) {
      this.disabled.delete(instanceId)
    }
  }
}
