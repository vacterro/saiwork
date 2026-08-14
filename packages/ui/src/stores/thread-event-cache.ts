const FREEBUFF_EVENTS_PER_THREAD_LIMIT = 400
const FREEBUFF_EVENT_THREAD_LIMIT = 64

/** Insert/refresh one LRU thread bucket while bounding both dimensions. */
export function putThreadEvents<T>(
  current: ReadonlyMap<string, T[]>,
  threadId: string,
  events: T[],
  options: {
    eventsPerThread?: number
    threadLimit?: number
    maxWeightPerThread?: number
    weight?: (event: T) => number
  } = {},
): Map<string, T[]> {
  const eventsPerThread = options.eventsPerThread ?? FREEBUFF_EVENTS_PER_THREAD_LIMIT
  const threadLimit = options.threadLimit ?? FREEBUFF_EVENT_THREAD_LIMIT
  const maxWeight = options.maxWeightPerThread ?? Number.POSITIVE_INFINITY
  const weight = options.weight ?? (() => 1)
  const next = new Map(current)
  next.delete(threadId)
  if (events.length > 0 && eventsPerThread > 0 && threadLimit > 0) {
    const byCount = events.slice(-eventsPerThread)
    if (Number.isFinite(maxWeight)) {
      let remaining = Math.max(0, maxWeight)
      const bounded: T[] = []
      for (let index = byCount.length - 1; index >= 0; index -= 1) {
        const measured = weight(byCount[index]!)
        const eventWeight = Number.isFinite(measured) ? Math.max(0, measured) : remaining + 1
        if (eventWeight > remaining) break
        bounded.push(byCount[index]!)
        remaining -= eventWeight
      }
      bounded.reverse()
      if (bounded.length > 0) next.set(threadId, bounded)
    } else {
      next.set(threadId, byCount)
    }
  }
  while (next.size > Math.max(0, threadLimit)) {
    const oldest = next.keys().next().value as string | undefined
    if (oldest === undefined) break
    next.delete(oldest)
  }
  return next
}

export function deleteThreadEvents<T>(current: ReadonlyMap<string, T[]>, threadId: string): Map<string, T[]> {
  if (!current.has(threadId)) return current as Map<string, T[]>
  const next = new Map(current)
  next.delete(threadId)
  return next
}

export function pruneThreadEvents<T>(current: ReadonlyMap<string, T[]>, keep: ReadonlySet<string>): Map<string, T[]> {
  let changed = false
  const next = new Map<string, T[]>()
  for (const [threadId, events] of current) {
    if (keep.has(threadId)) next.set(threadId, events)
    else changed = true
  }
  return changed ? next : current as Map<string, T[]>
}
