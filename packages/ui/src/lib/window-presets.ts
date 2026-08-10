/**
 * Window layout presets and the snap math behind Ctrl+Q.
 *
 * A preset is a named size/position pair the user saves once and re-applies
 * with one keystroke. The pure math lives here so it can be proven without a
 * window: given a preset and the display work area, the resolved bounds are the
 * preset's size clamped to the display and its position clamped inside it
 * (centered when the preset carries no position).
 */

export interface WindowPreset {
  id: string
  name: string
  width: number
  height: number
  x?: number
  y?: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export const MIN_PRESET_WIDTH = 320
export const MIN_PRESET_HEIGHT = 240

export function normalizePreset(preset: WindowPreset): WindowPreset {
  return {
    ...preset,
    width: Math.max(Math.round(preset.width), MIN_PRESET_WIDTH),
    height: Math.max(Math.round(preset.height), MIN_PRESET_HEIGHT),
    x: preset.x === undefined ? undefined : Math.round(preset.x),
    y: preset.y === undefined ? undefined : Math.round(preset.y),
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function resolvePresetBounds(preset: WindowPreset, workArea: Rect): Rect {
  const normalized = normalizePreset(preset)
  const width = Math.min(normalized.width, workArea.width)
  const height = Math.min(normalized.height, workArea.height)
  // A preset without a position centers the window on the display; with one,
  // it keeps it -- then clamps so the whole window stays inside the work area.
  const x = clamp(
    normalized.x === undefined
      ? Math.round(workArea.x + (workArea.width - width) / 2)
      : normalized.x,
    workArea.x,
    workArea.x + workArea.width - width,
  )
  const y = clamp(
    normalized.y === undefined
      ? Math.round(workArea.y + (workArea.height - height) / 2)
      : normalized.y,
    workArea.y,
    workArea.y + workArea.height - height,
  )
  return { x, y, width, height }
}
