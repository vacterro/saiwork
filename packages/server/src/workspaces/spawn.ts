import { spawn, spawnSync, type ChildProcess } from "child_process"
import { statSync } from "fs"
import path from "path"

export const WINDOWS_CMD_EXTENSIONS = new Set([".cmd", ".bat"])
export const WINDOWS_POWERSHELL_EXTENSIONS = new Set([".ps1"])

const VERSION_REGEX = /([0-9]+\.[0-9]+\.[0-9A-Za-z.-]+)/
const WSL_UNC_PATH_REGEX = /^\\\\wsl(?:\.localhost|\$)\\([^\\/]+)(?:[\\/](.*))?$/i
const SAIWORK_PLUGIN_PACKAGE_NAME = "@saiwork/opencode-plugin"
const WSL_PLUGIN_PATH_ENV = "SAIWORK_OPENCODE_PLUGIN_WSL_PATH"
const WSL_PLUGIN_PATH_PLACEHOLDER = "__SAIWORK_OPENCODE_PLUGIN_WSL_PATH__"
const SAIWORK_PLUGIN_FILE_SPEC_REGEX = new RegExp(
  `(${escapeRegex(SAIWORK_PLUGIN_PACKAGE_NAME)}@file:)([A-Za-z]:[^"\\r\\n]+?\\.tgz)`,
)
const WSL_PATH_ENV_KEYS = new Set(["NODE_EXTRA_CA_CERTS", WSL_PLUGIN_PATH_ENV, "XDG_DATA_HOME"])
const WINDOWS_DIRECT_EXTENSIONS = new Set([".com", ".exe"])
const DEFAULT_WINDOWS_PATHEXT = ".COM;.EXE;.BAT;.CMD"
const WINDOWS_SHELL_NAMES = new Set([
  "bash",
  "bash.exe",
  "cmd",
  "cmd.exe",
  "command.com",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "sh",
  "sh.exe",
])

export type SpawnProcessKind = "posix" | "windows-direct" | "windows-wrapper" | "wsl"

export interface SpawnSpec {
  command: string
  args: string[]
  processKind: SpawnProcessKind
  options: {
    windowsVerbatimArguments?: boolean
  }
  cwd?: string
  env?: NodeJS.ProcessEnv
  wsl?: {
    distro: string
    pidMarker?: string
  }
}

interface BuildSpawnSpecOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  propagateEnvKeys?: string[]
  wslPidMarker?: string
  platform?: NodeJS.Platform
}

interface WslPath {
  distro: string
  linuxPath: string
}

export type WslWorkingDirectory =
  | { kind: "linux"; path: string }
  | { kind: "windows"; path: string }

export function parseWslUncPath(input: string): WslPath | null {
  const normalized = input.trim().replace(/\//g, "\\")
  const match = normalized.match(WSL_UNC_PATH_REGEX)
  if (!match) {
    return null
  }

  const distro = match[1] ?? ""
  const remainder = match[2] ?? ""
  const segments = remainder.split(/\\+/).filter((segment) => segment.length > 0)

  return {
    distro,
    linuxPath: segments.length > 0 ? `/${segments.join("/")}` : "/",
  }
}

export function resolveWslWorkingDirectory(folder: string, distro: string): WslWorkingDirectory | null {
  const wslFolder = parseWslUncPath(folder)
  if (wslFolder) {
    return wslFolder.distro.toLowerCase() === distro.toLowerCase() ? { kind: "linux", path: wslFolder.linuxPath } : null
  }

  const windowsFolder = normalizeWindowsPath(folder)
  return windowsFolder ? { kind: "windows", path: windowsFolder } : null
}

export function buildWindowsSpawnSpec(binaryPath: string, args: string[], options: BuildSpawnSpecOptions = {}): SpawnSpec {
  const wslPath = parseWslUncPath(binaryPath)
  if (wslPath) {
    return buildWslSpawnSpec(wslPath, args, options)
  }

  const resolvedBinaryPath = resolveBareWindowsCommand(binaryPath, options) ?? binaryPath
  const extension = path.win32.extname(resolvedBinaryPath).toLowerCase()

  if (WINDOWS_CMD_EXTENSIONS.has(extension)) {
    const comspec = getWindowsEnvironmentValue(options.env, "COMSPEC") ??
      getWindowsEnvironmentValue(process.env, "COMSPEC") ??
      "cmd.exe"
    // cmd.exe requires the full command as a single string.
    // Using the ""<script> <args>"" pattern ensures paths with spaces are handled.
    const commandLine = `""${resolvedBinaryPath}" ${args.join(" ")}"`

    return {
      command: comspec,
      args: ["/d", "/s", "/c", commandLine],
      processKind: "windows-wrapper",
      options: { windowsVerbatimArguments: true },
      cwd: options.cwd,
      env: options.env,
    }
  }

  if (WINDOWS_POWERSHELL_EXTENSIONS.has(extension)) {
    // powershell.exe ships with Windows. (pwsh may not.)
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolvedBinaryPath, ...args],
      processKind: "windows-wrapper",
      options: {},
      cwd: options.cwd,
      env: options.env,
    }
  }

  return {
    command: resolvedBinaryPath,
    args,
    processKind: classifyWindowsCommand(resolvedBinaryPath),
    options: {},
    cwd: options.cwd,
    env: options.env,
  }
}

