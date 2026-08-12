/**
 * Wire shapes of the FreeBuff desktop orchestrator API.
 *
 * The FreeBuff desktop is an Electron shell around a Bun-based agent engine
 * (orchestrator.js) that serves a local HTTP + SSE API. This module mirrors
 * only the parts SAIWORK needs: thread lifecycle, prompt dispatch, events and
 * the account quota surfaced by codebuff.com.
 *
 * Shapes are deliberately loose where the upstream engine is loosely typed;
 * the client only relies on fields SAIWORK consumes.
 */

export const FREEBUFF_HARNESS_ID = "codebuff"
export const FREEBUFF_EXECUTION_MODE_LOCAL = "local"
export const FREEBUFF_EXECUTION_MODE_WORKTREE = "worktree"

/** Free-tier access tier name returned by the session endpoint. */
export const FREEBUFF_TIER_LIMITED = "limited"

export type FreebuffExecutionMode = "local" | "worktree"
export type FreebuffReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra"

export interface FreebuffThread {
  id: string
  title?: string | null
  status: "open" | "closed"
  harnessId?: string | null
  model?: string | null
  reasoningEffort?: FreebuffReasoningEffort | null
  executionMode: FreebuffExecutionMode
  queuePaused: boolean
  turnState?: "idle" | "running" | string
  autoRun?: boolean
  createdAt?: number
  updatedAt?: number
  lastTurnOutcome?: string | null
  parts?: unknown[]
  [key: string]: unknown
}

export interface FreebuffQueueItem {
  id: string
  threadId: string
  text?: string
  label?: string | null
  status?: string
  createdAt?: number
  [key: string]: unknown
}

export interface FreebuffThreadEvent {
  type: "thread"
  threadId: string
  thread: FreebuffThread
  items: FreebuffQueueItem[]
}

/** Per-turn agent activity event emitted while a prompt runs. */
export type FreebuffAgentEvent =
  | { type: "text"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; toolName: string; input?: unknown; [key: string]: unknown }
  | { type: "tool_result"; toolName?: string; [key: string]: unknown }
  | { type: "status"; stage: string; [key: string]: unknown }
  | { type: "subagent_start"; agentId?: string; agentType?: string; [key: string]: unknown }
  | { type: "error"; message: string; [key: string]: unknown }
  | { [key: string]: unknown }

export interface FreebuffAgentEventEnvelope {
  type: "agent"
  threadId: string
  seq: number
  event: FreebuffAgentEvent
}

export interface FreebuffPromptEvent {
  type: "prompt"
  threadId: string
  text: string
  attachments?: string[]
}

export interface FreebuffStateEvent {
  type: "state"
  snapshot: unknown
}

export type FreebuffBusEvent =
  | FreebuffThreadEvent
  | FreebuffAgentEventEnvelope
  | FreebuffPromptEvent
  | FreebuffStateEvent
  | { type: "auth"; authed: boolean; user?: unknown }
  | { type: "reachability"; online: boolean }
  | { type: "login-state"; [key: string]: unknown }
  | { type: "elevation_request"; request: unknown }
  | { type: "elevation_resolved"; requestId: string }
  | { type: string; [key: string]: unknown }

/** Read-only quota snapshot from codebuff.com/api/v1/freebuff/session. */
export interface FreebuffRateLimit {
  model: string
  limit: number
  period: "pacific_day" | "pacific_week" | string
  resetTimeZone?: string
  resetAt?: string
  windowHours?: number
  recentCount: number
  entitlementBreakdown?: {
    base?: number
    referral?: number
    streak?: number
  }
}

export interface FreebuffSessionSnapshot {
  status: string
  accessTier: string
  rateLimitsByModel?: Record<string, FreebuffRateLimit>
  desktopSessionCounts?: {
    premium: number
    unlimited: number
    nextExpiryAt?: string
  }
}

export interface FreebuffUser {
  id: string
  email?: string
  name?: string
}

export interface FreebuffAuthState {
  token: string
  user: FreebuffUser | null
}

export interface FreebuffModelInfo {
  id: string
  displayName: string
  tagline?: string
  free: boolean
  isNew?: boolean
  contextWindow?: number
  /** The reasoning effort SAIWORK requests for this model (always the max). */
  reasoningEffort?: FreebuffReasoningEffort
  /** The full effort range the engine honors for this model, low..high. */
  efforts?: FreebuffReasoningEffort[]
  /** The engine's own default when no effort is requested. */
  defaultEffort?: FreebuffReasoningEffort
}

/** Minimal thread snapshot the orchestrator returns after POST /api/threads. */
export interface CreateThreadResult {
  id: string
  [key: string]: unknown
}
