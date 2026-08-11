import { createSaiWorkRequester, type SaiWorkConfig, type PluginEvent } from "./request.js"

export { getSaiWorkConfig, type SaiWorkConfig, type PluginEvent } from "./request.js"

export function createSaiWorkClient(config: SaiWorkConfig) {
  const requester = createSaiWorkRequester(config)

  return {
    postEvent: (event: PluginEvent) =>
      requester.requestVoid("/event", {
        method: "POST",
        body: JSON.stringify(event),
      }),
    classifyGoogleError: (payload: { providerId: string; message?: string; status?: number; body?: unknown }) =>
      requester.requestServerJson("/api/google/classify-error", {
        method: "POST",
        body: JSON.stringify(payload),
      }) as Promise<{
        code: string
        providerId: string
        message: string
        retryable: boolean
        retryAfterSeconds?: number
      }>,
    startEvents: (onEvent: (event: PluginEvent) => void) => startPluginEvents(requester, onEvent),
  }
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function startPluginEvents(
  requester: ReturnType<typeof createSaiWorkRequester>,
  onEvent: (event: PluginEvent) => void,
) {
  // Fail plugin startup if we cannot establish the initial connection. A
  // plugin that cannot reach SAIWORK at all should say so loudly.
  const initialBody = await connectWithRetries(requester, 3)

  // After startup the stream is supervised, never abandoned: the old code did
  // `void consumeWithReconnect(...)` on a function that throws after three
  // consecutive failures, so a server restart became an unhandled rejection
  // and, if the process survived it, events stopped for the rest of the
  // session with nothing on screen to say why.
  superviseEventStream({
    connect: () => connectWithRetries(requester, 3),
    consume: (body) => consumeSseBody(body, onEvent),
    initialBody,
    onError: (error, attempt) => {
      const reason = error instanceof Error ? error.message : String(error)
      console.warn(`[SaiWorkPlugin] Event stream dropped (attempt ${attempt}), reconnecting: ${reason}`)
    },
  })
}

export interface EventStreamSupervisorOptions {
  connect: () => Promise<ReadableStream<Uint8Array>>
  consume: (body: ReadableStream<Uint8Array>) => Promise<void>
  initialBody?: ReadableStream<Uint8Array>
  onError?: (error: unknown, attempt: number) => void
  /** Injected for tests; defaults to real timers. */
  wait?: (ms: number) => Promise<void>
  baseDelayMs?: number
  maxDelayMs?: number
  /** Stops the loop. Only tests and shutdown use this. */
  signal?: { aborted: boolean }
}

/**
 * Keeps the event stream alive for as long as the plugin runs.
 *
 * Deliberately has no failure budget. "Give up after N tries" was the old
 * behaviour and it is wrong for a stream whose remote is a local server the
 * user restarts on purpose: the backoff is capped instead, so a long outage
 * costs one retry per `maxDelayMs` and recovers by itself whenever the server
 * comes back.
 *
 * Never rejects. Every error goes to `onError` and the loop continues, so this
 * can be started without a `catch` and cannot take the process down.
 */
export function superviseEventStream(options: EventStreamSupervisorOptions): { stop: () => void } {
  const wait = options.wait ?? delay
  const baseDelayMs = options.baseDelayMs ?? 500
  const maxDelayMs = options.maxDelayMs ?? 15_000
  const signal = options.signal ?? { aborted: false }

  const run = async () => {
    let body: ReadableStream<Uint8Array> | null = options.initialBody ?? null
    let attempt = 0

    while (!signal.aborted) {
      try {
        if (!body) {
          body = await options.connect()
        }
        await options.consume(body)
        body = null
        // A clean end of stream is still a disconnect, but not a fault: reset
        // the backoff so an idle server does not inherit an earlier outage.
        attempt = 0
      } catch (error) {
        body = null
        attempt += 1
        options.onError?.(error, attempt)
        if (signal.aborted) break
        await wait(Math.min(baseDelayMs * attempt, maxDelayMs))
      }
    }
  }

  void run()

  return {
    stop: () => {
      signal.aborted = true
    },
  }
}

async function connectWithRetries(requester: ReturnType<typeof createSaiWorkRequester>, maxAttempts: number) {
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await requester.requestSseBody("/events")
    } catch (error) {
      lastError = error
      await delay(500 * attempt)
    }
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError)
  const url = requester.buildUrl("/events")
  throw new Error(`[SaiWorkPlugin] Failed to connect to SaiWork at ${url} after ${maxAttempts} retries: ${reason}`)
}

async function consumeSseBody(body: ReadableStream<Uint8Array>, onEvent: (event: PluginEvent) => void) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  while (true) {
    const { done, value } = await reader.read()
    if (done || !value) {
      break
    }

    buffer += decoder.decode(value, { stream: true })

    let separatorIndex = buffer.indexOf("\n\n")
    while (separatorIndex >= 0) {
      const chunk = buffer.slice(0, separatorIndex)
      buffer = buffer.slice(separatorIndex + 2)
      separatorIndex = buffer.indexOf("\n\n")

      const event = parseSseChunk(chunk)
      if (event) {
        onEvent(event)
      }
    }
  }

  throw new Error("SSE stream ended")
}

function parseSseChunk(chunk: string): PluginEvent | null {
  const lines = chunk.split(/\r?\n/)
  const dataLines: string[] = []

  for (const line of lines) {
    if (line.startsWith(":")) continue
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart())
    }
  }

  if (dataLines.length === 0) return null

  const payload = dataLines.join("\n").trim()
  if (!payload) return null

  try {
    const parsed = JSON.parse(payload)
    if (!parsed || typeof parsed !== "object" || typeof (parsed as any).type !== "string") {
      return null
    }
    return parsed as PluginEvent
  } catch {
    return null
  }
}
