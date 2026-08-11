import type {
  AgentModelSelection,
  AgentModelSelections,
  ModelPreference,
  OpenCodeBinary,
  Preferences,
  RecentFolder,
} from "./config/schema"

/**
 * Canonical HTTP/SSE contract for the CLI server.
 * These types are consumed by both the CLI implementation and any UI clients.
 */

export type WorkspaceStatus = "starting" | "ready" | "stopped" | "error"

export interface WorkspaceDescriptor {
  id: string
  /** Correlates creation events with the client request that initiated them. */
  requestId?: string
  /** Absolute path on the server host. */
  path: string
  name?: string
  status: WorkspaceStatus
  /** PID/port are populated when the workspace is running. */
  pid?: number
  port?: number
  /** Canonical proxy path the CLI exposes for this instance. */
  proxyPath: string
  /** Identifier of the binary resolved from config. */
  binaryId: string
  binaryLabel: string
  binaryVersion?: string
  createdAt: string
  updatedAt: string
  /** Present when `status` is "error". */
  error?: string
}

export interface WorkspaceCreateRequest {
  path: string
  name?: string
  binaryPath?: string
  requestId?: string
  forceNew?: boolean
}

export interface WorkspaceCloneRequest {
  repositoryUrl: string
  destinationPath: string
  cleanup?: boolean
}

export interface WorkspaceCloneResponse {
  path: string
}

export type WorkspaceCreateResponse = WorkspaceDescriptor & {
  /** True when an active workspace with the same canonical path was returned. */
  reused?: true
}
export type WorkspaceListResponse = WorkspaceDescriptor[]
export type WorkspaceDetailResponse = WorkspaceDescriptor

export interface WorkspaceDeleteResponse {
  id: string
  status: WorkspaceStatus
}

export interface ProviderUsageWindow {
  usedPercent: number | null
  remainingPercent: number | null
  windowSeconds: number | null
  resetAt: number | null
  valueLabel?: string
}

export interface ProviderUsageResponse {
  requestedProviderId: string
  providerId: string | null
  providerName: string
  modelId?: string
  supported: boolean
  configured: boolean
  ok: boolean
  windows: Record<string, ProviderUsageWindow>
  fetchedAt: number
}

export type WorktreeKind = "root" | "worktree"

export interface WorktreeDescriptor {
  /** Stable identifier used by SaiWork + clients ("root" for the selected workspace folder). */
  slug: string
  /** Absolute directory path on the server host. */
  directory: string
  kind: WorktreeKind
  /** Optional VCS branch name when available. */
  branch?: string
}

export interface WorktreeListResponse {
  worktrees: WorktreeDescriptor[]
  /** True when the workspace folder resolves to a Git repository. */
  isGitRepo?: boolean
}

export interface WorktreeCreateRequest {
  slug: string
  /** Optional branch name (defaults to slug). */
  branch?: string
}

export interface WorktreeMap {
  version: 1
  /** Default worktree to use for new sessions and as fallback. */
  defaultWorktreeSlug: string
  /** Mapping of *parent* session IDs to a worktree slug. */
  parentSessionWorktreeSlug: Record<string, string>
}

export type GitChangeKind = "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked" | "unmerged"

export interface WorktreeGitStatusEntry {
  path: string
  originalPath?: string | null
  stagedStatus: GitChangeKind | null
  stagedAdditions: number
  stagedDeletions: number
  unstagedStatus: GitChangeKind | null
  unstagedAdditions: number
  unstagedDeletions: number
}

export type WorktreeGitStatusResponse = WorktreeGitStatusEntry[]

export type WorktreeGitDiffScope = "staged" | "unstaged"

export interface WorktreeGitPathsRequest {
  paths: string[]
}

export interface WorktreeGitMutationResponse {
  ok: true
}

export interface WorktreeGitCommitRequest {
  message: string
}

export interface WorktreeGitCommitResponse {
  ok: true
  commitSha?: string
}

export interface WorktreeGitDiffResponse {
  path: string
  originalPath?: string | null
  scope: WorktreeGitDiffScope
  before: string
  after: string
  isBinary?: boolean
}

export interface WorktreeGitDiffRequest {
  path: string
  originalPath?: string | null
  scope: WorktreeGitDiffScope
}

export type LogLevel = "debug" | "info" | "warn" | "error"

export interface WorkspaceLogEntry {
  workspaceId: string
  timestamp: string
  level: LogLevel
  message: string
}

export interface FileSystemEntry {
  name: string
  /**
   * Path identifier for the entry. Relative to the server root in restricted
   * single-root listings ("." represents the root itself); absolute in
   * unrestricted, drives, and multi-root top-level listings.
   */
  path: string
  /** Absolute path when available (unrestricted and multi-root listings). */
  absolutePath?: string
  type: "file" | "directory"
  size?: number
  /** ISO timestamp of last modification when available. */
  modifiedAt?: string
}

