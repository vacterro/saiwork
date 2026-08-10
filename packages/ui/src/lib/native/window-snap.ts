/**
 * Snaps the OS window to a layout preset.
 *
 * The renderer holds the preset store (editable, persisted) but only Electron
 * main can touch window bounds, so the snap goes over two small IPC calls: one
 * to learn the display work area, one to apply the resolved bounds. In a plain
 * browser context there is no `electronAPI` and the call is a no-op.
 */

import { resolvePresetBounds, type Rect, type WindowPreset } from "../window-presets"

interface WindowSnapNativeApi {
  getWorkArea?: () => Promise<Rect>
  snapWindowToBounds?: (bounds: Rect) => Promise<void>
}

let cachedWorkArea: Rect | null = null

function nativeApi(): WindowSnapNativeApi | undefined {
  return (globalThis as unknown as { electronAPI?: WindowSnapNativeApi }).electronAPI
}

export async function snapWindowToPreset(preset: WindowPreset): Promise<boolean> {
  const api = nativeApi()
  if (!api?.getWorkArea || !api.snapWindowToBounds) return false
  const workArea = cachedWorkArea ?? (cachedWorkArea = await api.getWorkArea())
  const bounds = resolvePresetBounds(preset, workArea)
  await api.snapWindowToBounds(bounds)
  return true
}

/** Test seam: a display resolution change should re-read the work area. */
export function resetCachedWorkAreaForTests(): void {
  cachedWorkArea = null
}
