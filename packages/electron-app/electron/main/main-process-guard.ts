/**
 * Main-process crash guard.
 *
 * Electron shows a native "A JavaScript error occurred in the main process"
 * dialog for any uncaught exception in the main process, and a teardown race
 * during window/renderer destruction routinely throws "Object has been
 * destroyed" from inside Electron's own event dispatch (e.g.
 * `WebContents.disconnectRenderer` when a render process dies while its
 * WebContents is being torn down). That is a benign race, not an app bug, but
 * an unguarded process still pops a scary dialog.
 *
 * Installing these handlers suppresses the native dialog (Electron only shows
 * it when no handler is registered), keeps the app running, and lets the
 * window-recovery layer reopen whatever the user lost. All errors are logged
 * to the main process stderr.
 */

export interface ProcessGuardOptions {
  log?: (message: string) => void
}

const BENIGN_DESTROY_RE = /Object has been destroyed/i
const BENIGN_DESTROY_STACK_RE = /disconnectRenderer|render-process-gone|webContents/i

/** True when an error is the known-benign teardown race, not an app bug. */
export function isBenignDestroyRace(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  if (!BENIGN_DESTROY_RE.test(message)) return false
  const stack = error instanceof Error && error.stack ? error.stack : ""
  return BENIGN_DESTROY_STACK_RE.test(stack)
}

/** Register the process-level handlers; call once, before app.whenReady(). */
export function installProcessGuards(options: ProcessGuardOptions = {}): void {
  const log = options.log ?? ((message) => console.warn(message))

  process.on("uncaughtException", (error) => {
    if (isBenignDestroyRace(error)) {
      log(`[main-process] ignored destroyed-object teardown race: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    log(`[main-process] uncaught exception: ${message}`)
    if (error instanceof Error && error.stack) log(error.stack)
  })

  process.on("unhandledRejection", (reason) => {
    if (isBenignDestroyRace(reason)) {
      log(`[main-process] ignored destroyed-object rejection: ${reason instanceof Error ? reason.message : String(reason)}`)
      return
    }
    const message = reason instanceof Error ? reason.message : String(reason)
    log(`[main-process] unhandled rejection: ${message}`)
  })
}
