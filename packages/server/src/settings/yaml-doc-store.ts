import fs from "fs"
import path from "path"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"
import type { Logger } from "../logger"
import { applyMergePatch, isPlainObject } from "./merge-patch"

export type SettingsDoc = Record<string, unknown>

export type SettingsStorageErrorCode = "load_failure" | "write_failure"

/** Structured storage failure: load corruption or a failed durable write. */
export class SettingsStorageError extends Error {
  readonly code: SettingsStorageErrorCode
  constructor(code: SettingsStorageErrorCode, message: string, readonly cause?: unknown) {
    super(message)
    this.name = "SettingsStorageError"
    this.code = code
  }
}

/** fs operations injectable for fault-injection tests. */
export interface YamlDocStoreFs {
  existsSync(path: string): boolean
  readFileSync(path: string, encoding: "utf-8"): string
  mkdirSync(dir: string, options: { recursive: boolean }): unknown
  writeFileSync(path: string, data: string, encoding: "utf-8"): void
  openSync(path: string, flag: string): number
  fsyncSync(fd: number): void
  closeSync(fd: number): void
  renameSync(from: string, to: string): void
  rmSync(path: string, options: { force: boolean }): void
}

const realFs: YamlDocStoreFs = {
  existsSync: (p) => fs.existsSync(p),
  readFileSync: (p, e) => fs.readFileSync(p, e),
  mkdirSync: (d, o) => fs.mkdirSync(d, o),
  writeFileSync: (p, d, e) => fs.writeFileSync(p, d, e),
  openSync: (p, f) => fs.openSync(p, f),
  fsyncSync: (fd) => fs.fsyncSync(fd),
  closeSync: (fd) => fs.closeSync(fd),
  renameSync: (f, t) => fs.renameSync(f, t),
  rmSync: (p, o) => fs.rmSync(p, o),
}

function ensureTrailingNewline(content: string): string {
  if (!content) return "\n"
  return content.endsWith("\n") ? content : `${content}\n`
}

/**
 * A valid settings doc is a plain object. A scalar, array or null YAML file is
 * corruption, not "empty settings" -- reinterpreting it as `{}` would silently
 * delete whatever was actually in the file on the next save.
 */
function normalizeDoc(input: unknown, failLabel: SettingsStorageErrorCode): SettingsDoc {
  if (!isPlainObject(input)) {
    throw new SettingsStorageError(
      failLabel,
      "Settings document is not an object; refusing to treat corruption as empty settings",
    )
  }
  return input
}

/**
 * Fail-closed YAML settings store.
 *
 * LOAD: "missing file" is the only legitimate empty state. An existing file
 * that is unreadable, malformed YAML, or not a plain object becomes a
 * PERSISTENT loadFailure: reads throw it, and every mutation refuses to run so
 * the corrupt source can never be overwritten by a save of "empty".
 *
 * MUTATION: fully transactional -- build the tentative doc, serialize, write a
 * temp file, fsync, rename into place, and ONLY then commit the cache. Any
 * mkdir/write/fsync/rename/serialization failure throws a structured
 * `SettingsStorageError("write_failure")`, preserves the previous cache and the
 * original disk file, and publishes nothing (the caller never sees success).
 */
export class YamlDocStore {
  private cache: SettingsDoc = {}
  private loaded = false
  private loadError: SettingsStorageError | null = null

  constructor(
    private readonly filePath: string,
    private readonly logger: Logger,
    deps: { fs?: YamlDocStoreFs; now?: () => number } = {},
  ) {
    this.fs = deps.fs ?? realFs
    this.now = deps.now ?? Date.now
  }

  private readonly fs: YamlDocStoreFs
  private readonly now: () => number

  load(): SettingsDoc {
    if (this.loaded) {
      if (this.loadError) throw this.loadError
      return this.cache
    }

    try {
      if (!this.fs.existsSync(this.filePath)) {
        this.cache = {}
        this.loaded = true
        return this.cache
      }

      const content = this.fs.readFileSync(this.filePath, "utf-8")
      const parsed = parseYaml(content)
      this.cache = normalizeDoc(parsed, "load_failure")
      this.loaded = true
      return this.cache
    } catch (error) {
      const wrapped = error instanceof SettingsStorageError
        ? error
        : new SettingsStorageError(
            "load_failure",
            `Failed to read settings document at ${this.filePath}`,
            error,
          )
      this.loadError = wrapped
      this.loaded = true
      this.logger.error({ err: error, filePath: this.filePath }, "Failed to read YAML doc; settings fail closed")
      throw wrapped
    }
  }

  get(): SettingsDoc {
    return this.load()
  }

  replace(next: unknown): SettingsDoc {
    // Fail closed: a source we could not read must never be overwritten.
    if (this.loadError) throw this.loadError

    const normalized = normalizeDoc(next, "write_failure")
    const yaml = stringifyYaml(normalized)

    const dir = path.dirname(this.filePath)
    const tmpPath = `${this.filePath}.tmp-${process.pid}-${this.now()}`
    try {
      this.fs.mkdirSync(dir, { recursive: true })
      this.fs.writeFileSync(tmpPath, ensureTrailingNewline(yaml), "utf-8")
      const fd = this.fs.openSync(tmpPath, "r")
      try {
        this.fs.fsyncSync(fd)
      } finally {
        this.fs.closeSync(fd)
      }
      this.fs.renameSync(tmpPath, this.filePath)
    } catch (error) {
      try {
        this.fs.rmSync(tmpPath, { force: true })
      } catch {
        // Best-effort temp cleanup; the failure that matters is reported below.
      }
      throw new SettingsStorageError(
        "write_failure",
        `Failed to persist settings document at ${this.filePath}`,
        error,
      )
    }

    // Only now is the write durable: commit the cache and report success.
    this.cache = normalized
    this.loaded = true
    return this.cache
  }

  mergePatch(patch: unknown): SettingsDoc {
    if (!isPlainObject(patch)) {
      throw new Error("Patch must be a JSON object")
    }
    const current = this.get()
    const next = applyMergePatch(current, patch)
    return this.replace(next)
  }

  getOwner(owner: string): SettingsDoc {
    const doc = this.get()
    const value = doc?.[owner]
    return isPlainObject(value) ? value : {}
  }

  replaceOwner(owner: string, value: unknown): SettingsDoc {
    const doc = this.get()
    const nextDoc: SettingsDoc = { ...doc, [owner]: normalizeDoc(value, "write_failure") }
    this.replace(nextDoc)
    return nextDoc[owner] as SettingsDoc
  }

  mergePatchOwner(owner: string, patch: unknown): SettingsDoc {
    if (!isPlainObject(patch)) {
      throw new Error("Patch must be a JSON object")
    }
    const doc = this.get()
    const currentOwner = isPlainObject(doc?.[owner]) ? doc[owner] as SettingsDoc : {}
    const nextOwner = normalizeDoc(applyMergePatch(currentOwner, patch), "write_failure")
    const nextDoc: SettingsDoc = { ...doc, [owner]: nextOwner }
    this.replace(nextDoc)
    return nextOwner
  }
}
