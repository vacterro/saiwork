import { createHash } from "node:crypto"

import { createFreebuffClient, type FreebuffClient } from "./client"
import { freebuffMaxReasoningEffort } from "./models"
import { FREEBUFF_HARNESS_ID, FREEBUFF_EXECUTION_MODE_LOCAL, type FreebuffThread } from "./types"

/**
 * OpenAI-compatible gateway translation for the FreeBuff agent engine.
 *
 * FreeBuff is a full agent orchestrator (threads + queue + its own tools), not
 * a token model. Surfacing it as an OpenCode provider makes it a "super model":
 * OpenCode streams the user's prompt, the gateway routes it to a FreeBuff
 * thread, and FreeBuff runs its own agent loop (tools, files, subagents) while
 * the gateway translates the resulting `text` events back into an OpenAI
 * stream. OpenCode's own tool layer is not involved.
 *
 * Sessions map to threads: one thread per (workspace, OpenCode session id).
 */

export interface FreebuffOpenAiMessage {
  role: string
  content?: string | Array<{ type: string; text?: string }> | null
}

export interface FreebuffOpenAiChatRequest {
  model: string
  messages: FreebuffOpenAiMessage[]
  stream?: boolean
}

export function freebuffOpenAiText(content: FreebuffOpenAiMessage["content"]): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .filter((part): part is { type: string; text: string } => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
  }
  return ""
}

/**
 * The first user text is the thread TITLE seed only; it is never the thread
 * identity. Canonical thread identity is workspace + OpenCode session id +
 * model (see freebuffThreadKey).
 */
export function firstUserText(messages: FreebuffOpenAiMessage[]): string {
  for (const message of messages) {
    if (message.role === "user") {
      const text = freebuffOpenAiText(message.content)
      if (text) return text
    }
  }
  return ""
}

/** The text of the last user message: the new prompt for this turn. */
export function lastUserText(messages: FreebuffOpenAiMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === "user") {
      const text = freebuffOpenAiText(message.content)
      if (text) return text
    }
  }
  return ""
}

/** Stable per-session thread key: workspace + the real conversation (session) id. */
export function freebuffThreadKey(workspace: string, sessionId: string, model = ""): string {
  return createHash("sha1").update(`${workspace}\u0000${sessionId}\u0000${model}`).digest("hex").slice(0, 16)
}

/**
 * Request/turn identity: a digest of the full message replay. A transport
 * retry resends the identical array, so the digest matches and the dispatch is
 * idempotent. An intentional repeated prompt ("continue" twice) follows a
 * longer history -- the previous assistant reply is now in the array -- so the
 * digest differs and the turn executes normally. Text equality alone is never
 * the identity.
 */
export function turnFingerprint(messages: FreebuffOpenAiMessage[]): string {
  return createHash("sha1").update(JSON.stringify(messages)).digest("hex")
}

/** A hard turn bound was reached; the thread was stopped and no success was emitted. */
export class FreebuffTurnTimeoutError extends Error {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(`FreeBuff turn timed out after ${timeoutMs}ms`)
    this.name = "FreebuffTurnTimeoutError"
    this.timeoutMs = timeoutMs
  }
}

type TurnState = "in-flight" | "done" | "failed"

interface TurnRecord {
  fingerprint: string
  state: TurnState
  result?: string
  updatedAt: number
}

interface ThreadRecord {
  threadId?: string
  creating?: Promise<string>
  updatedAt: number
}

interface CompletedTurn {
  result?: string
  bytes: number
  updatedAt: number
}

export type FreebuffDispatchAction =
  | { kind: "execute" }
  | { kind: "replay"; result: string }
  | { kind: "in-flight" }
  | { kind: "completed-unavailable" }

/**
 * Maps OpenCode conversations to FreeBuff threads (one thread per workspace +
 * session id) and tracks per-turn dispatch state so an exact transport replay
 * is idempotent while an intentional repeated prompt executes again. A failed
 * dispatch never poisons its retry: failure clears the record.
 */
