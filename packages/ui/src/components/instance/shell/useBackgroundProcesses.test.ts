import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import { createRoot, createSignal } from "solid-js"
import type { BackgroundProcess } from "../../../../../server/src/api-types"
import { serverApi } from "../../../lib/api-client"
import { useBackgroundProcesses } from "./useBackgroundProcesses"

const processRecord = (id: string): BackgroundProcess => ({
  id,
  workspaceId: "ws-test",
  title: `process ${id}`,
  command: "echo hi",
  cwd: "/work",
  status: "running",
  startedAt: "2026-08-14T00:00:00.000Z",
})

const tick = () => new Promise((resolve) => setTimeout(resolve, 10))

describe("useBackgroundProcesses", () => {
  it("loads the background process list when the instance changes", async () => {
    const loaded: string[] = []
    const original = serverApi.listBackgroundProcesses
    serverApi.listBackgroundProcesses = async (instanceId: string) => {
      loaded.push(instanceId)
      return { processes: [] }
    }
    let dispose: () => void = () => {}
    let setInstanceId: (id: string) => void = () => {}
    createRoot((rootDispose) => {
      dispose = rootDispose
      const [instanceId, set] = createSignal("inst-1")
      setInstanceId = set
      useBackgroundProcesses({ instanceId })
    })
    await tick
    assert.deepEqual(loaded, ["inst-1"])

    setInstanceId("inst-2")
    await tick
    assert.deepEqual(loaded, ["inst-1", "inst-2"], "the shell must reload when the instance changes")

    dispose()
    serverApi.listBackgroundProcesses = original
  })

  it("opens and closes the output dialog around a selected process", async () => {
    const original = serverApi.listBackgroundProcesses
    serverApi.listBackgroundProcesses = async () => ({ processes: [] })
    let hook: ReturnType<typeof useBackgroundProcesses> | null = null
    let dispose: () => void = () => {}
    createRoot((rootDispose) => {
      dispose = rootDispose
      hook = useBackgroundProcesses({ instanceId: () => "inst-dialog" })
    })
    await tick
    assert.equal(hook!.showBackgroundOutput(), false)

    const proc = processRecord("p-open")
    hook!.openBackgroundOutput(proc)
    assert.equal(hook!.showBackgroundOutput(), true)
    assert.equal(hook!.selectedBackgroundProcess()?.id, "p-open")

    hook!.closeBackgroundOutput()
    assert.equal(hook!.showBackgroundOutput(), false)
    assert.equal(hook!.selectedBackgroundProcess(), null)

    dispose()
    serverApi.listBackgroundProcesses = original
  })

  it("stops and terminates through the server API, swallowing failures", async () => {
    const original = serverApi.listBackgroundProcesses
    serverApi.listBackgroundProcesses = async () => ({ processes: [] })
    let hook: ReturnType<typeof useBackgroundProcesses> | null = null
    let dispose: () => void = () => {}
    createRoot((rootDispose) => {
      dispose = rootDispose
      hook = useBackgroundProcesses({ instanceId: () => "inst-ops" })
    })
    await tick

    const stopped: Array<[string, string]> = []
    const originalStop = serverApi.stopBackgroundProcess
    serverApi.stopBackgroundProcess = async (instanceId: string, processId: string) => {
      stopped.push([instanceId, processId])
      return processRecord("p-stop")
    }
    await hook!.stopBackgroundProcess("p-stop")
    assert.deepEqual(stopped, [["inst-ops", "p-stop"]])
    serverApi.stopBackgroundProcess = originalStop

    const terminated: Array<[string, string]> = []
    const originalTerminate = serverApi.terminateBackgroundProcess
    serverApi.terminateBackgroundProcess = async (instanceId: string, processId: string) => {
      terminated.push([instanceId, processId])
    }
    await hook!.terminateBackgroundProcess("p-term")
    assert.deepEqual(terminated, [["inst-ops", "p-term"]])
    serverApi.terminateBackgroundProcess = originalTerminate

    const failingStop = serverApi.stopBackgroundProcess
    serverApi.stopBackgroundProcess = async () => {
      throw new Error("injected stop failure")
    }
    await hook!.stopBackgroundProcess("p-fail")
    serverApi.stopBackgroundProcess = failingStop

    dispose()
    serverApi.listBackgroundProcesses = original
  })

  it("keeps the shell free of background-process orchestration", () => {
    const shell = readFileSync(new URL("../instance-shell2.tsx", import.meta.url), "utf8")
    assert.match(shell, /useBackgroundProcesses\(/)
    assert.doesNotMatch(shell, /function openBackgroundOutput/)
    assert.doesNotMatch(shell, /const stopBackgroundProcess = async/)
    assert.doesNotMatch(shell, /const \[selectedBackgroundProcess, setSelectedBackgroundProcess\]/)
  })
})
