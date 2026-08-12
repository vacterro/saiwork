export interface TabMeasurement {
  id: string
  width: number
}

/** Fit tabs in source order while reserving space for the active tab. */
export function getOverflowTabIds(
  measurements: readonly TabMeasurement[],
  availableWidth: number,
  activeTabId: string | null,
  gap = 0,
): string[] {
  const visible = new Set<string>()
  const active = measurements.find((measurement) => measurement.id === activeTabId)
  let usedWidth = 0
  let overflowStarted = false

  if (active) {
    visible.add(active.id)
    usedWidth = Math.min(active.width, availableWidth)
  }

  for (const measurement of measurements) {
    if (visible.has(measurement.id)) continue
    if (overflowStarted) continue
    const nextWidth = measurement.width + (visible.size > 0 ? gap : 0)
    if (usedWidth + nextWidth > availableWidth) {
      overflowStarted = true
      continue
    }
    visible.add(measurement.id)
    usedWidth += nextWidth
  }

  return measurements.filter((measurement) => !visible.has(measurement.id)).map((measurement) => measurement.id)
}