export class FreebuffThreadRegistry {
  private readonly threadByKey = new Map<string, ThreadRecord>()
  private readonly turnByThread = new Map<string, TurnRecord>()
  private readonly completedByThread = new Map<string, Map<string, CompletedTurn>>()
  private completedBytes = 0

  constructor(
    private readonly maxThreads = 1000,
    private readonly ttlMs = 24 * 60 * 60 * 1000,
    private readonly maxCompletedResultBytes = 1024 * 1024,
    private readonly maxCompletedBytes = 16 * 1024 * 1024,
    private readonly maxCompletedRecordsPerThread = 512,
    private readonly maxCompletedResultsPerThread = 16,
  ) {}

  async getOrCreate(
    client: FreebuffClient,
    workspace: string,
    sessionId: string,
    model: string,
    messages: FreebuffOpenAiMessage[],
  ): Promise<{ threadId: string; action: FreebuffDispatchAction; fingerprint: string }> {
    const key = freebuffThreadKey(workspace, sessionId, model)
    const now = Date.now()
    this.prune(now)
    let thread = this.threadByKey.get(key)
    if (!thread) {
      if (!this.reserveCapacity()) {
        throw new Error("FreeBuff thread registry is at capacity with active turns")
      }
      thread = { updatedAt: now }
      this.threadByKey.set(key, thread)
      // FreeBuff 0.0.55 reasons per-thread. A KNOWN model declares its effort
      // range, so request its maximum so turns run at full reasoning instead
      // of the engine's medium default. An unknown live model has no declared
      // capability: omit reasoningEffort entirely and let FreeBuff choose its
      // own supported default rather than inventing one.
      const maxEffort = freebuffMaxReasoningEffort(model)
      const createThreadParams: Parameters<typeof client.createThread>[0] = {
        projectPath: workspace,
        harnessId: FREEBUFF_HARNESS_ID,
        model,
        executionMode: FREEBUFF_EXECUTION_MODE_LOCAL,
        // The first prompt is the thread TITLE only; it is never the identity.
        title: firstUserText(messages).slice(0, 80) || "FreeBuff conversation",
      }
      if (maxEffort !== undefined) createThreadParams.reasoningEffort = maxEffort
      thread.creating = client.createThread(createThreadParams)
        .then((created) => {
          thread!.threadId = created.id
          thread!.updatedAt = Date.now()
          return created.id
        })
        .catch((error) => {
          if (this.threadByKey.get(key) === thread) this.threadByKey.delete(key)
          throw error
        })
    }
    thread.updatedAt = now
    const threadId = thread.threadId ?? await thread.creating!

    const fingerprint = turnFingerprint(messages)
    const previous = this.turnByThread.get(threadId)
    const completed = this.completedByThread.get(threadId)?.get(fingerprint)
    let action: FreebuffDispatchAction
    if (previous?.state === "in-flight") {
      action = { kind: "in-flight" }
    } else if (completed) {
      completed.updatedAt = now
      action = completed.result === undefined
        ? { kind: "completed-unavailable" }
        : { kind: "replay", result: completed.result }
    } else {
      action = { kind: "execute" }
    }
    if (action.kind === "execute") {
      if ((this.completedByThread.get(threadId)?.size ?? 0) >= this.maxCompletedRecordsPerThread) {
        throw new Error("FreeBuff idempotency history is at capacity for this thread")
      }
      this.turnByThread.set(threadId, { fingerprint, state: "in-flight", updatedAt: now })
    }
    // Keep a newly-created thread protected from capacity eviction until its
    // first dispatch state is visible. Promise resolution and await resumption
    // are separate microtasks, so clearing this in createThread.then() leaves a
    // real eviction gap.
    thread.creating = undefined
    return { threadId, action, fingerprint }
  }

