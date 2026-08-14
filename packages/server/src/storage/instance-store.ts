import fs from "fs"
import { promises as fsp } from "fs"
import os from "os"
import path from "path"
import { createHash } from "crypto"
import type { InstanceData } from "../api-types"

const DEFAULT_INSTANCE_DATA: InstanceData = {
  messageHistory: [],
  agentModelSelections: {},
}

/**
 * File-backed per-instance state keyed by a collision-resistant digest.
 *
 * The old lossy `sanitizeId` (collapse separators, lowercase, drop non-safe
 * chars) mapped distinct identities to one persistence file: `/a/b` and
 * `/a_b`, or any case-distinct POSIX path, collapsed to the same key. The
 * digest of the RAW id is now the authority, so two distinct workspace
 * identities can never share a storage object.
 */
export class InstanceStore {
  private readonly instancesDir: string

  constructor(baseDir = path.join(os.homedir(), ".config", "saiwork", "instances")) {
    this.instancesDir = baseDir
    fs.mkdirSync(this.instancesDir, { recursive: true })
  }

  async read(id: string): Promise<InstanceData> {
    try {
      const filePath = this.resolvePath(id)
      const content = await fsp.readFile(filePath, "utf-8")
      const parsed = JSON.parse(content)
      return { ...DEFAULT_INSTANCE_DATA, ...parsed }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return DEFAULT_INSTANCE_DATA
      }
      throw error
    }
  }

  async write(id: string, data: InstanceData): Promise<void> {
    const filePath = this.resolvePath(id)
    await fsp.mkdir(path.dirname(filePath), { recursive: true })
    await fsp.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8")
  }

  async delete(id: string): Promise<void> {
    try {
      const filePath = this.resolvePath(id)
      await fsp.unlink(filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error
      }
    }
  }

  private resolvePath(id: string): string {
    const digest = createHash("sha256").update(id).digest("hex")
    return path.join(this.instancesDir, `${digest}.json`)
  }
}
