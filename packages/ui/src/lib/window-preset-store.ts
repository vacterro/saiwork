/**
 * The window preset store: add/remove/activate over the persisted array.
 *
 * Kept as pure functions over `WindowPreset[]` so the save/switch/delete
 * round-trip is provable without the preferences store. The preferences store
 * persists the array (and the active id) through the ordinary config bucket.
 */

import type { WindowPreset } from "./window-presets"

export interface WindowPresetCollection {
  presets: WindowPreset[]
  activeId: string | null
}

export function upsertPreset(collection: WindowPresetCollection, preset: WindowPreset): WindowPresetCollection {
  const index = collection.presets.findIndex((existing) => existing.id === preset.id)
  const presets = [...collection.presets]
  if (index >= 0) presets[index] = preset
  else presets.push(preset)
  const activeId = collection.activeId ?? preset.id
  return { presets, activeId }
}

export function removePreset(collection: WindowPresetCollection, id: string): WindowPresetCollection {
  const presets = collection.presets.filter((preset) => preset.id !== id)
  const activeId = collection.activeId === id ? (presets[0]?.id ?? null) : collection.activeId
  return { presets, activeId }
}

export function activatePreset(collection: WindowPresetCollection, id: string | null): WindowPresetCollection {
  if (id !== null && !collection.presets.some((preset) => preset.id === id)) {
    return collection
  }
  return { presets: collection.presets, activeId: id }
}
