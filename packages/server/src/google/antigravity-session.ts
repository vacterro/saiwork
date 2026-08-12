import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"

/**
 * Antigravity (Google AI Pro) session + cloudcode-pa client.
 *
 * The Antigravity subscription is not the Gemini Developer API. It is served
 * by Google's internal code-assistant backend (daily-cloudcode-pa.googleapis.com)
 * and authenticates with an OAuth access token scoped to that service. SAIWORK
 * only ever needs the durable pieces a Google sign-in leaves on disk:
 *
 *   - a refresh token (long-lived) persisted by the Antigravity app inside
 *     `%APPDATA%\Antigravity\User\globalStorage\state.vscdb`;
 *   - the OAuth client id/secret the app itself uses (embedded in its
 *     language server; overridable via ANTIGRAVITY_OAUTH_CLIENT_ID/SECRET).
 *
 * From those two the module mints fresh access tokens on demand, so the
 * subscription keeps working even when the Antigravity app is not running.
 * Access tokens are held in memory and never persisted or logged.
 */

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token"
const CLOUDCODE_PA_BASE = "https://daily-cloudcode-pa.googleapis.com/v1internal"
const DEFAULT_PROJECT_ID = "rising-fact-p41fc"
const USER_AGENT = "antigravity/1.11.5 windows/amd64"
const API_CLIENT_HEADER = "google-cloud-sdk vscode_cloudshelleditor/0.1"

// The Google OAuth client id the Antigravity app ships is public (client ids
// are not secrets) and is the known-working one. The client SECRET is never
// committed to this repo: it is discovered at runtime from the Antigravity
// language server binary (where the app keeps it) and cached for the process
// lifetime. Override both via env to stay ahead of rotation.
const DEFAULT_OAUTH_CLIENT_ID =
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"

// Google OAuth client secrets are exactly 28 chars after the GOCSPX- prefix.
// Two secrets can sit back-to-back in the binary with no separator, so a plain
// {28} quantifier (no lookahead) is what splits them correctly.
const OAuthClientSecretRe = /GOCSPX-[A-Za-z0-9_-]{28}/g

const ANTIGRAVITY_BINARY_CANDIDATES = (): string[] => {
  const home = os.homedir()
  const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local")
  return [
    path.join(localAppData, "Programs", "Antigravity", "resources", "bin", "language_server.exe"),
    path.join(localAppData, "Antigravity", "resources", "bin", "language_server.exe"),
  ]
}

let discoveredSecrets: { from: string; secrets: string[] } | null = null

/**
 * Find the Antigravity OAuth client secrets inside its language server binary.
 * The secrets sit as `GOCSPX-...` strings (28 chars); the binary is large, so
 * it is streamed in chunks with a small overlap. Results are cached per binary
 * identity (path + mtime + size) for the process lifetime.
 */
export function discoverAntigravityOAuthSecrets(): string[] {
  const envSecret = stringOf(process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET)
  if (envSecret) return [envSecret]
  const candidates = ANTIGRAVITY_BINARY_CANDIDATES()
  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate)
      if (!stat.isFile()) continue
      const identity = `${candidate}:${stat.mtimeMs}:${stat.size}`
      if (discoveredSecrets?.from === identity) return discoveredSecrets.secrets
      const secrets = scanBinaryForSecrets(candidate)
      discoveredSecrets = { from: identity, secrets }
      if (secrets.length > 0) return secrets
    } catch {
      // Try the next candidate path.
    }
  }
  return []
}

function scanBinaryForSecrets(filePath: string): string[] {
  const CHUNK = 1 << 20 // 1 MiB
  const OVERLAP = 128
  const out: string[] = []
  const fd = fs.openSync(filePath, "r")
  let buffer = ""
  try {
    const stat = fs.fstatSync(fd)
    let position = 0
    while (position < stat.size) {
      const size = Math.min(CHUNK, stat.size - position)
      const chunk = Buffer.alloc(size)
      fs.readSync(fd, chunk, 0, size, position)
      position += size
      buffer += chunk.toString("latin1")
      for (const match of buffer.matchAll(OAuthClientSecretRe)) {
        if (!out.includes(match[0])) out.push(match[0])
        if (out.length >= 8) return out
      }
      buffer = buffer.slice(-OVERLAP)
    }
  } finally {
    fs.closeSync(fd)
  }
  return out
}

