import { createHash } from "node:crypto"

import { createFreebuffClient, type FreebuffClient } from "./client"
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
 * Sessions map to threads: one thread per (workspace, first user message),
 * derived from the first message OpenCode sends each turn (OpenCode replays
 * the full history, so the session key is stable across turns).
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

/** The text of the first user message: the session identity for a thread. */
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

/** Stable per-session thread key: workspace + the conversation's opening line. */
export function freebuffThreadKey(workspace: string, firstMessage: string): string {
  return createHash("sha1").update(`${workspace}\u0000${firstMessage}`).digest("hex").slice(0, 16)
}

/**
 * Maps OpenCode conversations to FreeBuff threads. One thread per key; also
 * remembers the last prompt sent to a thread so an OpenCode retry/re-send of
 * the same message is not posted to the engine twice.
 */
export class FreebuffThreadRegistry {
  private readonly threadByKey = new Map<string, string>()
  private readonly lastPromptByThread = new Map<string, string>()

  async getOrCreate(
    client: FreebuffClient,
    workspace: string,
    model: string,
    firstMessage: string,
    newPrompt: string,
  ): Promise<{ threadId: string; skip: boolean }> {
    const key = freebuffThreadKey(workspace, firstMessage)
    let threadId = this.threadByKey.get(key)
    if (!threadId) {
      const created = await client.createThread({
        projectPath: workspace,
        harnessId: FREEBUFF_HARNESS_ID,
        model,
        executionMode: FREEBUFF_EXECUTION_MODE_LOCAL,
        title: firstMessage.slice(0, 80),
      })
      threadId = created.id
      this.threadByKey.set(key, threadId)
    }
    const lastPrompt = this.lastPromptByThread.get(threadId)
    const skip = lastPrompt !== undefined && lastPrompt === newPrompt
    this.lastPromptByThread.set(threadId, newPrompt)
    return { threadId, skip }
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
    let needsBreak = false
    let lastWasStep = false
    let unsubscribe: () => void = () => {}
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null

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

    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      unsubscribe()
      if (timeoutHandle) clearTimeout(timeoutHandle)
      if (error) reject(error)
      else resolve(collected)
    }

    void client.subscribeEvents(
      (event) => {
        if (settled) return
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
        else if (!settled) finish()
      },
    ).then((unsub) => {
      unsubscribe = unsub
      if (settled) unsub()
    })

    timeoutHandle = setTimeout(() => {
      finish()
    }, timeoutMs)
    if (timeoutHandle.unref) timeoutHandle.unref()

    const abortListener = () => {
      void client.stopThread(threadId).catch(() => {
        // The thread may already be idle; stopping is best-effort.
      })
      finish(new Error("Request aborted"))
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
        if (settled) return
        await client.postMessage(threadId, prompt)
      } catch (error) {
        finish(error)
      }
    })()
  })
}
