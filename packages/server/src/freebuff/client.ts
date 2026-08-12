import type {
  CreateThreadResult,
  FreebuffBusEvent,
  FreebuffExecutionMode,
  FreebuffQueueItem,
  FreebuffReasoningEffort,
  FreebuffThread,
} from "./types"

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface FreebuffClientOptions {
  baseUrl: string
  fetch?: FetchLike
}

export interface CreateThreadParams {
  projectPath: string
  harnessId?: string
  model?: string
  reasoningEffort?: FreebuffReasoningEffort
  executionMode?: FreebuffExecutionMode
  title?: string
}

export interface ThreadListResponse {
  threads: FreebuffThread[]
  [key: string]: unknown
}

export interface ProjectListEntry {
  path: string
  name?: string
  [key: string]: unknown
}

/**
 * Typed client for the FreeBuff desktop orchestrator's local HTTP + SSE API.
 *
 * The engine exposes the same routes the FreeBuff renderer uses; SAIWORK only
 * consumes a subset (threads, prompt dispatch, events, quota, projects). All
 * network goes through an injectable fetch so tests can exercise the contract
 * without a live engine.
 */
export function createFreebuffClient(options: FreebuffClientOptions) {
  const fetchFn = options.fetch ?? ((url, init) => fetch(url, init))
  const baseUrl = options.baseUrl.replace(/\/+$/, "")

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetchFn(`${baseUrl}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
    })
    const text = await response.text()
    let body: unknown = null
    if (text) {
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
    }
    if (!response.ok) {
      throw new FreebuffClientError(response.status, typeof body === "string" ? body : (body as Record<string, unknown> | null)?.error)
    }
    return body as T
  }

  return {
    get baseUrl(): string {
      return baseUrl
    },

    async authStatus(): Promise<{ authed: boolean; user?: unknown }> {
      return request("/api/auth/status")
    },

    async listThreads(): Promise<FreebuffThread[]> {
      const response = await request<ThreadListResponse>("/api/threads")
      return response.threads ?? []
    },

    async getThread(threadId: string): Promise<FreebuffThread> {
      return request(`/api/thread/${encodeURIComponent(threadId)}`)
    },

    async createThread(params: CreateThreadParams): Promise<CreateThreadResult> {
      return request("/api/threads", { method: "POST", body: JSON.stringify(params) })
    },

    /**
     * Dispatch a prompt directly to a thread (post + run immediately, bypassing
     * the queue). Equivalent to the FreeBuff UI composer's send.
     */
    async postMessage(threadId: string, text: string, attachments: string[] = []): Promise<{ ok?: boolean }> {
      return request(`/api/thread/${encodeURIComponent(threadId)}/message`, {
        method: "POST",
        body: JSON.stringify({ text, attachments }),
      })
    },

    /** Enqueue a prompt on a thread's queue; returns the queue item. */
    async enqueue(threadId: string, text: string, attachments: string[] = []): Promise<FreebuffQueueItem> {
      return request(`/api/thread/${encodeURIComponent(threadId)}/queue`, {
        method: "POST",
        body: JSON.stringify({ text, attachments }),
      })
    },

    /** Dispatch the next queued item (send-now) after enqueue. */
    async sendNow(itemId: string): Promise<{ ok?: boolean }> {
      return request(`/api/queue/${encodeURIComponent(itemId)}/send-now`, { method: "POST" })
    },

    async stopThread(threadId: string): Promise<{ ok?: boolean }> {
      return request(`/api/thread/${encodeURIComponent(threadId)}/stop`, { method: "POST" })
    },

    async resumeThread(threadId: string): Promise<{ ok?: boolean }> {
      return request(`/api/thread/${encodeURIComponent(threadId)}/resume`, { method: "POST" })
    },

    /**
     * Close a thread. FreeBuff releases the thread's hosted-model session slot
     * on close (the platform allows one hosted tab per network at a time), so
     * closing idle sibling threads is how SAIWORK keeps a slot available for
     * the thread the user is actively writing to. Sending a message later
     * reopens a closed thread without losing its history.
     */
    async closeThread(threadId: string): Promise<{ id?: string }> {
      return request(`/api/thread/${encodeURIComponent(threadId)}/close`, {
        method: "POST",
        body: JSON.stringify({}),
      })
    },

    async listProjects(): Promise<ProjectListEntry[]> {
      const response = await request<{ projects?: ProjectListEntry[] }>("/api/projects")
      return response.projects ?? []
    },

    /**
     * Subscribe to the engine's SSE event stream. Resolves when the stream
     * yields at least one event or ends; callback receives parsed events.
     * Returns an unsubscribe function that aborts the stream.
     */
    async subscribeEvents(onEvent: (event: FreebuffBusEvent) => void, onEnd?: (error?: unknown) => void): Promise<() => void> {
      const controller = new AbortController()
      let ended = false
      const finish = (error?: unknown) => {
        if (ended) return
        ended = true
        onEnd?.(error)
      }
      void (async () => {
        try {
          const response = await fetchFn(`${baseUrl}/api/events`, { signal: controller.signal })
          if (!response.ok || !response.body) {
            finish(new FreebuffClientError(response.status, "events stream failed"))
            return
          }
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ""
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            // Normalize CRLF/CR to LF before frame splitting: the engine may
            // switch its SSE to CRLF (or a proxy may rewrite line endings), and
            // a `\n\n`-only splitter would collapse the whole stream to its
            // first frame.
            buffer += decoder.decode(value, { stream: true })
              .replace(/\r\n/g, "\n")
              .replace(/\r/g, "\n")
            const frames = buffer.split("\n\n")
            buffer = frames.pop() ?? ""
            for (const frame of frames) {
              const line = frame
                .split("\n")
                .find((entry) => entry.startsWith("data: "))
              if (!line) continue
              const payload = line.slice(6)
              try {
                onEvent(JSON.parse(payload) as FreebuffBusEvent)
              } catch {
                // Skip malformed frames; a damaged stream should not kill the
                // subscription for later frames.
              }
            }
          }
          finish()
        } catch (error) {
          if (!controller.signal.aborted) finish(error)
        }
      })()
      return () => {
        controller.abort()
        finish()
      }
    },
  }
}

export type FreebuffClient = ReturnType<typeof createFreebuffClient>

export class FreebuffClientError extends Error {
  readonly status: number
  constructor(status: number, message?: unknown) {
    super(typeof message === "string" && message ? message : `FreeBuff engine request failed (HTTP ${status})`)
    this.name = "FreebuffClientError"
    this.status = status
  }
}
