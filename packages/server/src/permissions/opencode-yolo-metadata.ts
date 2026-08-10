import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { WorkspaceManager } from "../workspaces/manager"
import { createInstanceClient } from "../workspaces/instance-client"
import type { AutoAcceptPersistence, PersistedAutoAcceptSession } from "./auto-accept-manager"

const SAIWORK_METADATA_VERSION = 1
const SESSION_LIST_LIMIT = 10_000

type Metadata = Record<string, unknown>

export interface OpencodeYoloPersistence extends AutoAcceptPersistence {
  hasProjectSession(instanceId: string, sessionId: string): Promise<boolean>
  setWorktreeSlug(instanceId: string, sessionId: string, worktreeSlug: string): Promise<Metadata>
}

function record(value: unknown): Metadata {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Metadata) } : {}
}

/**
 * Read a session's persisted Yolo marker as a tri-state.
 *
 * `null` means the session carries no marker -- the user has never touched it,
 * so the caller falls back to the server default. `true`/`false` mean the user
 * explicitly chose that state and it must survive a restart. The old
 * `hasPersistedYolo` collapsed the missing marker into `false`, which on a
 * default-on server silently turned every never-touched session off at
 * hydration.
 */
export function readPersistedYolo(sessionId: string, metadata: unknown): boolean | null {
  const saiwork = record(record(metadata).saiwork)
  const yolo = record(saiwork.yolo)
  if (saiwork.version !== SAIWORK_METADATA_VERSION || yolo.rootSessionId !== sessionId) return null
  return yolo.enabled === true
}

export function hasPersistedYolo(sessionId: string, metadata: unknown): boolean {
  return readPersistedYolo(sessionId, metadata) === true
}

export function mergePersistedYolo(metadata: unknown, rootSessionId: string, enabled: boolean): Metadata {
  const current = record(metadata)
  const saiwork = record(current.saiwork)
  return {
    ...current,
    saiwork: {
      ...saiwork,
      version: SAIWORK_METADATA_VERSION,
      yolo: { enabled, rootSessionId },
    },
  }
}

export function mergePersistedWorktreeSlug(metadata: unknown, worktreeSlug: string): Metadata {
  const current = record(metadata)
  const saiwork = record(current.saiwork)
  return {
    ...current,
    saiwork: { ...saiwork, version: SAIWORK_METADATA_VERSION, worktreeSlug },
  }
}

export function createOpencodeYoloPersistence(
  workspaceManager: WorkspaceManager,
  createClient: (manager: WorkspaceManager, instanceId: string) => OpencodeClient | null = createInstanceClient,
): OpencodeYoloPersistence {
  const writes = new Map<string, Promise<unknown>>()
  const clientFor = (instanceId: string) => {
    const client = createClient(workspaceManager, instanceId)
    if (!client) throw new Error(`Yolo: instance ${instanceId} has no open port`)
    return client
  }
  const updateMetadata = (
    instanceId: string,
    sessionId: string,
    workspaceId: string | undefined,
    update: (metadata: unknown) => Metadata,
  ): Promise<Metadata> => {
    const writeKey = sessionId
    const write = (writes.get(writeKey) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const client = clientFor(instanceId)
      const scope = { sessionID: sessionId, ...(workspaceId ? { workspace: workspaceId } : {}) }
      const { data: session } = await client.session.get(scope, { throwOnError: true })
      const metadata = update(session.metadata)
      const { data } = await client.session.update({ ...scope, metadata }, { throwOnError: true })
      return record(data?.metadata ?? metadata)
    })
    const settled = write.finally(() => {
      if (writes.get(writeKey) === settled) writes.delete(writeKey)
    })
    writes.set(writeKey, settled)
    return settled
  }
  return {
    async loadSessions(instanceId): Promise<PersistedAutoAcceptSession[]> {
      const { data } = await clientFor(instanceId).session.list(
        { scope: "project", limit: SESSION_LIST_LIMIT },
        { throwOnError: true },
      )
      return (data ?? []).map((session) => ({
        id: session.id,
        parentId: session.parentID ?? null,
        revert: session.revert,
        workspaceId: session.workspaceID,
        yoloEnabled: readPersistedYolo(session.id, session.metadata),
      }))
    },
    persist(instanceId, rootSessionId, enabled, workspaceId): Promise<void> {
      return updateMetadata(instanceId, rootSessionId, workspaceId,
        (metadata) => mergePersistedYolo(metadata, rootSessionId, enabled)).then(() => undefined)
    },
    async hasProjectSession(instanceId, sessionId): Promise<boolean> {
      const { data } = await clientFor(instanceId).session.list(
        { scope: "project", limit: SESSION_LIST_LIMIT },
        { throwOnError: true },
      )
      return (data ?? []).some((session) => session.id === sessionId)
    },
    setWorktreeSlug(instanceId, sessionId, worktreeSlug): Promise<Metadata> {
      return updateMetadata(instanceId, sessionId, undefined,
        (metadata) => mergePersistedWorktreeSlug(metadata, worktreeSlug))
    },
  }
}
