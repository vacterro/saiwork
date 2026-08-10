import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { superviseEventStream } from "./client.js"

type Body = ReadableStream<Uint8Array>

/** Stand-in stream body; the supervisor only ever hands it to `consume`. */
const FAKE_BODY = {} as Body

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Lets the microtask queue drain so the supervisor's loop can advance. */
async function settle(times = 12) {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve()
  }
}

describe("event stream supervisor", () => {
  it("survives more consecutive failures than the old three-strike budget", async () => {
    const errors: unknown[] = []
    let connects = 0

    const supervisor = superviseEventStream({
      connect: async () => {
        connects += 1
        throw new Error(`connect failed ${connects}`)
      },
      consume: async () => {},
      wait: async () => {},
      onError: (error) => {
        errors.push(error)
        // Stop once we are well past the old limit, otherwise this loops forever.
        if (errors.length >= 8) supervisor.stop()
      },
    })

    await settle(200)

    assert.ok(errors.length >= 8, `expected the loop to keep going, saw ${errors.length} attempts`)
  })

  it("does not reject, so it can be started without a catch", async () => {
    const rejections: unknown[] = []
    const onUnhandled = (error: unknown) => rejections.push(error)
    process.on("unhandledRejection", onUnhandled)

    try {
      const supervisor = superviseEventStream({
        connect: async () => {
          throw new Error("boom")
        },
        consume: async () => {},
        wait: async () => {},
        onError: () => supervisor.stop(),
      })

      await settle(50)
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }

    assert.deepEqual(rejections, [], "the old code turned an exhausted stream into an unhandled rejection")
  })

  it("resumes delivering events after the server comes back", async () => {
    const seen: string[] = []
    let connects = 0
    const reconnected = deferred()

    const supervisor = superviseEventStream({
      connect: async () => {
        connects += 1
        if (connects === 1) throw new Error("server down")
        return FAKE_BODY
      },
      consume: async () => {
        seen.push(`stream-${connects}`)
        reconnected.resolve()
        // Park so the loop does not spin while the assertions run.
        await new Promise<void>(() => {})
      },
      wait: async () => {},
      onError: () => {},
    })

    await reconnected.promise
    supervisor.stop()

    assert.deepEqual(seen, ["stream-2"], "events resumed on the connection after the failure")
  })

  it("caps the backoff instead of growing without bound", async () => {
    const waits: number[] = []
    let attempts = 0

    const supervisor = superviseEventStream({
      connect: async () => {
        attempts += 1
        throw new Error("still down")
      },
      consume: async () => {},
      baseDelayMs: 1000,
      maxDelayMs: 2500,
      wait: async (ms) => {
        waits.push(ms)
        if (waits.length >= 5) supervisor.stop()
      },
      onError: () => {},
    })

    await settle(200)

    assert.deepEqual(waits.slice(0, 5), [1000, 2000, 2500, 2500, 2500])
    assert.ok(attempts >= 5)
  })

  it("resets the backoff after a stream ends cleanly", async () => {
    const waits: number[] = []
    let connects = 0

    const supervisor = superviseEventStream({
      connect: async () => {
        connects += 1
        // Fail once, then serve a stream that ends normally, then fail again.
        if (connects === 1) throw new Error("first failure")
        if (connects === 2) return FAKE_BODY
        throw new Error("later failure")
      },
      consume: async () => {},
      baseDelayMs: 100,
      wait: async (ms) => {
        waits.push(ms)
        if (waits.length >= 2) supervisor.stop()
      },
      onError: () => {},
    })

    await settle(200)

    assert.deepEqual(waits, [100, 100], "the second outage starts from the base delay, not where the first left off")
  })
})
