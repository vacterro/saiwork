import { promises as fs } from "fs"
import path from "path"
import { randomBytes } from "crypto"

/**
 * Crash-atomic file write: serialize to a unique same-directory temp file,
 * fsync it, then rename over the target. A reader can only ever observe the
 * complete old content or the complete new content, never a torn partial
 * write. Any failure removes the temp file and propagates, leaving the
 * target untouched.
 */
export async function atomicWriteFile(filePath: string, content: string | Buffer): Promise<void> {
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`)
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(tempPath, "w")
    await handle.writeFile(content)
    try {
      await handle.sync()
    } catch (error) {
      if (!isSyncSupportedError(error)) throw error
    }
    await handle.close()
    handle = undefined
    await fs.rename(tempPath, filePath)
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined)
    throw error
  } finally {
    if (handle) {
      await handle.close().catch(() => undefined)
    }
  }
}

function isSyncSupportedError(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : ""
  return code === "EINVAL" || code === "ENOTSUP" || code === "EPERM"
}
