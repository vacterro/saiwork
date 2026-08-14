import { promises as fs } from "fs"
import type { FileHandle } from "fs/promises"

export interface BoundedOutputWriterOptions {
  capBytes?: number
  retainBytes?: number
  queueLimitBytes?: number
  onError?: (error: unknown) => void
}

export interface BoundedOutputWriterSnapshot {
  diskSize: number
  droppedBytes: number
  rotated: boolean
}

const DEFAULT_CAP_BYTES = 512 * 1024
const DEFAULT_RETAIN_BYTES = 256 * 1024
const DEFAULT_QUEUE_LIMIT_BYTES = 512 * 1024

/**
 * Serialized, bounded append log for a background process.
 *
 * Every write goes through a promise chain, so appends and rotations never
 * interleave. Writes use explicit file positions on a read/write handle
 * (append-mode handles reject `ftruncate` on Windows). When the file exceeds
 * `capBytes`, the oldest bytes are dropped and only the newest `retainBytes`
 * are kept (the file is truncated and rewritten with that tail). Enqueued
 * chunks that would push the in-memory backlog past `queueLimitBytes` are
 * dropped oldest-first from the queue head. Both drops count into
 * `droppedBytes`, so a hostile or chatty child cannot grow disk or RSS
 * without bound and the cumulative amount of trimmed output stays observable.
 */
export class BoundedOutputWriter {
  private readonly capBytes: number
  private readonly retainBytes: number
  private readonly queueLimitBytes: number
  private readonly onError?: (error: unknown) => void
  private fd: FileHandle | null = null
  private offset = 0
  private dropped = 0
  private readonly pending: Buffer[] = []
  private pendingBytes = 0
  private chain: Promise<void> = Promise.resolve()
  private failed = false
  private closed = false
  private lastRotated = false
  onWritten?: (snapshot: BoundedOutputWriterSnapshot) => void

  constructor(readonly path: string, options: BoundedOutputWriterOptions = {}) {
    this.capBytes = requirePositiveInteger(options.capBytes ?? DEFAULT_CAP_BYTES, "capBytes")
    const retain = requirePositiveInteger(options.retainBytes ?? DEFAULT_RETAIN_BYTES, "retainBytes")
    this.retainBytes = Math.min(retain, this.capBytes)
    this.queueLimitBytes = requirePositiveInteger(options.queueLimitBytes ?? DEFAULT_QUEUE_LIMIT_BYTES, "queueLimitBytes")
    this.onError = options.onError
  }

  get droppedBytes(): number {
    return this.dropped
  }

  /** Queue a chunk for append. Never throws; failures surface via onError. */
  enqueue(data: Buffer): void {
    if (this.failed || this.closed) {
      this.dropped += data.length
      return
    }

    let bytes = this.pendingBytes
    while (this.pending.length > 0 && bytes + data.length > this.queueLimitBytes) {
      const oldest = this.pending.shift()
      if (!oldest) break
      bytes -= oldest.length
      this.dropped += oldest.length
    }
    if (bytes + data.length > this.queueLimitBytes) {
      this.dropped += data.length
      return
    }

    this.pending.push(data)
    this.pendingBytes = bytes + data.length
    this.chain = this.chain
      .then(() => this.processOne())
      .catch((error) => this.fail(error))
  }

  /** Flush any queued chunks and close the underlying descriptor. */
  async close(): Promise<void> {
    this.closed = true
    await this.chain.catch(() => undefined)
    await this.closeFd()
  }

  /** Abandon queued chunks and close the underlying descriptor. */
  async destroy(): Promise<void> {
    this.failed = true
    this.pending.length = 0
    this.pendingBytes = 0
    await this.closeFd()
  }

  /** Await every queued write (used by tests to reach a settled state). */
  async flush(): Promise<void> {
    await this.chain
  }

  private async processOne(): Promise<void> {
    const data = this.pending.shift()
    if (!data || this.failed) return
    this.pendingBytes -= data.length

    const fd = await this.ensureOpen()
    if (this.failed) return
    const { bytesWritten } = await fd.write(data, 0, data.length, this.offset)
    this.offset += bytesWritten
    this.lastRotated = await this.rotateIfNeeded(fd)
    this.onWritten?.({
      diskSize: this.offset,
      droppedBytes: this.dropped,
      rotated: this.lastRotated,
    })
  }

  private async rotateIfNeeded(fd: FileHandle): Promise<boolean> {
    if (this.offset <= this.capBytes) return false

    const tail = Buffer.alloc(this.retainBytes)
    await fd.read(tail, 0, tail.length, this.offset - tail.length)
    this.dropped += this.offset - tail.length
    await fd.truncate(0)
    const { bytesWritten } = await fd.write(tail, 0, tail.length, 0)
    this.offset = bytesWritten
    return true
  }

  private async ensureOpen(): Promise<FileHandle> {
    if (this.fd) return this.fd
    this.fd = await fs.open(this.path, "w+")
    return this.fd
  }

  private async closeFd(): Promise<void> {
    if (!this.fd) return
    const fd = this.fd
    this.fd = null
    try {
      await fd.close()
    } catch {
      // Closing an already-closed descriptor is a benign teardown race.
    }
  }

  private fail(error: unknown): void {
    if (this.failed) return
    this.failed = true
    this.pending.length = 0
    this.pendingBytes = 0
    this.onError?.(error)
  }
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`)
  }
  return value
}
