/**
 * Main-window recreation policy for app `activate`.
 *
 * The main window is the app's primary surface. When it closes while detached
 * session windows (auxiliary windows) survive, the app stays alive for them,
 * but the user has no way back to the main surface: the old check only
 * recreated a window when NO windows remained, so a surviving detached pane
 * permanently suppressed recovery. The decision is extracted here so the
 * lifecycle rule is testable without booting Electron.
 */
export function shouldRecreateMainWindow(mainWindow: { isDestroyed(): boolean } | null): boolean {
  return !mainWindow || mainWindow.isDestroyed()
}