export type FileSystemScope = "restricted" | "unrestricted"
export type FileSystemPathKind = "relative" | "absolute" | "drives"

export interface FileSystemListingMetadata {
  scope: FileSystemScope
  /**
   * Canonical identifier of the current view:
   * - "." for restricted single-root listings
   * - WINDOWS_DRIVES_ROOT for the Windows drives pseudo-root
   * - absolute path otherwise
   */
  currentPath: string
  /** Optional parent path if navigation upward is allowed. */
  parentPath?: string
  /** Absolute path representing the root or origin point for this listing. */
  rootPath: string
  /** Absolute home directory of the CLI host (useful defaults for unrestricted mode). */
  homePath: string
  /** Human-friendly label for the current path. */
  displayPath: string
  /** Indicates whether entry paths are relative, absolute, or represent the drive pseudo-view. */
  pathKind: FileSystemPathKind
}

export interface FileSystemListResponse {
  entries: FileSystemEntry[]
  metadata: FileSystemListingMetadata
}

export interface FileSystemCreateFolderRequest {
  /**
   * Path identifier for the currently browsed directory.
   * Matches the `path` parameter used for `/api/filesystem`.
   */
  parentPath?: string
  /** Single folder name (no separators). */
  name: string
}

export interface FileSystemCreateFolderResponse {
  /**
   * Path identifier that can be passed back to `/api/filesystem` to browse the new folder.
   * Relative for restricted listings and absolute for unrestricted listings.
   */
  path: string
  /** Absolute folder path on the server host. */
  absolutePath: string
}

export interface FileSystemFileContentResponse {
  path: string
  contents: string
  encoding: "utf-8" | "base64"
}

export interface ConfigFileDescriptor {
  id: string
  label: string
  path: string
  language: string
}

export type ConfigFileListResponse = ConfigFileDescriptor[]

export interface ConfigFileContentResponse {
  id: string
  path: string
  contents: string
  exists: boolean
}

export interface ConfigFileContentRequest {
  contents: string
}

export const WINDOWS_DRIVES_ROOT = "__drives__"

export interface WorkspaceFileResponse {
  workspaceId: string
  relativePath: string
  /** UTF-8 file contents; binary files should be base64 encoded by the caller. */
  contents: string
  encoding?: "utf-8" | "base64"
}

export type WorkspaceFileSearchResponse = FileSystemEntry[]

export interface InstanceData {
  messageHistory: string[]
  agentModelSelections: AgentModelSelection
}

export type InstanceStreamStatus = "connecting" | "connected" | "error" | "disconnected"

export interface InstanceStreamEvent {
  type: string
  properties?: Record<string, unknown>
  [key: string]: unknown
}

export type SideCarKind = "port"

export type SideCarPrefixMode = "strip" | "preserve"

export type SideCarStatus = "running" | "stopped"

export interface SideCar {
  id: string
  kind: SideCarKind
  name: string
  port: number
  insecure: boolean
  prefixMode: SideCarPrefixMode
  status: SideCarStatus
  createdAt: string
  updatedAt: string
}

export interface PreviewSession {
  token: string
  sessionId: string
  targetUrl: string
  proxyUrl: string
  createdAt: string
}

export interface BinaryRecord {
  id: string
  path: string
  label: string
  version?: string

  /** Indicates that this binary will be picked when workspaces omit an explicit choice. */
  isDefault: boolean
  lastValidatedAt?: string
  validationError?: string
}

export type SettingsOwner = string
export type SettingsBucket = Record<string, unknown>
export type SettingsDoc = Record<string, unknown>

export interface BinaryListResponse {
  binaries: BinaryRecord[]
}

export interface BinaryCreateRequest {
  path: string
  label?: string
  makeDefault?: boolean
}

export interface BinaryUpdateRequest {
  label?: string
  makeDefault?: boolean
}

export interface BinaryValidationResult {
  valid: boolean
  version?: string
  error?: string
}

export interface OpenCodeUpdateStatus {
  currentVersion: string
  latestVersion: string | null
  updateAvailable: boolean | null
  canUpgrade: boolean
  checkError?: "update_check_failed"
}

export interface OpenCodeUpdateResponse {
  success: boolean
  version: string
}

export interface SpeechSegment {
  startMs: number
  endMs: number
  text: string
}

export interface SpeechCapabilitiesResponse {
  available: boolean
  configured: boolean
  provider: string
  supportsStt: boolean
  supportsTts: boolean
  supportsStreamingTts: boolean
  baseUrl?: string
  sttModel: string
  ttsModel: string
  ttsVoice: string
  ttsFormats: string[]
  streamingTtsFormats: string[]
  separateProviders?: boolean
  sttConfigured?: boolean
  ttsConfigured?: boolean
  sttBaseUrl?: string
  ttsBaseUrl?: string
}

