/**
 * Single-flight interval ticker for live output streaming.
 *
 * The wrapped tick is async; without serialization a slow stat/read could
 * overlap the next interval tick, and two ticks could observe the same file
 * position, duplicating a byte range or reordering a rotation truncate event
 * after the retained tail. `tick()` returns immediately when a tick is still
 * in flight, so exactly one tick mutates shared state at a time.
 */
export class SingleFlightTicker {
  private inFlight = false
  private closed = false
  private readonly timer: NodeJS.Timeout

  constructor(
    private readonly intervalMs: number,
    private readonly tickFn: () => Promise<void>,
    private readonly onError: (error: unknown) => void,
    schedule: (callback: () => void, delay: number) => NodeJS.Timeout = setInterval,
    unref: (handle: NodeJS.Timeout) => void = (handle) => handle.unref?.(),
  ) {
    this.timer = schedule(() => {
      void this.tick()
    }, intervalMs)
    unref(this.timer)
  }

  /** Run one tick unless one is already in flight or the ticker is closed. */
  tick(): void {
    if (this.inFlight || this.closed) return
    this.inFlight = true
    void (async () => {
      try {
        await this.tickFn()
      } catch (error) {
        this.onError(error)
      } finally {
        this.inFlight = false
      }
    })()
  }

  /** True while a tick is running. */
  get busy(): boolean {
    return this.inFlight
  }

  /** True once the ticker has been closed. */
  get isClosed(): boolean {
    return this.closed
  }

  /** Stop the timer; an in-flight tick settles harmlessly afterwards. */
  close(): void {
    if (this.closed) return
    this.closed = true
    clearInterval(this.timer)
  }
}