const STATE_DB_KEY = "jetskiStateSync.agentManagerInitState"
const REQUEST_TIMEOUT_MS = 60_000
const TOKEN_REFRESH_LEAD_MS = 60_000

// node:sqlite is optional (Node >= 22.13); load lazily so runtimes without it
// degrade to the JSON credential stores instead of crashing the module.
const nodeRequire = createRequire(import.meta.url)

function loadDatabaseSync(): typeof import("node:sqlite").DatabaseSync | null {
  try {
    return nodeRequire("node:sqlite").DatabaseSync as typeof import("node:sqlite").DatabaseSync
  } catch {
    return null
  }
}

interface StoredTokens {
  accessToken?: string
  refreshToken?: string
}

interface TokenPair {
  accessToken: string
  expiresAt: number
}

interface GenerateOptions {
  /** Opaque conversation/session id echoed by the backend, if any. */
  sessionId?: string
  contents: Array<Record<string, unknown>>
  systemInstruction?: { parts: Array<{ text: string }> }
  tools?: Array<Record<string, unknown>>
  generationConfig?: Record<string, unknown>
  /** Abort the upstream call when the client disconnects. */
  signal?: AbortSignal
}

export interface AntigravityModelInfo {
  id: string
  displayName: string
  maxTokens: number | null
  maxOutputTokens: number | null
  /** Subscription quota info when the backend provides it. */
  quota?: { remainingFraction: number | null; resetTime: string | null }
}

interface OAuthClientCredentials {
  clientId: string
  /** Candidate secrets, tried in order on refresh (env first, then binary). */
  clientSecrets: string[]
}

export function antigravityStateDbPath(home = os.homedir()): string {
  const appData = process.env.APPDATA
  if (appData) return path.join(appData, "Antigravity", "User", "globalStorage", "state.vscdb")
  // Non-Windows fallback: the app also mirrors the session into ~/.gemini.
  return path.join(home, ".gemini", "antigravity", "state.vscdb")
}

/** Read a single value out of the Antigravity state DB (SQLite). */
export function readStateDbValue(dbPath: string, key: string): string | null {
  const DatabaseSync = loadDatabaseSync()
  if (!DatabaseSync) return null

  const readFrom = (candidate: string): string | null => {
    try {
      const db = new DatabaseSync(candidate, { readOnly: true })
      try {
        const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(key) as
          | { value: unknown }
          | undefined
        return typeof row?.value === "string" ? row.value : null
      } finally {
        db.close()
      }
    } catch {
      return null
    }
  }

  const direct = readFrom(dbPath)
  if (direct !== null) return direct

  // The app may hold an exclusive lock; read a snapshot instead.
  const tmpPath = path.join(os.tmpdir(), `saiwork-antigravity-${process.pid}.vscdb`)
  try {
    fs.copyFileSync(dbPath, tmpPath)
    try {
      return readFrom(tmpPath)
    } finally {
      fs.rmSync(tmpPath, { force: true })
    }
  } catch {
    return null
  }
}

/** Extract OAuth tokens from the base64 state blob the app persists. */
export function extractTokensFromStateValue(value: string): StoredTokens {
  let decoded: string
  try {
    decoded = Buffer.from(value, "base64").toString("latin1")
  } catch {
    return {}
  }
  const accessMatch = /ya29\.[A-Za-z0-9_-]+/.exec(decoded)
  const refreshMatch = /1\/\/[A-Za-z0-9_-]+/.exec(decoded)
  return {
    ...(accessMatch ? { accessToken: accessMatch[0] } : {}),
    ...(refreshMatch ? { refreshToken: refreshMatch[0] } : {}),
  }
}

function readJson(filePath: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"))
  } catch {
    return null
  }
}

