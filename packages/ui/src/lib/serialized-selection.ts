/**
 * Serialized per-key selection writes with an immediate pending overlay.
 *
 * A UI that pushes a selection to a slow server must show the new value
 * immediately (the overlay) while the write is in flight, must apply writes
 * strictly in order so a stale response can never land after a newer one,
 * and must not let an older write's completion clear a newer pending
 * overlay. This class owns exactly those three invariants; the storage
 * mechanics stay in the caller's `apply` callback.
 */
export class SerializedSelectionMap<T> {
  private readonly pending = new Map<string, { value: T | undefined; version: number }>()
  private readonly onError?: (error: unknown) => void
  private version = 0
  private chain: Promise<void> = Promise.resolve()

  constructor(
    private readonly persisted: (key: string) => T | undefined,
    options?: { onError?: (error: unknown) => void },
  ) {
    this.onError = options?.onError
  }

  /** The newest value: the pending overlay if one is in flight, else persisted. */
  read(key: string): T | undefined {
    const pending = this.pending.get(key)
    return pending ? pending.value : this.persisted(key)
  }

  /**
   * Queue a write. Returns the version assigned to this write. The caller
   * does not need the version for anything except tests: settling is internal.
   * A failed write never breaks the chain; it surfaces via `onError` and the
   * pending overlay is still released version-guarded.
   */
  set(key: string, value: T | undefined, apply: (value: T | undefined) => Promise<void>): number {
    if (this.read(key) === value) return this.version
    const nextVersion = ++this.version
    this.pending.set(key, { value, version: nextVersion })
    this.chain = this.chain.then(async () => {
      try {
        await apply(value)
      } catch (error) {
        this.onError?.(error)
      } finally {
        // Only the newest write may clear the overlay; an older write that
        // settled after a newer one was issued must leave the overlay alone.
        const current = this.pending.get(key)
        if (current?.version === nextVersion) this.pending.delete(key)
      }
    })
    return nextVersion
  }

  /** Await every queued write (used by tests to reach a settled state). */
  async flush(): Promise<void> {
    await this.chain
  }
}
