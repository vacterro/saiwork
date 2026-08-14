import fs from "fs"
import { promises as fsp } from "fs"
import os from "os"
import path from "path"
import { createHash } from "crypto"
import type { InstanceData } from "../api-types"
import { atomicWriteFile } from "../atomic-write"

export interface StoredInstanceData {
  data: InstanceData
  revision: number
}

const DEFAULT_INSTANCE_DATA: InstanceData = {
  messageHistory: [],
  agentModelSelections: {},
}

const EMPTY_STORED: StoredInstanceData = { data: DEFAULT_INSTANCE_DATA, revision: 0 }

export class InstanceStoreConflictError extends Error {
  constructor(readonly expectedRevision: number, readonly currentRevision: number) {
    super(`Instance data changed (expected revision ${expectedRevision}, current ${currentRevision})`)
    this.name = "InstanceStoreConflictError"
  }
}

export class InstanceStoreCorruptionError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message)
    this.name = "InstanceStoreCorruptionError"
  }
}

/**
 * File-backed per-instance state keyed by a collision-resistant digest, with
 * server-authoritative revisions.
 *
 * Reads validate the persisted shape (malformed JSON or a wrong-shaped
 * object is a corruption error, never a silent default; only a missing file
 * yields the default). Writes and deletes are CAS'd against the current
 * revision under a per-key lock, then persisted through the shared atomic
 * writer, so a stale renderer can never overwrite newer state and a torn
 * write can never become authoritative.
 */
export class InstanceStore {
  private readonly instancesDir: string
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(baseDir = path.join(os.homedir(), ".config", "saiwork", "instances")) {
    this.instancesDir = baseDir
    fs.mkdirSync(this.instancesDir, { recursive: true })
  }

  async read(id: string): Promise<StoredInstanceData> {
    const filePath = this.resolvePath(id)
    let raw: string
    try {
      raw = await fsp.readFile(filePath, "utf-8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return cloneStored(EMPTY_STORED)
      }
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new InstanceStoreCorruptionError(`Instance data is corrupt (invalid JSON) at ${filePath}`, error)
    }
    if (!isStoredInstanceData(parsed)) {
      throw new InstanceStoreCorruptionError(`Instance data has an invalid shape at ${filePath}`)
    }
    return { data: cloneInstanceData(parsed.data), revision: parsed.revision }
  }

  async write(id: string, data: InstanceData, expectedRevision: number): Promise<StoredInstanceData> {
    return this.withKeyLock(id, async () => {
      const current = await this.read(id)
      if (current.revision !== expectedRevision) {
        throw new InstanceStoreConflictError(expectedRevision, current.revision)
      }
      const nextRevision = current.revision + 1
      const stored = { revision: nextRevision, data: cloneInstanceData(data) }
      await atomicWriteFile(this.resolvePath(id), JSON.stringify(stored, null, 2))
      return { data: cloneInstanceData(stored.data), revision: nextRevision }
    })
  }

  async delete(id: string, expectedRevision: number): Promise<void> {
    return this.withKeyLock(id, async () => {
      const current = await this.read(id)
      if (current.revision !== expectedRevision) {
        throw new InstanceStoreConflictError(expectedRevision, current.revision)
      }
      await fsp.unlink(this.resolvePath(id)).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      })
    })
  }

  private withKeyLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const key = this.resolvePath(id)
    const previous = this.locks.get(key) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(operation)
    const tail = run.then(() => undefined, () => undefined)
    this.locks.set(key, tail)
    return run.finally(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key)
    })
  }

  private resolvePath(id: string): string {
    const digest = createHash("sha256").update(id).digest("hex")
    return path.join(this.instancesDir, `${digest}.json`)
  }
}

function isStoredInstanceData(value: unknown): value is StoredInstanceData {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (typeof record.revision !== "number" || !Number.isSafeInteger(record.revision) || record.revision < 0) {
    return false
  }
  return isInstanceData(record.data)
}

function isInstanceData(value: unknown): value is InstanceData {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.messageHistory) || record.messageHistory.some((entry) => typeof entry !== "string")) {
    return false
  }
  if (typeof record.agentModelSelections !== "object" || record.agentModelSelections === null || Array.isArray(record.agentModelSelections)) {
    return false
  }
  for (const [agent, selection] of Object.entries(record.agentModelSelections as Record<string, unknown>)) {
    void agent
    if (typeof selection !== "object" || selection === null) return false
    const model = selection as Record<string, unknown>
    if (typeof model.providerId !== "string" || typeof model.modelId !== "string") return false
  }
  return true
}

function cloneInstanceData(data: InstanceData): InstanceData {
  return {
    messageHistory: [...data.messageHistory],
    agentModelSelections: { ...data.agentModelSelections },
  }
}

function cloneStored(stored: StoredInstanceData): StoredInstanceData {
  return { data: cloneInstanceData(stored.data), revision: stored.revision }
}
