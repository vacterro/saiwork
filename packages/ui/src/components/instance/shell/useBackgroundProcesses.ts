import { createEffect, createSignal, type Accessor } from "solid-js"
import type { BackgroundProcess } from "../../../../../server/src/api-types"
import { serverApi } from "../../../lib/api-client"
import { getLogger } from "../../../lib/logger"
import { loadBackgroundProcesses } from "../../../stores/background-processes"

const log = getLogger("session")

interface UseBackgroundProcessesOptions {
  instanceId: Accessor<string>
}

/**
 * Owns the background-process dialog state and lifecycle for a shell:
 * loads the process list when the instance changes, and drives the
 * open/close/stop/terminate interactions without the shell wiring them.
 */
export function useBackgroundProcesses(options: UseBackgroundProcessesOptions) {
  const [selectedBackgroundProcess, setSelectedBackgroundProcess] = createSignal<BackgroundProcess | null>(null)
  const [showBackgroundOutput, setShowBackgroundOutput] = createSignal(false)

  createEffect(() => {
    const instanceId = options.instanceId()
    loadBackgroundProcesses(instanceId).catch((error) => {
      log.warn("Failed to load background processes", error)
    })
  })

  const openBackgroundOutput = (process: BackgroundProcess) => {
    setSelectedBackgroundProcess(process)
    setShowBackgroundOutput(true)
  }

  const closeBackgroundOutput = () => {
    setShowBackgroundOutput(false)
    setSelectedBackgroundProcess(null)
  }

  const stopBackgroundProcess = async (processId: string) => {
    try {
      await serverApi.stopBackgroundProcess(options.instanceId(), processId)
    } catch (error) {
      log.warn("Failed to stop background process", error)
    }
  }

  const terminateBackgroundProcess = async (processId: string) => {
    try {
      await serverApi.terminateBackgroundProcess(options.instanceId(), processId)
    } catch (error) {
      log.warn("Failed to terminate background process", error)
    }
  }

  return {
    selectedBackgroundProcess,
    showBackgroundOutput,
    openBackgroundOutput,
    closeBackgroundOutput,
    stopBackgroundProcess,
    terminateBackgroundProcess,
  }
}