export interface SpeechTranscriptionResponse {
  text: string
  language?: string
  durationMs?: number
  segments?: SpeechSegment[]
}

export interface SpeechSynthesisResponse {
  audioBase64: string
  mimeType: string
}

export interface VoiceModeStateResponse {
  enabled: boolean
}

export interface YoloStateResponse {
  enabled: boolean
}

export interface SessionMetadataResponse {
  metadata: Record<string, unknown>
}

export interface RemoteServerProfile {
  id: string
  name: string
  baseUrl: string
  skipTlsVerify: boolean
  createdAt: string
  updatedAt: string
  lastConnectedAt?: string
}

export interface RemoteServerProbeRequest {
  baseUrl: string
  skipTlsVerify?: boolean
}

export interface RemoteServerProbeResponse {
  ok: boolean
  reachable: boolean
  normalizedUrl: string
  skipTlsVerify: boolean
  requiresAuth: boolean
  authenticated: boolean
  error?: string
  errorCode?: string
}

export interface RemoteProxySessionCreateRequest {
  baseUrl: string
  skipTlsVerify?: boolean
}

export interface RemoteProxySessionCreateResponse {
  sessionId: string
  windowUrl: string
}

export type WorkspaceEventType =
  | "workspace.created"
  | "workspace.started"
  | "workspace.error"
  | "workspace.stopped"
  | "workspace.log"
  | "sidecar.updated"
  | "sidecar.removed"
  | "storage.configChanged"
  | "storage.stateChanged"
  | "instance.dataChanged"
  | "instance.event"
  | "instance.eventStatus"
  | "saipen.changed"
  | "queue.changed"
  | "yolo.stateChanged"
  | "yolo.autoAccepted"

export type WorkspaceEventPayload =
  | { type: "workspace.created"; workspace: WorkspaceDescriptor }
  | { type: "workspace.started"; workspace: WorkspaceDescriptor }
  | { type: "workspace.error"; workspace: WorkspaceDescriptor }
  | { type: "workspace.stopped"; workspaceId: string; reason?: "deleted" | "stopped" }
  | { type: "workspace.log"; entry: WorkspaceLogEntry }
  | { type: "sidecar.updated"; sidecar: SideCar }
  | { type: "sidecar.removed"; sidecarId: string }
  | { type: "storage.configChanged"; owner: SettingsOwner; value: SettingsBucket }
  | { type: "storage.stateChanged"; owner: SettingsOwner; value: SettingsBucket }
  | { type: "instance.dataChanged"; instanceId: string; data: InstanceData }
  | { type: "instance.event"; instanceId: string; event: InstanceStreamEvent }
  | { type: "instance.eventStatus"; instanceId: string; status: InstanceStreamStatus; reason?: string }
  | {
      type: "saipen.changed"
      /** Canonical workspace folder the `.saipen` files belong to. */
      folder: string
      /** Relative `.saipen` paths that changed, e.g. "STATE.md" or "kitchen/plan-a.md". */
      files: string[]
    }
  | {
      type: "queue.changed"
      /** `<instanceId>:<sessionId>` key of the mutated queue. */
      key: string
      /** Full authoritative queue state after the mutation. */
      state: QueueState
    }
  | { type: "yolo.stateChanged"; instanceId: string; sessionId: string; enabled: boolean }
  | { type: "yolo.autoAccepted"; instanceId: string; sessionId: string; permissionId: string }

export interface NetworkAddress {
  ip: string
  family: "ipv4" | "ipv6"
  scope: "external" | "internal" | "loopback"
  /** Remote URL using the server's remote protocol/port for this IP. */
  remoteUrl: string
}

export interface LatestReleaseInfo {
  version: string
  tag: string
  url: string
  channel: "stable" | "dev"
  publishedAt?: string
  notes?: string
}

export interface UiMeta {
  version?: string
  source: "bundled" | "downloaded" | "previous" | "override" | "dev-proxy" | "missing"
}

export interface SupportMeta {
  supported: boolean
  message?: string
  minServerVersion?: string
  latestServerVersion?: string
  latestServerUrl?: string
}

export interface ServerMeta {
  /** URL desktop apps should use to connect (prefers loopback HTTP when enabled). */
  localUrl: string
  /** URL remote clients should use (prefers HTTPS when enabled). */
  remoteUrl?: string
  /** SSE endpoint advertised to clients (`/api/events` by default). */
  eventsUrl: string
  /** Host the server is bound to (e.g., 127.0.0.1 or 0.0.0.0). */
  host: string
  /** Listening mode derived from host binding. */
  listeningMode: "local" | "all"
  /** Actual local port in use after binding. */
  localPort: number
  /** Actual remote port in use after binding (when remoteUrl is set). */
  remotePort?: number
  /** Display label for the host (e.g., hostname or friendly name). */
  hostLabel: string
  /** Absolute path of the filesystem root exposed to clients. */
  workspaceRoot: string
  /** Reachable addresses for this server, external first. */
  addresses: NetworkAddress[]
  serverVersion?: string
  ui?: UiMeta
  support?: SupportMeta
  /** Optional update info (dev channel only). */
  update?: LatestReleaseInfo | null
}