export function buildSpawnSpec(binaryPath: string, args: string[], options: BuildSpawnSpecOptions = {}): SpawnSpec {
  if ((options.platform ?? process.platform) !== "win32") {
    return {
      command: binaryPath,
      args,
      processKind: "posix",
      options: {},
      cwd: options.cwd,
      env: options.env,
    }
  }

  return buildWindowsSpawnSpec(binaryPath, args, options)
}

export interface BinaryVersionProbeResult {
  valid: boolean
  version?: string
  reported?: string
  error?: string
}

/**
 * Kill a probe child and its whole process tree. A plain `child.kill()` only
 * kills the direct child: on Windows a `cmd /c` wrapper spawns the real tool
 * and would leave it alive holding our stdio pipes open, which keeps the
 * server's event loop from ever settling.
 */
function killProbeTree(child: ChildProcess): void {
  const pid = child.pid
  if (!pid) {
    try {
      child.kill("SIGKILL")
    } catch {
      // Already dead.
    }
    return
  }
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" })
    } catch {
      try {
        child.kill("SIGKILL")
      } catch {
        // Already dead.
      }
    }
    return
  }
  try {
    process.kill(-pid, "SIGKILL")
  } catch {
    try {
      child.kill("SIGKILL")
    } catch {
      // Already dead.
    }
  }
}

const BINARY_PROBE_TIMEOUT_MS = 4000

/**
 * Bounded `--version` probe of a candidate binary.
 *
 * Async with a hard timeout and forced cleanup: a binary that never exits (a
 * GUI app that swallows the flag, a hung launcher) must NOT freeze the server
 * event loop the way a synchronous spawn would. On timeout the whole process
 * tree is killed and the probe reports a timeout error.
 */
