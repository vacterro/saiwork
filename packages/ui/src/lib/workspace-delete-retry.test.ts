import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  createWorkspaceDeleteRetry,
  WORKSPACE_DELETE_INITIAL_RETRY_MS,
  WORKSPACE_DELETE_MAX_RETRY_MS,
  type WorkspaceDeleteRetryDeps,
} from "./workspace-delete-retry.ts"

function steppingWait() {
  const resolvers: Array<() => void> = []
  const delays: number[] = []
  return {
    wait: (delayMs: number) => {
      delays.push(delayMs)
      return new Promise<void>((resolve) => resolvers.push(resolve))
    },
    step: () => resolvers.shift()?.(),
    pending: () => resolvers.length,
    delays,
  }
}

interface Harness {
  deletes: string[]
  deleted: string[]
  gaveUp: string[]
  clock: ReturnType<typeof steppingWait>
  retry: ReturnType<typeof createWorkspaceDeleteRetry>
}

function harness(options: { rejectCount?: number; rejectAlways?: boolean } = {}): Harness {
  let rejectionsLeft = options.rejectCount ?? 0
  const clock = steppingWait()
  const record: Harness = {
    deletes: [],
    deleted: [],
    gaveUp: [],
    clock,
    retry: undefined as unknown as ReturnType<typeof createWorkspaceDeleteRetry>,
  }
  const deps: WorkspaceDeleteRetryDeps = {
    deleteWorkspace: (id) => {
      record.deletes.push(id)
      if (options.rejectAlways || rejectionsLeft > 0) {
        rejectionsLeft -= 1
        return Promise.reject(new Error("Failed to fetch"))
      }
      return Promise.resolve()
    },
    onDeleted: (id) => record.deleted.push(id),
    onGiveUp: (id) => record.gaveUp.push(id),
    wait: clock.wait,
  }
  record.retry = createWorkspaceDeleteRetry(deps)
  return record
}

/**
 * The whole point: the DELETE must land before the workspace is treated as
 * gone. A rejection keeps the loop alive (and the workspace visible) until a
 * retry succeeds, instead of dropping the workspace the instant the first
 * request fails.
 */
describe("workspace delete retry", () => {
  it("removes the workspace only after the delete lands", async () => {
    const h = harness({ rejectCount: 1 })
    h.retry.begin("w1")

    await Promise.resolve()
    await Promise.resolve()
    assert.equal(h.deleted.length, 0, "the workspace must stay visible while the first attempt is out")
    assert.equal(h.deletes.length, 1)

    h.clock.step()
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(h.deletes.length, 2, "the failed attempt retried")
    assert.deepEqual(h.deleted, ["w1"], "deleted only after a retry landed")
    assert.equal(h.gaveUp.length, 0)
  })

  it("retries a transport failure until the bounded budget is spent", async () => {
    const h = harness({ rejectAlways: true })
    h.retry.begin("w1")

    for (let i = 0; i < 10; i++) {
      await Promise.resolve()
      h.clock.step()
      await Promise.resolve()
    }

    assert.equal(h.deletes.length, 5, "exactly the attempt budget is spent")
    assert.equal(h.deleted.length, 0)
    assert.deepEqual(h.gaveUp, ["w1"], "the workspace stays visible and the caller is told to keep it")
  })

  it("backs off exponentially up to the cap", async () => {
    const h = harness({ rejectAlways: true })
    h.retry.begin("w1")

    for (let i = 0; i < 10; i++) {
      await Promise.resolve()
      h.clock.step()
      await Promise.resolve()
    }

    assert.deepEqual(
      h.clock.delays,
      [500, 1000, 2000, 4000].map((value) => Math.min(value, WORKSPACE_DELETE_MAX_RETRY_MS)),
      "delay doubles between attempts and never grows past the cap",
    )
    assert.equal(h.clock.delays[0], WORKSPACE_DELETE_INITIAL_RETRY_MS)
  })

  it("cancelling stops the loop without claiming success or failure", async () => {
    const h = harness({ rejectAlways: true })
    h.retry.begin("w1")
    await Promise.resolve()
    assert.equal(h.deletes.length, 1)

    h.retry.cancel("w1")
    h.clock.step()
    await Promise.resolve()

    assert.equal(h.deletes.length, 1, "no further attempt after cancel")
    assert.equal(h.deleted.length, 0)
    assert.equal(h.gaveUp.length, 0)
  })

  it("is single-flight per id", async () => {
    const h = harness({ rejectCount: 99 })
    h.retry.begin("w1")
    h.retry.begin("w1")
    assert.equal(h.deletes.length, 1, "a second begin while active is a no-op")
  })

  it("starts a fresh loop after giving up", async () => {
    const h = harness({ rejectAlways: true })
    h.retry.begin("w1")
    for (let i = 0; i < 10; i++) {
      await Promise.resolve()
      h.clock.step()
      await Promise.resolve()
    }
    assert.equal(h.deletes.length, 5)

    h.retry.begin("w1")
    await Promise.resolve()
    assert.equal(h.deletes.length, 6, "a user re-close after give-up gets a fresh budget")
  })
})