  /** Record a completed turn result so an exact replay returns the same text. */
  completeTurn(threadId: string, fingerprint: string, result: string): void {
    const record = this.turnByThread.get(threadId)
    if (record && record.fingerprint === fingerprint) {
      const now = Date.now()
      this.turnByThread.set(threadId, { fingerprint, state: "done", updatedAt: now })
      const bytes = Buffer.byteLength(result, "utf8")
      let completed = this.completedByThread.get(threadId)
      if (!completed) {
        completed = new Map()
        this.completedByThread.set(threadId, completed)
      }
      const previous = completed.get(fingerprint)
      if (previous) this.completedBytes -= previous.bytes
      const retainResult = bytes <= this.maxCompletedResultBytes && bytes <= this.maxCompletedBytes
      completed.set(fingerprint, {
        ...(retainResult ? { result } : {}),
        bytes: retainResult ? bytes : 0,
        updatedAt: now,
      })
      if (retainResult) this.completedBytes += bytes
      while ([...completed.values()].filter((entry) => entry.bytes > 0).length > this.maxCompletedResultsPerThread) {
        const oldestResult = [...completed.entries()].find(([, entry]) => entry.bytes > 0)
        if (!oldestResult) break
        this.completedBytes -= oldestResult[1].bytes
        oldestResult[1].bytes = 0
        delete oldestResult[1].result
      }
      this.enforceCompletedByteLimit()
    }
  }

  /** Clear a failed dispatch so a retry of the same request executes again. */
  failTurn(threadId: string, fingerprint: string): void {
    const record = this.turnByThread.get(threadId)
    if (record && record.fingerprint === fingerprint) {
      this.turnByThread.set(threadId, { fingerprint, state: "failed", updatedAt: Date.now() })
    }
  }

  private prune(now: number): void {
    for (const [key, record] of this.threadByKey) {
      if (
        !record.creating
        && (!record.threadId || this.turnByThread.get(record.threadId)?.state !== "in-flight")
        && now - record.updatedAt > this.ttlMs
      ) {
        this.threadByKey.delete(key)
        if (record.threadId) {
          this.turnByThread.delete(record.threadId)
          this.deleteCompletedThread(record.threadId)
        }
      }
    }
    for (const [threadId, record] of this.turnByThread) {
      if (record.state !== "in-flight" && now - record.updatedAt > this.ttlMs) {
        this.turnByThread.delete(threadId)
      }
    }
    for (const [threadId, completed] of this.completedByThread) {
      for (const [fingerprint, record] of completed) {
        if (now - record.updatedAt > this.ttlMs) this.deleteCompleted(threadId, fingerprint)
      }
    }
  }

  private reserveCapacity(): boolean {
    if (this.threadByKey.size < this.maxThreads) return true
    const oldest = [...this.threadByKey.entries()]
      .filter(([, record]) => !record.creating && (!record.threadId || this.turnByThread.get(record.threadId)?.state !== "in-flight"))
      .sort((left, right) => left[1].updatedAt - right[1].updatedAt)[0]
    if (!oldest) return false
    this.threadByKey.delete(oldest[0])
    if (oldest[1].threadId) {
      this.turnByThread.delete(oldest[1].threadId)
      this.deleteCompletedThread(oldest[1].threadId)
    }
    return true
  }

  private enforceCompletedByteLimit(): void {
    while (this.completedBytes > this.maxCompletedBytes) {
      let oldest: { threadId: string; fingerprint: string; updatedAt: number } | undefined
      for (const [threadId, completed] of this.completedByThread) {
        for (const [fingerprint, record] of completed) {
          if (record.bytes === 0) continue
          if (!oldest || record.updatedAt < oldest.updatedAt) oldest = { threadId, fingerprint, updatedAt: record.updatedAt }
        }
      }
      if (!oldest) break
      const record = this.completedByThread.get(oldest.threadId)?.get(oldest.fingerprint)
      if (!record) break
      this.completedBytes -= record.bytes
      record.bytes = 0
      delete record.result
    }
  }

  private deleteCompleted(threadId: string, fingerprint: string): void {
    const completed = this.completedByThread.get(threadId)
    const record = completed?.get(fingerprint)
    if (!completed || !record) return
    this.completedBytes -= record.bytes
    completed.delete(fingerprint)
    if (completed.size === 0) this.completedByThread.delete(threadId)
  }

  private deleteCompletedThread(threadId: string): void {
    const completed = this.completedByThread.get(threadId)
    if (!completed) return
    for (const record of completed.values()) this.completedBytes -= record.bytes
    this.completedByThread.delete(threadId)
  }
}