export async function probeBinaryVersion(binaryPath: string): Promise<BinaryVersionProbeResult> {
  if (!binaryPath) {
    return { valid: false, error: "Missing binary path" }
  }

  let child: ChildProcess
  try {
    const spec = buildSpawnSpec(binaryPath, ["--version"])
    child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      windowsVerbatimArguments: Boolean(spec.options.windowsVerbatimArguments),
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : String(error) }
  }

  const probe = await new Promise<{
    error?: string
    code: number | null
    stdout: string
    stderr: string
  }>((resolve) => {
    let stdout = ""
    let stderr = ""
    let settled = false
    const settle = (value: { error?: string; code: number | null; stdout: string; stderr: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    child.stdout?.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr?.on("data", (chunk) => {
      stderr += chunk
    })
    const timer = setTimeout(() => {
      // Forced cleanup: the probe cannot wait forever on a binary that refuses
      // to exit. Kill the whole tree so nothing keeps our stdio pipes open.
      killProbeTree(child)
      settle({
        error: `Binary version probe timed out after ${BINARY_PROBE_TIMEOUT_MS}ms`,
        code: null,
        stdout,
        stderr,
      })
    }, BINARY_PROBE_TIMEOUT_MS)
    timer.unref?.()
    child.once("error", (error) => {
      settle({ error: error.message, code: null, stdout, stderr })
    })
    child.once("close", (code) => {
      settle({ code, stdout, stderr })
    })
  })

  if (probe.error) {
    return { valid: false, error: probe.error }
  }

  if (probe.code !== 0) {
    const stderr = probe.stderr.trim()
    const stdout = probe.stdout.trim()
    const combined = stderr || stdout
    const error = combined ? `Exited with code ${probe.code}: ${combined}` : `Exited with code ${probe.code}`
    return { valid: false, error }
  }

  const stdoutLines = probe.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const stderrLines = probe.stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  // Prefer stdout; fall back to stderr (some tools report version there).
  const reported = stdoutLines[0] ?? stderrLines[0]
  if (!reported) {
    return { valid: true }
  }

  const versionMatch = reported.match(VERSION_REGEX)
  const version = versionMatch?.[1]
  return { valid: true, version, reported }
}

function buildWslSpawnSpec(wslPath: WslPath, args: string[], options: BuildSpawnSpecOptions): SpawnSpec {
  const workingDirectory = options.cwd ? resolveWslWorkingDirectory(options.cwd, wslPath.distro) : undefined
  const env = buildWslEnvironment(options.env, options.propagateEnvKeys)
  const shouldTranslatePluginPath = Boolean(env?.[WSL_PLUGIN_PATH_ENV])
  if (options.cwd && !workingDirectory) {
    throw new Error(
      `Unable to translate workspace folder for WSL binary in distro "${wslPath.distro}": ${options.cwd}`,
    )
  }

  const wslArgs = ["--distribution", wslPath.distro]
  const shouldWrapWithShell = Boolean(options.wslPidMarker) || workingDirectory?.kind === "windows" || shouldTranslatePluginPath

  if (!shouldWrapWithShell && workingDirectory?.kind === "linux") {
    wslArgs.push("--cd", workingDirectory.path)
  }

  if (shouldWrapWithShell) {
    const launchScript = buildWslLaunchScript(workingDirectory ?? undefined, options.wslPidMarker, shouldTranslatePluginPath)
    wslArgs.push(
      "--exec",
      "sh",
      "-lc",
      launchScript,
      "saiwork-wsl-launch",
    )
    if (workingDirectory) {
      wslArgs.push(workingDirectory.path)
    }
    wslArgs.push(
      wslPath.linuxPath,
      ...args,
    )
  } else {
    wslArgs.push("--exec", wslPath.linuxPath, ...args)
  }

  return {
    command: "wsl.exe",
    args: wslArgs,
    processKind: "wsl",
    options: {},
    env,
    wsl: { distro: wslPath.distro, pidMarker: options.wslPidMarker },
  }
}

function classifyWindowsCommand(binaryPath: string): SpawnProcessKind {
  const commandName = path.win32.basename(binaryPath).toLowerCase()
  if (WINDOWS_SHELL_NAMES.has(commandName)) {
    return "windows-wrapper"
  }

  const extension = path.win32.extname(binaryPath).toLowerCase()
  if (extension) {
    return WINDOWS_DIRECT_EXTENSIONS.has(extension) ? "windows-direct" : "windows-wrapper"
  }

  // Bare commands can resolve to npm/script shims, so keep them on the
  // wrapper path. That path owns cleanup without requiring process discovery.
  return "windows-wrapper"
}

function resolveBareWindowsCommand(binaryPath: string, options: BuildSpawnSpecOptions): string | null {
  if (!/^[^\\/:]+$/.test(binaryPath) || path.win32.extname(binaryPath)) return null

  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const pathEntries = (getWindowsEnvironmentValue(env, "PATH") ?? "")
    .split(";")
    .map(unquoteWindowsPathEntry)
  const extensions = (getWindowsEnvironmentValue(env, "PATHEXT") ?? DEFAULT_WINDOWS_PATHEXT)
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean)
    .map((extension) => (extension.startsWith(".") ? extension : `.${extension}`).toLowerCase())

  for (const entry of [cwd, ...pathEntries]) {
    const directory = entry
      ? path.win32.resolve(cwd, entry)
      : path.win32.resolve(cwd)
    for (const extension of extensions) {
      const candidate = path.win32.join(directory, `${binaryPath}${extension}`)
      try {
        if (statSync(candidate).isFile()) return candidate
      } catch {
        // Continue in Windows PATH/PATHEXT order.
      }
    }
  }

  return null
}

function getWindowsEnvironmentValue(env: NodeJS.ProcessEnv | undefined, key: string): string | undefined {
  if (!env) return undefined
  const match = Object.keys(env).reverse().find((candidate) => candidate.toUpperCase() === key)
  return match ? env[match] : undefined
}

function unquoteWindowsPathEntry(entry: string): string {
  const trimmed = entry.trim()
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed
}

