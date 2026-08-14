import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

/**
 * Durable backing store for the Antigravity ToolCallRegistry. The registry maps
 * OpenAI tool-call ids to Google's `thoughtSignature`, which a stateless
 * OpenCode client cannot reconstruct after a server restart. Persistence keeps
 * the tool contract alive across restarts without exposing secrets (the
 * payload is call id + function name + a signature string, no credentials).
 */

export interface PersistedToolCallEntry {
  id: string
  name: string
  thoughtSignature?: string
  sessionId?: string
  createdAt: number
}

export interface ToolCallRegistryPersister {
  load(): Promise<PersistedToolCallEntry[]>
  save(entries: PersistedToolCallEntry[]): Promise<void>
}

function isEntry(value: unknown): value is PersistedToolCallEntry {
  if (!value || typeof value !== "object") return false
  const entry = value as Record<string, unknown>
  return typeof entry.id === "string" && typeof entry.name === "string"
}

/**
 * JSON-file persister with atomic temp+rename writes. A missing file loads as
 * an empty registry; malformed JSON or an unreadable file must NOT take the
 * shim down, so load() resolves to [] (the caller records fresh entries).
 */
export function createFileToolCallRegistryPersister(filePath: string): ToolCallRegistryPersister {
  let writeSequence = 0
  let pendingWrite = Promise.resolve()
  return {
    async load(): Promise<PersistedToolCallEntry[]> {
      let text: string
      try {
        text = await readFile(filePath, "utf8")
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return []
        throw error
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        return []
      }
      if (!Array.isArray(parsed)) return []
      const now = Date.now()
      return parsed.filter(isEntry).map((entry) => ({
        id: entry.id,
        name: entry.name,
        ...(typeof entry.thoughtSignature === "string" ? { thoughtSignature: entry.thoughtSignature } : {}),
        ...(typeof entry.sessionId === "string" ? { sessionId: entry.sessionId } : {}),
        createdAt: typeof entry.createdAt === "number" ? entry.createdAt : now,
      }))
    },

    async save(entries: PersistedToolCallEntry[]): Promise<void> {
      const snapshot = JSON.stringify(entries)
      const sequence = ++writeSequence
      pendingWrite = pendingWrite.catch(() => undefined).then(async () => {
        await mkdir(dirname(filePath), { recursive: true })
        const temporaryPath = `${filePath}.${process.pid}.${sequence}.tmp`
        try {
          await writeFile(temporaryPath, snapshot, "utf8")
          await rename(temporaryPath, filePath)
        } finally {
          await rm(temporaryPath, { force: true }).catch(() => undefined)
        }
      })
      await pendingWrite
    },
  }
}