/** True when an engine error means the hosted-model slot is busy elsewhere. */
export function isFreebuffSessionLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /one tab at a time|another tab is using|tabs are in use|session_limit_reached/i.test(message)
}

/**
 * Compact, font-safe marker for an agent's internal activity so the process is
 * visible in the chat. Returns null for events that should not surface as steps
 * (token-level reasoning, plain text, tool results which are too verbose).
 */
export function stepMarker(event: { type?: string; toolName?: string; agentId?: string; agentType?: string; stage?: string; text?: string; input?: unknown }): string | null {
  switch (event.type) {
    case "status":
      return event.stage ? `> ${event.stage}` : null
    case "tool_call": {
      const name = event.toolName
      if (!name) return null
      const hint = toolInputHint(event.input)
      return hint ? `> tool: ${name} · ${hint}` : `> tool: ${name}`
    }
    case "subagent_start": {
      const label = event.agentType ?? event.agentId
      return label ? `> subagent: ${label}` : null
    }
    default:
      return null
  }
}

function stringOfAny(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/** Extract a short "what is it doing" hint from a tool call's input. */
export function toolInputHint(input: unknown): string | null {
  if (!input || typeof input !== "object") return null
  const record = input as Record<string, unknown>
  const file = stringOfAny(record.file_path) ?? stringOfAny(record.filePath) ?? stringOfAny(record.path)
  if (file) return truncate(file, 80)
  const command = stringOfAny(record.command)
  if (command) return truncate(command, 60)
  const target = stringOfAny(record.target) ?? stringOfAny(record.name)
  if (target) return truncate(target, 60)
  return null
}

export interface FreebuffTurnOptions {
  signal?: AbortSignal
  /** Hard bound on one agent turn; FreeBuff subagents can run long. */
  timeoutMs?: number
}

/**
 * Run one FreeBuff agent turn and stream the events it emits. `onText` carries
 * the agent's prose, `onStep` carries a compact marker for the agent's internal
 * activity (status stages, tool calls, subagents) so the process is visible in
 * the chat. Consecutive blocks are separated by a newline when the previous
 * block ended on a sentence/step boundary; mid-sentence token chunks are joined
 * as-is. Resolves with the full text once the thread returns to idle; rejects
 * on engine errors or when the caller aborts. A fresh engine subscription
 * replays the current thread state first, which provides the turnState baseline.
 */
export async function runFreebuffTurn(
  client: FreebuffClient,
  threadId: string,
  prompt: string,
  onText: (text: string) => void,
  options: FreebuffTurnOptions & { onStep?: (text: string) => void } = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 6 * 60 * 60 * 1000
  const abort = options.signal ?? new AbortController().signal

  return new Promise<string>((resolve, reject) => {
    let collected = ""
    let textSeen = false
    let runningSeen = false
    let settled = false
    let finishing = false
    let needsBreak = false
    let lastWasStep = false
    let unsubscribe: () => void = () => {}
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null
    let abortListener: () => void = () => {}
    const dispatchAbort = new AbortController()
    let dispatchStarted = false
    let dispatchSettled = false
    let resolveDispatchSettlement!: () => void
    const dispatchSettlement = new Promise<void>((resolveDispatch) => { resolveDispatchSettlement = resolveDispatch })
    const markDispatchSettled = () => {
      if (dispatchSettled) return
      dispatchSettled = true
      resolveDispatchSettlement()
    }

    // A newline is inserted before a block when the previous block ended at a
    // natural boundary (newline or sentence end) or when either block is an
    // agent step marker (each step is its own line). Token-level chunks that
    // end mid-sentence stay glued together.
    const appendBlock = (block: string, step = false): string => {
      const lastChar = collected[collected.length - 1]
      const boundaryBreak = lastChar !== undefined && /[\n.!?:]/.test(lastChar)
      const separator = needsBreak && (step || lastWasStep || boundaryBreak) ? "\n" : ""
      needsBreak = true
      lastWasStep = step
      collected += separator + block
      return separator + block
    }

    // `stopThread` runs at most once per turn (timeout or abort), never twice.
    let stopPromise: Promise<void> | undefined
    const stopThreadOnce = (): Promise<void> => {
      if (stopPromise) return stopPromise
      stopPromise = boundedStopThread(client, threadId)
      return stopPromise
    }

    // `finish` owns ALL settlement and cleanup exactly once: unsubscribe,
    // clear the timeout, remove the abort listener, then settle. An abort that
    // fires AFTER completion can therefore never stop a thread reused by a
    // later turn.
    const finish = (error?: unknown, stopThread = Boolean(error) && dispatchStarted) => {
      if (settled || finishing) return
      finishing = true
      unsubscribe()
      if (timeoutHandle) clearTimeout(timeoutHandle)
      abort.removeEventListener("abort", abortListener)
      if (error) dispatchAbort.abort()
      if (!dispatchStarted) markDispatchSettled()
      void (async () => {
        await dispatchSettlement
        if (stopThread) await stopThreadOnce()
        settled = true
        if (error) reject(error)
        else resolve(collected)
      })()
    }

    void client.subscribeEvents(
      (event) => {
        if (settled || finishing) return
        const thread = (event as { thread?: FreebuffThread }).thread
        if (event.type === "thread" && thread?.id === threadId) {
          if (thread.turnState === "running") runningSeen = true
          if (thread.turnState === "idle") {
            // Completion requires evidence the turn actually ran, so the idle
            // snapshot replayed on subscribe does not end the request early.
            if (runningSeen || textSeen) finish()
          }
          return
        }
        if (event.type === "agent" && "threadId" in event && event.threadId === threadId) {
          const agentEvent = (event as { event: { type?: string; text?: string; toolName?: string; agentId?: string; agentType?: string; stage?: string } }).event
          if (agentEvent.type === "text" && typeof agentEvent.text === "string" && agentEvent.text) {
            textSeen = true
            const delta = appendBlock(agentEvent.text)
            onText(delta)
            return
          }
          const step = stepMarker(agentEvent)
          if (step && options.onStep) {
            const delta = appendBlock(step, true)
            options.onStep(delta)
          }
        }
        if (event.type === "error") {
          const message = typeof event.message === "string" ? event.message : "FreeBuff agent error"
          finish(new Error(message))
        }
      },
      (error) => {
        if (error && !abort.aborted) finish(error)
        else if (!settled && !finishing) finish(new Error("FreeBuff event stream closed before the turn completed"))
      },
    ).then((unsub) => {
      unsubscribe = unsub
      if (settled || finishing) unsub()
    }).catch((error) => finish(error))

    timeoutHandle = setTimeout(() => {
      // A hard timeout is a FAILURE: stop the thread, reject the turn, never
      // resolve with the partial text as if the model completed.
      finish(new FreebuffTurnTimeoutError(timeoutMs), true)
    }, timeoutMs)
    if (timeoutHandle.unref) timeoutHandle.unref()

    abortListener = () => {
      if (settled || finishing) return
      finish(new Error("Request aborted"), true)
    }
    if (abort.aborted) {
      abortListener()
    } else {
      abort.addEventListener("abort", abortListener, { once: true })
    }

    void (async () => {
      try {
        // Let the subscription replay the initial thread snapshot so the
        // baseline turnState is known, then dispatch the prompt.
        await new Promise((resolveIdle) => setTimeout(resolveIdle, 200))
        if (settled || finishing) return
        dispatchStarted = true
        try {
          await client.postMessage(threadId, prompt, [], { signal: dispatchAbort.signal })
        } finally {
          markDispatchSettled()
        }
      } catch (error) {
        finish(error)
      }
    })()
  })
}

function boundedStopThread(client: FreebuffClient, threadId: string, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve) => {
    const abort = new AbortController()
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      abort.abort()
      finish()
    }, timeoutMs)
    if (timer.unref) timer.unref()
    try {
      client.stopThread(threadId, { signal: abort.signal }).then(finish, finish)
    } catch {
      finish()
    }
  })
}
