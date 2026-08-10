import { createSignal, onCleanup } from "solid-js"

/**
 * Reactive clock that ticks every `intervalMs` (default 1000ms). Use it for
 * relative-time labels ("just now", "3m ago") so they update in place instead
 * of only refreshing when some unrelated re-render happens.
 */
export function useNow(intervalMs = 1000): () => number {
  const [now, setNow] = createSignal(Date.now())
  if (typeof window === "undefined") return now
  const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
  onCleanup(() => window.clearInterval(timer))
  return now
}
