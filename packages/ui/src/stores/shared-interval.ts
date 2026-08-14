export interface SharedInterval {
  subscribe(): () => void
  subscriberCount(): number
}

/** One interval shared by any number of mounted UI consumers. */
export function createSharedInterval(
  callback: () => void,
  intervalMs: number,
  timers: {
    set: (callback: () => void, intervalMs: number) => ReturnType<typeof setInterval>
    clear: (timer: ReturnType<typeof setInterval>) => void
  } = {
    set: (run, ms) => setInterval(run, ms),
    clear: (timer) => clearInterval(timer),
  },
): SharedInterval {
  let subscribers = 0
  let timer: ReturnType<typeof setInterval> | null = null
  return {
    subscribe() {
      subscribers += 1
      if (timer === null) timer = timers.set(callback, intervalMs)
      let released = false
      return () => {
        if (released) return
        released = true
        subscribers = Math.max(0, subscribers - 1)
        if (subscribers === 0 && timer !== null) {
          timers.clear(timer)
          timer = null
        }
      }
    },
    subscriberCount() {
      return subscribers
    },
  }
}
