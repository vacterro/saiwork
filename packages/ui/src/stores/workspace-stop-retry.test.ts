import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  addInstance,
  instances,
  setWorkspaceDeleteRetryForTests,
  stopInstance,
} from "./instances.ts"

function steppingWait() {
  const resolvers: Array<() => void> = []
  return {
    wait: () => new Promise<void>((resolve) => resolvers.push(resolve)),
    step: () => resolvers.shift()?.(),
  }
}

function makeInstance(id: string) {
  return { id, folder: `/work/${id}`, port: 0, pid: 0, proxyPath: "", status: "ready" as const, client: null }
}

/**
 * Closing a workspace used to drop the local entry first and fire the DELETE
 * as a one-shot. These tests pin the replacement behaviour: the instance
 * stays visible (and the process recoverable) until the server confirms the
 * delete, so a transport failure can never orphan a running workspace.
 */
describe("workspace stop retry wiring", () => {
  it("keeps the instance on a rejected DELETE and removes it after a successful retry", async () => {
    const clock = steppingWait()
    let rejections = 1
    setWorkspaceDeleteRetryForTests({
      wait: clock.wait,
      deleteWorkspace: () => {
        if (rejections > 0) {
          rejections -= 1
          return Promise.reject(new Error("Failed to fetch"))
        }
        return Promise.resolve()
      },
    })

    const id = "w-still-visible"
    addInstance(makeInstance(id))
    assert.equal(instances().has(id), true)

    stopInstance(id)

    await Promise.resolve()
    await Promise.resolve()
    assert.equal(instances().has(id), true, "a rejected DELETE must not remove the workspace")

    clock.step()
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(instances().has(id), false, "the workspace is removed once a retry lands")
  })

  it("keeps the instance visible even after the retry budget is spent", async () => {
    const clock = steppingWait()
    setWorkspaceDeleteRetryForTests({
      wait: clock.wait,
      deleteWorkspace: () => Promise.reject(new Error("Failed to fetch")),
    })

    const id = "w-gave-up"
    addInstance(makeInstance(id))
    stopInstance(id)

    await Promise.resolve()
    assert.equal(instances().has(id), true)

    for (let i = 0; i < 4; i++) {
      clock.step()
      await Promise.resolve()
      await Promise.resolve()
    }
    assert.equal(instances().has(id), true, "give-up keeps the workspace visible and closeable again")
  })
})
