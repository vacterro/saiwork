import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { createSharedInterval } from "./shared-interval"

describe("createSharedInterval", () => {
  it("keeps one timer until the final consumer releases it", () => {
    const started: Array<() => void> = []
    const cleared: unknown[] = []
    const poller = createSharedInterval(() => {}, 30_000, {
      set: (callback) => {
        started.push(callback)
        return { id: started.length } as unknown as ReturnType<typeof setInterval>
      },
      clear: (timer) => cleared.push(timer),
    })

    const releaseA = poller.subscribe()
    const releaseB = poller.subscribe()
    assert.equal(started.length, 1)
    assert.equal(poller.subscriberCount(), 2)
    releaseA()
    releaseA()
    assert.equal(cleared.length, 0)
    assert.equal(poller.subscriberCount(), 1)
    releaseB()
    assert.equal(cleared.length, 1)
    assert.equal(poller.subscriberCount(), 0)

    const releaseC = poller.subscribe()
    assert.equal(started.length, 2)
    releaseC()
    assert.equal(cleared.length, 2)
  })
})

