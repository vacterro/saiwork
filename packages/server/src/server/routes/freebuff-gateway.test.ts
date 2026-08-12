import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { runTurnWithSlotRetry } from "./freebuff-gateway"
import type { FreebuffClient } from "../../freebuff/client"
import type { FreebuffController } from "../../freebuff/controller"

function fakeClient(postImpl: () => Promise<unknown>): { client: FreebuffClient; emit: (event: unknown) => void } {
  let emitFn: ((event: unknown) => void) | null = null
  const client = {
    baseUrl: "http://127.0.0.1:18000",
    postMessage: postImpl,
    stopThread: async () => ({ ok: true }),
    closeThread: async () => ({ id: "t-1" }),
    subscribeEvents: (onEvent: (event: unknown) => void) => {
      emitFn = onEvent
      return Promise.resolve(() => {
        emitFn = null
      })
    },
  } as unknown as FreebuffClient
  return {
    client,
    emit: (event: unknown) => emitFn?.(event),
  }
}

const fakeController = (): FreebuffController => ({
  freeSlotFor: async () => {},
} as unknown as FreebuffController)

describe("freebuff gateway slot retry", () => {
  it("waits out a held slot and succeeds once the admission lands", async () => {
    let posts = 0
    const { client, emit } = fakeClient(async () => {
      posts += 1
      if (posts < 3) {
        throw new Error("Freebuff is limited to one tab at a time on your network. Close the other hosted-model tab and try again.")
      }
      return { ok: true }
    })

    const steps: string[] = []
    const turnPromise = runTurnWithSlotRetry(fakeController(), client, "t-1", "hello", () => {}, {
      onStep: (delta) => steps.push(delta),
      slotRetry: { attempts: 4, waitMs: 5 },
    })

    // Drive the successful third attempt to completion.
    await new Promise((resolve) => setTimeout(resolve, 250))
    while (posts < 3) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
    emit({ type: "thread", threadId: "t-1", thread: { id: "t-1", turnState: "running", status: "open" } })
    emit({ type: "agent", threadId: "t-1", seq: 1, event: { type: "text", text: "admitted" } })
    emit({ type: "thread", threadId: "t-1", thread: { id: "t-1", turnState: "idle", status: "open" } })

    const text = await turnPromise
    assert.equal(text, "admitted")
    assert.ok(posts >= 3, `expected at least 3 postMessage attempts, got ${posts}`)
    assert.deepEqual(steps, ["> waiting for the FreeBuff slot (another tab is holding it)…"])
  })

  it("fails with a no-quota-consumed message after retries are exhausted", async () => {
    const { client } = fakeClient(async () => {
      throw new Error("Freebuff is limited to one tab at a time on your network. Close the other hosted-model tab and try again.")
    })

    const turnPromise = runTurnWithSlotRetry(fakeController(), client, "t-1", "hello", () => {}, {
      slotRetry: { attempts: 2, waitMs: 5 },
    })
    await assert.rejects(turnPromise, /No FreeBuff quota was consumed/)
  })

  it("does not retry non-slot engine errors", async () => {
    let posts = 0
    const { client } = fakeClient(async () => {
      posts += 1
      throw new Error("quota exhausted")
    })

    const turnPromise = runTurnWithSlotRetry(fakeController(), client, "t-1", "hello", () => {}, {
      slotRetry: { attempts: 4, waitMs: 5 },
    })
    await assert.rejects(turnPromise, /quota exhausted/)
    assert.equal(posts, 1)
  })
})