export type BackgroundProcessStatus = "running" | "stopped" | "error"

export type BackgroundProcessTerminalReason = "finished" | "failed" | "user_stopped" | "user_terminated"

export interface BackgroundProcess {
  id: string
  workspaceId: string
  title: string
  command: string
  cwd: string
  status: BackgroundProcessStatus
  pid?: number
  startedAt: string
  stoppedAt?: string
  exitCode?: number
  outputSizeBytes?: number
  terminalReason?: BackgroundProcessTerminalReason
  notifyEnabled?: boolean
}

export interface BackgroundProcessListResponse {
  processes: BackgroundProcess[]
}

export interface BackgroundProcessOutputResponse {
  id: string
  content: string
  truncated: boolean
  sizeBytes: number
}

export interface SaipenSubState {
  name: string
  phase: string | null
  task: string | null
  agent: string | null
  updated: string | null
  nextAction: string | null
  lifecycle: SaipenSubLifecycle
  packageStatus: SaipenSubPackageStatus
  packageCounts: SaipenSubPackageCounts
  issues: string[]
}

export type SaipenSubLifecycle = "active" | "blocked" | "done" | "missing" | "malformed"
export type SaipenSubPackageStatus =
  | "none"
  | "ready"
  | "draft"
  | "blocked"
  | "reviewed"
  | "stale"
  | "missing"
  | "malformed"

export interface SaipenSubPackageCounts {
  ready: number
  draft: number
  blocked: number
  reviewed: number
  stale: number
}

export interface SaipenProjectState {
  phase: string | null
  nextAction: string | null
  todoCount: number
  doingCount: number
  blockedCount: number
}

/**
 * What a running workspace launched with, as opposed to what the settings say
 * a new one would get. Null when nothing is running for that folder.
 */
export interface SaipenEffectiveState {
  enabled: boolean
  protocolDir: string | null
  instructions: string[]
  launchedAt: number
}

export interface SaipenStatusResponse {
  enabled: boolean
  home: string | null
  protocolDir: string | null
  instructions: string[]
  missing: string[]
  error: string | null
  project: SaipenProjectState | null
  subs: SaipenSubState[]
  /** What the running workspace launched with; null when none is running. */
  effective: SaipenEffectiveState | null
  /** True when the settings no longer match what is running. */
  restartRequired: boolean
}

/** A `.saipen/kitchen/*.md` plan file, content capped for the panel. */
export interface SaipenPlanFile {
  name: string
  content: string
}

export type SaipenBoardTicketStatus = "todo" | "doing" | "done" | "blocked"

export interface SaipenBoardTicket {
  id: string
  status: SaipenBoardTicketStatus
  text: string
}

export interface SaipenBoardSection {
  title: string
  tickets: SaipenBoardTicket[]
}

/** One entry in the shared prompt queue. */
export interface QueuedPrompt {
  id: string
  text: string
  /** Opaque attachment payloads; the server stores and returns them verbatim. */
  attachments: unknown[]
  createdAt: number
}

/** Cap on the serialized attachments of a single queued prompt. */
export const MAX_QUEUED_ATTACHMENT_BYTES = 512 * 1024

/** Authoritative state of one `<instanceId>:<sessionId>` queue. */
export interface QueueState {
  items: QueuedPrompt[]
  paused: boolean
  /** SHA-256 of the serialized items+paused; the CAS guard for mutations. */
  revision: string
}

export interface QueueListResponse {
  queues: Record<string, QueueState>
}


/** Raw `.saipen` files for the SAIPENVIEW panel. */
export interface SaipenViewResponse {
  /** STATE.md frontmatter text, or null when absent. */
  state: string | null
  /** BOARD.md full text, or null when absent. */
  board: string | null
  /** BOARD.md parsed into canonical sections (section-aware status). */
  boardSections: SaipenBoardSection[]
  /** LOG.md tail (capped), or null when absent. */
  log: string | null
  /** True when the LOG tail was truncated. */
  logTruncated: boolean
  /** Kitchen plan files, newest first, content capped per file. */
  plans: SaipenPlanFile[]
  /** SHA-256 of each editable `.saipen` file, keyed by relative path. */
  revisions: Record<string, string>
  /** True when the folder has no `.saipen` directory at all. */
  missing: boolean
}

export type {
  Preferences,
  ModelPreference,
  AgentModelSelections,
  RecentFolder,
  OpenCodeBinary,
}