function pickAccount(file: unknown): Record<string, unknown> | null {
  if (!file || typeof file !== "object" || Array.isArray(file)) return null
  const value = file as Record<string, unknown>
  const active = value.active && typeof value.active === "object"
    ? (value.active as Record<string, unknown>)
    : null
  if (active) return active
  const accounts = Array.isArray(value.accounts)
    ? (value.accounts as Array<Record<string, unknown>>)
    : []
  return accounts[0] ?? null
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function tokenPairOf(account: Record<string, unknown>): StoredTokens {
  return {
    ...(stringOf(account.accessToken) || stringOf(account.access_token)
      ? { accessToken: stringOf(account.accessToken) ?? stringOf(account.access_token) ?? undefined }
      : {}),
    ...(stringOf(account.refreshToken) || stringOf(account.refresh_token)
      ? { refreshToken: stringOf(account.refreshToken) ?? stringOf(account.refresh_token) ?? undefined }
      : {}),
  }
}

/**
 * Collect stored tokens from every source that can carry an Antigravity
 * session: the app's own state DB first, then the OpenCode antigravity
 * adapter account files and the ~/.gemini store. The state DB value is a
 * protobuf blob, so it is the least convenient source; the two JSON stores
 * take priority for a clean token shape.
 */
export function readStoredTokens(overrides: { stateDbPath?: string } = {}): StoredTokens {
  const home = os.homedir()
  const sources: StoredTokens[] = []

  const accountFiles = [
    path.join(home, ".config", "opencode", "antigravity-accounts.json"),
    path.join(home, ".local", "share", "opencode", "antigravity-accounts.json"),
    path.join(home, ".gemini", "google_accounts.json"),
  ]
  for (const candidate of accountFiles) {
    const data = readJson(candidate)
    if (!data || typeof data !== "object") continue
    const account = pickAccount(data)
    if (account) sources.push(tokenPairOf(account))
  }

  const stateDbPath = overrides.stateDbPath ?? antigravityStateDbPath()
  const stateValue = readStateDbValue(stateDbPath, STATE_DB_KEY)
  if (stateValue) sources.push(extractTokensFromStateValue(stateValue))

  for (const source of sources) {
    if (source.refreshToken) return source
  }
  // No durable refresh token anywhere: fall back to the freshest access token.
  for (const source of sources) {
    if (source.accessToken) return source
  }
  return {}
}

function oauthClientCredentials(env: NodeJS.ProcessEnv = process.env): OAuthClientCredentials {
  const envSecrets = stringOf(env.ANTIGRAVITY_OAUTH_CLIENT_SECRET)
  return {
    clientId: stringOf(env.ANTIGRAVITY_OAUTH_CLIENT_ID) ?? DEFAULT_OAUTH_CLIENT_ID,
    clientSecrets: envSecrets
      ? [envSecrets]
      : (discoverAntigravityOAuthSecrets().length > 0
          ? discoverAntigravityOAuthSecrets()
          : []),
  }
}

async function postForm(
  url: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok) {
    const reason = stringOf(body.error_description) ?? stringOf(body.error) ?? `HTTP ${response.status}`
    throw new Error(`Antigravity OAuth refresh failed: ${reason}`)
  }
  return body
}