function buildWslLaunchScript(
  workingDirectory: WslWorkingDirectory | undefined,
  pidMarker: string | undefined,
  translatePluginPath: boolean,
): string {
  const steps: string[] = []

  if (pidMarker) {
    steps.push(
      `saiwork_pgid=$(ps -o pgid= -p "$$" 2>/dev/null | tr -d '[:space:]'); saiwork_start=$(awk '{print $22}' "/proc/$$/stat" 2>/dev/null); saiwork_boot=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null); test -n "$saiwork_pgid" && test -n "$saiwork_start" && test -n "$saiwork_boot" && printf '%s%s:%s:%s:%s\\n' '${pidMarker}' "$$" "$saiwork_pgid" "$saiwork_start" "$saiwork_boot"`,
    )
  }

  if (workingDirectory?.kind === "linux") {
    steps.push('cd "$1"')
    steps.push("shift")
  } else if (workingDirectory?.kind === "windows") {
    steps.push('cd "$(wslpath -au "$1")"')
    steps.push("shift")
  }

  if (translatePluginPath) {
    steps.push(
      `if [ -n "$${WSL_PLUGIN_PATH_ENV}" ] && [ -n "$OPENCODE_CONFIG_CONTENT" ]; then escaped_plugin_path=$(printf '%s' "$${WSL_PLUGIN_PATH_ENV}" | sed 's/[\\&|]/\\\\&/g'); OPENCODE_CONFIG_CONTENT=$(printf '%s' "$OPENCODE_CONFIG_CONTENT" | sed "s|${WSL_PLUGIN_PATH_PLACEHOLDER}|$escaped_plugin_path|g"); export OPENCODE_CONFIG_CONTENT; unset ${WSL_PLUGIN_PATH_ENV}; fi`,
    )
  }

  steps.push('exec "$@"')
  return steps.join(" && ")
}

function normalizeWindowsPath(input: string): string | null {
  const normalized = path.win32.normalize(input.trim().replace(/\//g, "\\"))
  if (!normalized) {
    return null
  }

  if (/^[A-Za-z]:/.test(normalized) || normalized.startsWith("\\\\")) {
    return normalized
  }

  return null
}

function buildWslEnvironment(env: NodeJS.ProcessEnv | undefined, propagateEnvKeys: string[] | undefined): NodeJS.ProcessEnv | undefined {
  if (!env) {
    return env
  }

  const next = { ...env }
  rewriteOpencodePluginPathForWsl(next)

  const keysToPropagate = Array.from(
    new Set([
      ...(propagateEnvKeys ?? []).filter((key) => next[key] !== undefined),
      ...Array.from(WSL_PATH_ENV_KEYS).filter((key) => next[key] !== undefined),
    ]),
  )
  if (keysToPropagate.length === 0) {
    return next
  }

  const entries = (next.WSLENV ?? "").split(":").filter((entry) => entry.length > 0)
  const byName = new Map(entries.map((entry) => [entry.split("/")[0] ?? entry, entry]))

  for (const key of keysToPropagate) {
    const existingEntry = byName.get(key)
    if (existingEntry) {
      byName.set(key, ensureWslenvEntry(existingEntry, WSL_PATH_ENV_KEYS.has(key)))
      continue
    }
    byName.set(key, WSL_PATH_ENV_KEYS.has(key) ? `${key}/p` : key)
  }

  next.WSLENV = Array.from(byName.values()).join(":")
  return next
}

function rewriteOpencodePluginPathForWsl(env: NodeJS.ProcessEnv) {
  const content = env.OPENCODE_CONFIG_CONTENT
  if (!content) {
    return
  }

  const match = content.match(SAIWORK_PLUGIN_FILE_SPEC_REGEX)
  const hostPath = match?.[2]
  if (!hostPath) {
    return
  }

  env.OPENCODE_CONFIG_CONTENT = content.replace(hostPath, WSL_PLUGIN_PATH_PLACEHOLDER)
  env[WSL_PLUGIN_PATH_ENV] = path.win32.normalize(hostPath)
}

function ensureWslenvEntry(entry: string, requiresPathTranslation: boolean): string {
  if (!requiresPathTranslation) {
    return entry
  }

  const [name, rawFlags = ""] = entry.split("/")
  if (rawFlags.includes("p")) {
    return entry
  }

  return rawFlags.length > 0 ? `${name}/${rawFlags}p` : `${name}/p`
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
