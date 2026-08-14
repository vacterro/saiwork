import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { SingleFlightTicker } from "./stream-ticker"

/** Capture interval callbacks so the test controls every tick explicitly. */
function capturedScheduler() {
  const scheduled: Array<() => void> = []
  return {
    scheduled,
    schedule: ((callback: () => void) => {
      scheduled.push(callback)
      return 0 as unknown as NodeJS.Timeout
    }) as (callback: () => void, delay: number) => NodeJS.Timeout,
  }
}

describe("SingleFlightTicker", () => {
  it("skips a tick that overlaps an in-flight slow tick", async () => {
    const { schedule, scheduled } = capturedScheduler()
    let releaseRead!: () => void
    const gate = new Promise<void>((resolve) => { releaseRead = resolve })
    let reads = 0
    let completions = 0

    const ticker = new SingleFlightTicker(
      1,
      async () => {
        reads += 1
        await gate
        completions += 1
      },
      () => {},
      schedule,
    )

    ticker.tick()
    assert.equal(ticker.busy, true)
    ticker.tick()
    ticker.tick()
    assert.equal(reads, 1, "overlapping ticks must be dropped")

    releaseRead()
    while (ticker.busy) await Promise.resolve()
    assert.equal(completions, 1)
    assert.equal(scheduled.length, 1, "exactly one interval was scheduled")
    ticker.close()
  })

  it("runs the next tick after the previous one settles", async () => {
    const { schedule } = capturedScheduler()
    let reads = 0
    let releaseRead!: () => void
    const gate = new Promise<void>((resolve) => { releaseRead = resolve })
    const ticker = new SingleFlightTicker(
      1,
      async () => {
        reads += 1
        await gate
      },
      () => {},
      schedule,
    )

    ticker.tick()
    releaseRead()
    while (ticker.busy) await Promise.resolve()
    ticker.tick()
    assert.equal(reads, 2, "a settled tick frees the slot for the next one")
    releaseRead()
    while (ticker.busy) await Promise.resolve()
    ticker.close()
  })

  it("reports a tick error and keeps the slot free", async () => {
    const { schedule } = capturedScheduler()
    const errors: unknown[] = []
    const ticker = new SingleFlightTicker(
      1,
      async () => {
        throw new Error("tick boom")
      },
      (error) => errors.push(error),
      schedule,
    )

    ticker.tick()
    while (ticker.busy) await Promise.resolve()
    assert.equal(errors.length, 1)
    assert.equal(ticker.busy, false)
    ticker.close()
  })

  it("does not start ticks after close", () => {
    const { schedule, scheduled } = capturedScheduler()
    let runs = 0
    const ticker = new SingleFlightTicker(
      1,
      async () => { runs += 1 },
      () => {},
      schedule,
    )
    ticker.close()
    for (const callback of scheduled) callback()
    assert.equal(runs, 0, "no tick may run after close")
  })
})