/** Exchange a refresh token for a fresh access token via Google OAuth. */
export async function refreshAccessToken(
  refreshToken: string,
  creds: OAuthClientCredentials = oauthClientCredentials(),
): Promise<TokenPair> {
  if (creds.clientSecrets.length === 0) {
    throw new Error(
      "Antigravity OAuth client secret not found. Set ANTIGRAVITY_OAUTH_CLIENT_SECRET or reinstall Antigravity.",
    )
  }
  let lastError: unknown
  for (const clientSecret of creds.clientSecrets) {
    try {
      const body = await postForm(OAUTH_TOKEN_URL, {
        client_id: creds.clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      })
      const accessToken = stringOf(body.access_token)
      if (!accessToken) throw new Error("Antigravity OAuth refresh returned no access token")
      const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3600
      return { accessToken, expiresAt: Date.now() + expiresIn * 1000 }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error("Antigravity OAuth refresh failed")
}

export class AntigravitySession {
  private accessToken: string | null = null
  private expiresAt = 0
  private modelCache: AntigravityModelInfo[] | null = null
  private modelCacheAt = 0

  constructor(private readonly deps: {
    readTokens?: () => StoredTokens
    refresh?: (refreshToken: string, creds?: OAuthClientCredentials) => Promise<TokenPair>
    projectId?: string
    env?: NodeJS.ProcessEnv
  } = {}) {}

  private async ensureAccessToken(): Promise<string> {
    if (this.accessToken && this.expiresAt - TOKEN_REFRESH_LEAD_MS >= Date.now()) {
      return this.accessToken
    }
    const readTokens = this.deps.readTokens ?? readStoredTokens
    const stored = readTokens()
    const creds = oauthClientCredentials(this.deps.env)
    if (stored.refreshToken) {
      const refresh = this.deps.refresh ?? refreshAccessToken
      const pair = await refresh(stored.refreshToken, creds)
      this.accessToken = pair.accessToken
      this.expiresAt = pair.expiresAt
      return pair.accessToken
    }
    if (stored.accessToken) {
      this.accessToken = stored.accessToken
      this.expiresAt = Date.now()
      return stored.accessToken
    }
    throw new Error("No Antigravity session found. Sign in to Antigravity once to enable this provider.")
  }

  private projectId(): string {
    return this.deps.projectId ?? DEFAULT_PROJECT_ID
  }

  private async cloudCodeCall<T>(body: Record<string, unknown>, endpoint: string, signal?: AbortSignal): Promise<Response> {
    const token = await this.ensureAccessToken()
    return fetch(`${CLOUDCODE_PA_BASE}/${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        "X-Goog-Api-Client": API_CLIENT_HEADER,
      },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  }

  /** The production model catalog exposed by the subscription backend. */
  async listModels(): Promise<AntigravityModelInfo[]> {
    if (this.modelCache && Date.now() - this.modelCacheAt < 60_000) return this.modelCache
    const response = await this.cloudCodeCall({ project: this.projectId() }, ":fetchAvailableModels")
    if (!response.ok) {
      const detail = await response.text().catch(() => "")
      throw new Error(`Antigravity model list failed: HTTP ${response.status} ${detail.slice(0, 200)}`)
    }
    const payload = (await response.json()) as { models?: Record<string, any> }
    const models: AntigravityModelInfo[] = []
    for (const [id, info] of Object.entries(payload.models ?? {})) {
      if (typeof info !== "object" || info === null) continue
      const quota = info.quotaInfo
      models.push({
        id,
        displayName: stringOf(info.displayName) ?? id,
        maxTokens: typeof info.maxTokens === "number" ? info.maxTokens : null,
        maxOutputTokens: typeof info.maxOutputTokens === "number" ? info.maxOutputTokens : null,
        quota:
          quota && typeof quota === "object"
            ? {
                remainingFraction:
                  typeof quota.remainingFraction === "number" ? quota.remainingFraction : null,
                resetTime: stringOf(quota.resetTime),
              }
            : undefined,
      })
    }
    models.sort((a, b) => a.id.localeCompare(b.id))
    this.modelCache = models
    this.modelCacheAt = Date.now()
    return models
  }

  /**
   * Stream a generate-content turn from the subscription backend. Returns the
   * upstream SSE `data:` frames as an async generator; the caller is
   * responsible for SSE framing and translation to the client protocol.
   */
  async *streamGenerate(
    model: string,
    options: GenerateOptions,
  ): AsyncGenerator<Record<string, unknown>> {
    const request = {
      model,
      request: {
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        contents: options.contents,
        ...(options.systemInstruction ? { systemInstruction: options.systemInstruction } : {}),
        ...(options.tools ? { tools: options.tools } : {}),
        ...(options.generationConfig ? { generationConfig: options.generationConfig } : {}),
      },
    }
    const response = await this.cloudCodeCall(request, ":streamGenerateContent?alt=sse", options.signal)
    if (!response.ok) {
      const detail = await response.text().catch(() => "")
      let message = `Antigravity generate failed: HTTP ${response.status}`
      try {
        const parsed = JSON.parse(detail) as { error?: { message?: string } }
        if (parsed.error?.message) message = `Antigravity: ${parsed.error.message}`
      } catch {
        message = `${message} ${detail.slice(0, 200)}`
      }
      throw new Error(message)
    }
    if (!response.body) throw new Error("Antigravity generate returned no body")

    let buffer = ""
    const decoder = new TextDecoder()
    const reader = response.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        for (;;) {
          const separator = buffer.indexOf("\n\n")
          if (separator === -1) break
          const rawEvent = buffer.slice(0, separator)
          buffer = buffer.slice(separator + 2)
          const line = rawEvent.split("\n").find((entry) => entry.startsWith("data:"))
          if (!line) continue
          const payload = line.slice(5).trim()
          if (!payload || payload === "[DONE]") continue
          try {
            yield JSON.parse(payload) as Record<string, unknown>
          } catch {
            // Ignore malformed frames; keep the stream alive.
          }
        }
      }
      if (buffer.trim()) {
        const line = buffer.split("\n").find((entry) => entry.startsWith("data:"))
        if (line) {
          const payload = line.slice(5).trim()
          if (payload && payload !== "[DONE]") {
            try {
              yield JSON.parse(payload) as Record<string, unknown>
            } catch {
              // Ignore trailing garbage.
            }
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }
}
