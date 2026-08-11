#!/usr/bin/env node

const fs = require("node:fs")
const path = require("node:path")
const properLockfile = require("proper-lockfile")
const semver = require("semver")

const VERSION_LOCK_STALE_MS = 30 * 60_000
const RECOVERY_FILE = ".saiwork-bump-version-recovery.json"
const RELEASE_PACKAGES = new Map([
  ["cloudflare", "@saiwork/ui-host-worker"],
  ["electron-app", "@saiwork/electron-app"],
  ["opencode-plugin", "@saiwork/opencode-plugin"],
  ["server", "@saiwork/saiwork"],
  ["tauri-app", "@saiwork/tauri-app"],
  ["ui", "@saiwork/ui"],
])
let activeMetadataByPath

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

function openWithoutFollowing(filePath, flags) {
  return fs.openSync(filePath, flags | (fs.constants.O_NOFOLLOW ?? 0))
}

function assertSafeOpenedFile(filePath, stat) {
  if (!stat.isFile()) throw new Error(`transaction target must be a regular file: ${filePath}`)
  if (stat.nlink !== 1) throw new Error(`hardlinked transaction target is forbidden: ${filePath}`)
}

function writeFilePreservingMetadata(filePath, contents, metadata) {
  const resolvedPath = path.resolve(filePath)
  const hasActiveMetadata = activeMetadataByPath?.has(resolvedPath) === true
  const expectedMetadata = metadata === undefined
    ? hasActiveMetadata
      ? activeMetadataByPath.get(resolvedPath)
      : fs.existsSync(filePath)
        ? fs.lstatSync(filePath)
        : null
    : metadata

  if (expectedMetadata) {
    const descriptor = openWithoutFollowing(filePath, fs.constants.O_RDWR)
    try {
      const opened = fs.fstatSync(descriptor)
      assertSafeOpenedFile(filePath, opened)
      if (opened.dev !== expectedMetadata.dev || opened.ino !== expectedMetadata.ino) {
        throw new Error(`file identity changed before write: ${filePath}`)
      }
      fs.ftruncateSync(descriptor, 0)
      fs.writeFileSync(descriptor, contents)
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
    return
  }

  if (hasActiveMetadata && fs.existsSync(filePath)) {
    throw new Error(`transaction target appeared after snapshot: ${filePath}`)
  }

  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  )
  try {
    fs.writeFileSync(tempPath, contents, { flag: "wx" })
    if (expectedMetadata && process.platform !== "win32") {
      fs.chownSync(tempPath, expectedMetadata.uid, expectedMetadata.gid)
    }
    if (expectedMetadata) fs.chmodSync(tempPath, expectedMetadata.mode)
    fs.renameSync(tempPath, filePath)
  } finally {
    fs.rmSync(tempPath, { force: true })
  }
}

function writeJson(filePath, value) {
  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : ""
  const indent = current.match(/\n([ \t]+)"/)?.[1] ?? "  "
  writeFilePreservingMetadata(filePath, `${JSON.stringify(value, null, indent)}\n`)
}

function packageDirectories(rootDir, { requireExistence = true, validateIdentity = true } = {}) {
  const packagesDir = path.join(rootDir, "packages")
  return [...RELEASE_PACKAGES].map(([directoryName, packageName]) => {
    const directory = path.join(packagesDir, directoryName)
    const packagePath = path.join(directory, "package.json")
    const exists = fs.existsSync(packagePath)
    if (!exists && requireExistence) throw new Error(`missing release package manifest: packages/${directoryName}/package.json`)
    if (exists && validateIdentity) {
      const packageJson = readJson(packagePath)
      if (packageJson.name !== packageName) {
        throw new Error(`release package identity mismatch: packages/${directoryName} must be ${packageName}`)
      }
    }
    return directory
  })
}

function canonicalPath(filePath) {
  return fs.realpathSync.native?.(filePath) ?? fs.realpathSync(filePath)
}

function validateTransactionPath(rootDir, filePath) {
  const rootPath = path.resolve(rootDir)
  const relative = path.relative(rootPath, path.resolve(filePath))
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`transaction path escapes project root: ${filePath}`)
  }

  let current = rootPath
  const parts = relative.split(path.sep)
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part)
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink()) throw new Error(`linked transaction path is forbidden: ${current}`)
  }
  const parentRealPath = canonicalPath(path.dirname(filePath))
  const rootRealPath = canonicalPath(rootDir)
  const normalizedParent = process.platform === "win32" ? parentRealPath.toLowerCase() : parentRealPath
  const normalizedRoot = process.platform === "win32" ? rootRealPath.toLowerCase() : rootRealPath
  if (normalizedParent !== normalizedRoot && !normalizedParent.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error(`transaction path parent escapes project root: ${filePath}`)
  }

  if (!fs.existsSync(filePath)) return
  const stat = fs.lstatSync(filePath)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`transaction target must be a regular file: ${filePath}`)
  if (stat.nlink !== 1) throw new Error(`hardlinked transaction target is forbidden: ${filePath}`)
}

function validateTransactionPaths(rootDir, filePaths) {
  for (const filePath of filePaths) validateTransactionPath(rootDir, filePath)
}

function transactionPaths(rootDir) {
  const paths = [
    path.join(rootDir, "package.json"),
    path.join(rootDir, "package-lock.json"),
    path.join(rootDir, "README.md"),
    path.join(rootDir, "CHANGELOG.md"),
    path.join(rootDir, "packages", "tauri-app", "Cargo.lock"),
    path.join(rootDir, "packages", "tauri-app", "src-tauri", "Cargo.toml"),
    path.join(rootDir, "packages", "tauri-app", "src-tauri", "tauri.conf.json"),
  ]
  for (const directory of packageDirectories(rootDir, { requireExistence: false, validateIdentity: false })) {
    paths.push(path.join(directory, "package.json"))
    paths.push(path.join(directory, "package-lock.json"))
  }
  return [...new Set(paths)]
}

function snapshotFiles(filePaths) {
  return filePaths.map((filePath) => {
    if (!fs.existsSync(filePath)) return { filePath, contents: null, metadata: null }
    const descriptor = openWithoutFollowing(filePath, fs.constants.O_RDONLY)
    try {
      const metadata = fs.fstatSync(descriptor)
      assertSafeOpenedFile(filePath, metadata)
      return {
        filePath,
        contents: fs.readFileSync(descriptor),
        metadata,
      }
    } finally {
      fs.closeSync(descriptor)
    }
  })
}

function preflightRestoreSnapshot(snapshot) {
  for (const entry of snapshot) {
    if (entry.contents === null) {
      if (fs.existsSync(entry.filePath)) throw new Error(`${entry.filePath}: target appeared after snapshot`)
      continue
    }
    if (!fs.existsSync(entry.filePath)) throw new Error(`${entry.filePath}: expected target is missing before restore`)
    const descriptor = openWithoutFollowing(entry.filePath, fs.constants.O_RDONLY)
    try {
      const opened = fs.fstatSync(descriptor)
      assertSafeOpenedFile(entry.filePath, opened)
      if (opened.dev !== entry.metadata.dev || opened.ino !== entry.metadata.ino) {
        throw new Error(`${entry.filePath}: file identity changed before restore`)
      }
    } finally {
      fs.closeSync(descriptor)
    }
  }
}

function restoreSnapshot(snapshot) {
  preflightRestoreSnapshot(snapshot)
  const failures = []
  for (const entry of snapshot) {
    try {
      if (entry.contents !== null) writeFilePreservingMetadata(entry.filePath, entry.contents, entry.metadata)
    } catch (error) {
      failures.push(`${entry.filePath}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (failures.length > 0) throw new Error(`rollback failed:\n${failures.join("\n")}`)
}

function fsyncDirectory(directory) {
  let descriptor
  try {
    descriptor = fs.openSync(directory, "r")
    fs.fsyncSync(descriptor)
  } catch (error) {
    if (process.platform !== "win32" || !["EACCES", "EINVAL", "EPERM"].includes(error?.code)) throw error
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

function recoveryPath(rootDir) {
  return path.join(rootDir, RECOVERY_FILE)
}

function persistSnapshot(rootDir, snapshot) {
  const journalPath = recoveryPath(rootDir)
  if (fs.existsSync(journalPath)) throw new Error(`${RECOVERY_FILE} already exists; recovery must run first`)
  const entries = snapshot.map((entry) => ({
    path: path.relative(rootDir, entry.filePath).split(path.sep).join("/"),
    contents: entry.contents === null ? null : entry.contents.toString("base64"),
    metadata: entry.metadata
      ? {
          dev: entry.metadata.dev,
          gid: entry.metadata.gid,
          ino: entry.metadata.ino,
          mode: entry.metadata.mode,
          uid: entry.metadata.uid,
        }
      : null,
  }))
  let descriptor
  try {
    descriptor = fs.openSync(journalPath, "wx", 0o600)
    fs.writeFileSync(descriptor, `${JSON.stringify({ version: 1, entries })}\n`)
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fsyncDirectory(rootDir)
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

function removeRecoveryFile(rootDir) {
  fs.rmSync(recoveryPath(rootDir), { force: true })
  fsyncDirectory(rootDir)
}

function recoverPersistedSnapshot(rootDir) {
  const journalPath = recoveryPath(rootDir)
  if (!fs.existsSync(journalPath)) return false
  const journal = readJson(journalPath)
  if (journal.version !== 1 || !Array.isArray(journal.entries)) {
    throw new Error(`${RECOVERY_FILE} is malformed; refusing a new version bump`)
  }
  const expectedPaths = transactionPaths(rootDir)
  const expectedByRelativePath = new Map(expectedPaths.map((filePath) => [
    path.relative(rootDir, filePath).split(path.sep).join("/"),
    filePath,
  ]))
  if (journal.entries.length !== expectedByRelativePath.size) {
    throw new Error(`${RECOVERY_FILE} path set does not match release transaction`)
  }
  const seen = new Set()
  const snapshot = journal.entries.map((entry) => {
    if (typeof entry.path !== "string" || seen.has(entry.path) || !expectedByRelativePath.has(entry.path)) {
      throw new Error(`${RECOVERY_FILE} contains an unexpected or duplicate path: ${entry.path}`)
    }
    seen.add(entry.path)
    const filePath = expectedByRelativePath.get(entry.path)
    const hasContents = typeof entry.contents === "string"
      && Buffer.from(entry.contents, "base64").toString("base64") === entry.contents
    const metadata = entry.metadata
    const hasMetadata = metadata && typeof metadata === "object" && !Array.isArray(metadata)
      && ["dev", "gid", "ino", "mode", "uid"]
        .every((field) => Number.isInteger(metadata[field]) && metadata[field] >= 0)
    if (entry.contents === null ? metadata !== null : !hasContents || !hasMetadata) {
      throw new Error(`${RECOVERY_FILE} contains invalid contents or metadata for: ${entry.path}`)
    }
    return {
      filePath,
      contents: entry.contents === null ? null : Buffer.from(entry.contents, "base64"),
      metadata,
    }
  })
  validateTransactionPaths(rootDir, expectedPaths)
  try {
    restoreSnapshot(snapshot)
  } catch (error) {
    error.rollbackStatus = "incomplete"
    throw error
  }
  removeRecoveryFile(rootDir)
  return true
}

function acquireVersionLock(rootDir, { stale = VERSION_LOCK_STALE_MS, lockSync = properLockfile.lockSync } = {}) {
  const lockPath = path.join(rootDir, ".saiwork-bump-version.lock")
  let release
  try {
    release = lockSync(rootDir, {
      lockfilePath: lockPath,
      realpath: true,
      retries: 0,
      stale,
      update: Math.max(1000, Math.floor(stale / 2)),
    })
  } catch (error) {
    throw new Error(`version bump lock unavailable: ${lockPath}: ${error instanceof Error ? error.message : String(error)}`)
  }

  let released = false
  return () => {
    if (released) return []
    released = true
    try {
      release()
      return []
    } catch (error) {
      return [error instanceof Error ? error.message : String(error)]
    }
  }
}

function resolveVersion(currentVersion, versionArgs) {
  if (!semver.valid(currentVersion)) throw new Error(`current package version is invalid: ${currentVersion}`)
  let target
  let preid
  let allowSame = false
  for (let index = 0; index < versionArgs.length; index += 1) {
    const argument = versionArgs[index]
    if (argument === "--allow-same-version") {
      allowSame = true
    } else if (argument.startsWith("--preid=")) {
      preid = argument.slice("--preid=".length)
      if (!preid) throw new Error("--preid needs a value")
    } else if (argument === "--preid") {
      preid = versionArgs[index + 1]
      index += 1
      if (!preid || preid.startsWith("--")) throw new Error("--preid needs a value")
    } else if (argument.startsWith("--")) {
      throw new Error(`unsupported version option: ${argument}`)
    } else if (target) {
      throw new Error(`unexpected version argument: ${argument}`)
    } else {
      target = argument
    }
  }
  if (!target) throw new Error("missing version argument (example: npm run bumpVersion -- patch)")

  const explicit = semver.valid(target)
  const version = explicit ? explicit : semver.inc(currentVersion, target, preid)
  if (!version) throw new Error(`invalid version or release type: ${target}`)
  if (!allowSame && semver.eq(currentVersion, version)) {
    throw new Error(`version is already ${version}; pass --allow-same-version to resync metadata`)
  }
  return version
}

function syncPackageMetadata(rootDir, version) {
  const rootPackagePath = path.join(rootDir, "package.json")
  const rootLockPath = path.join(rootDir, "package-lock.json")
  const rootPackage = readJson(rootPackagePath)
  const rootLock = readJson(rootLockPath)
  rootPackage.version = version
  rootLock.version = version
  if (!rootLock.packages?.[""]) throw new Error("package-lock.json has no root package metadata")
  rootLock.packages[""].version = version
  const workspacePaths = new Set(rootPackage.workspaces?.packages ?? [])

  writeJson(rootPackagePath, rootPackage)
  for (const directory of packageDirectories(rootDir)) {
    const packagePath = path.join(directory, "package.json")
    const packageJson = readJson(packagePath)
    if (typeof packageJson.name !== "string" || !packageJson.name.startsWith("@saiwork/")) continue
    packageJson.version = version
    writeJson(packagePath, packageJson)

    const relativeDirectory = path.relative(rootDir, directory).split(path.sep).join("/")
    if (workspacePaths.has(relativeDirectory)) {
      if (!rootLock.packages[relativeDirectory]) {
        throw new Error(`package-lock.json has no workspace metadata for ${relativeDirectory}`)
      }
      rootLock.packages[relativeDirectory].version = version
    }

    const nestedLockPath = path.join(directory, "package-lock.json")
    if (!fs.existsSync(nestedLockPath)) continue
    const nestedLock = readJson(nestedLockPath)
    if (!nestedLock.packages?.[""]) {
      throw new Error(`${path.relative(rootDir, nestedLockPath)} has no root package metadata`)
    }
    nestedLock.name = packageJson.name
    nestedLock.version = version
    nestedLock.packages[""].name = packageJson.name
    nestedLock.packages[""].version = version
    writeJson(nestedLockPath, nestedLock)
  }
  writeJson(rootLockPath, rootLock)
}

function replaceRequired(filePath, pattern, replacement, errorMessage) {
  const current = fs.readFileSync(filePath, "utf8")
  if (!pattern.test(current)) throw new Error(errorMessage)
  writeFilePreservingMetadata(filePath, current.replace(pattern, replacement))
}

function syncTauriMetadata(rootDir, version) {
  const tauriRoot = path.join(rootDir, "packages", "tauri-app")
  replaceRequired(
    path.join(tauriRoot, "src-tauri", "Cargo.toml"),
    /(\[package\][\s\S]*?^version\s*=\s*")([^"]+)(")/m,
    `$1${version}$3`,
    "Cargo.toml has no [package] version",
  )
  const cargoLockPath = path.join(tauriRoot, "Cargo.lock")
  if (fs.existsSync(cargoLockPath)) {
    replaceRequired(
      cargoLockPath,
      /(\[\[package\]\]\r?\nname = "saiwork-tauri"\r?\nversion = ")([^"]+)(")/,
      `$1${version}$3`,
      "Cargo.lock has no saiwork-tauri version",
    )
  }
  const configPath = path.join(tauriRoot, "src-tauri", "tauri.conf.json")
  const config = readJson(configPath)
  config.version = version
  writeJson(configPath, config)
}

function syncReleaseDocs(rootDir, version) {
  const readmePath = path.join(rootDir, "README.md")
  const readme = fs.readFileSync(readmePath, "utf8")
  const readmeMarkers = [
    /\*\*Version [^*]+\*\*/,
    /SAIWORK-x64-[0-9A-Za-z.+-]+\.zip/,
    /SAIWORK-portable-x64-[0-9A-Za-z.+-]+\.exe/,
  ]
  if (readmeMarkers.some((marker) => !marker.test(readme))) {
    throw new Error("README.md is missing required version or Windows artifact markers")
  }
  writeFilePreservingMetadata(
    readmePath,
    readme
      .replace(readmeMarkers[0], `**Version ${version}**`)
      .replace(new RegExp(readmeMarkers[1].source, "g"), `SAIWORK-x64-${version}.zip`)
      .replace(new RegExp(readmeMarkers[2].source, "g"), `SAIWORK-portable-x64-${version}.exe`),
  )

  const changelogPath = path.join(rootDir, "CHANGELOG.md")
  const changelog = fs.readFileSync(changelogPath, "utf8")
  const heading = /^## (\[)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?(\])?(?=\s|$)/m
  const firstLevelTwoHeading = changelog.match(/^## .+$/m)?.[0]
  const match = firstLevelTwoHeading?.match(heading)
  if (!match || Boolean(match[1]) !== Boolean(match[2])) {
    throw new Error("CHANGELOG.md is missing a release heading")
  }
  writeFilePreservingMetadata(
    changelogPath,
    changelog.replace(heading, match[1] ? `## [${version}]` : `## ${version}`),
  )
}

function bumpVersion({ rootDir = path.resolve(__dirname, ".."), versionArgs = process.argv.slice(2) } = {}) {
  const releaseLock = acquireVersionLock(rootDir)
  let version
  let failure
  try {
    recoverPersistedSnapshot(rootDir)
    packageDirectories(rootDir)
    version = resolveVersion(readJson(path.join(rootDir, "package.json")).version, versionArgs)
    const paths = transactionPaths(rootDir)
    validateTransactionPaths(rootDir, paths)
    const snapshot = snapshotFiles(paths)
    persistSnapshot(rootDir, snapshot)
    activeMetadataByPath = new Map(snapshot.map((entry) => [path.resolve(entry.filePath), entry.metadata]))
    try {
      syncPackageMetadata(rootDir, version)
      syncTauriMetadata(rootDir, version)
      syncReleaseDocs(rootDir, version)
      removeRecoveryFile(rootDir)
    } catch (error) {
      try {
        restoreSnapshot(snapshot)
        removeRecoveryFile(rootDir)
      } catch (rollbackError) {
        const aggregate = new AggregateError([error, rollbackError], "version bump and rollback both failed")
        aggregate.rollbackStatus = "incomplete"
        throw aggregate
      }
      error.rollbackStatus = "complete"
      throw error
    } finally {
      activeMetadataByPath = undefined
    }
  } catch (error) {
    failure = error
  }

  const cleanupFailures = releaseLock()
  if (cleanupFailures.length > 0) {
    if (failure) {
      const aggregate = new AggregateError(
        [failure, ...cleanupFailures.map((message) => new Error(message))],
        `${failure.message}; version bump lock cleanup failed`,
      )
      aggregate.rollbackStatus = failure.rollbackStatus
      throw aggregate
    }
    const cleanupError = new Error(
      `version metadata updated to ${version}, but lock cleanup failed: ${cleanupFailures.join("; ")}`,
    )
    cleanupError.metadataUpdated = true
    throw cleanupError
  }
  if (failure) throw failure
  return version
}

function runCli({ bump = bumpVersion, stdout = console.log, stderr = console.error } = {}) {
  try {
    const version = bump()
    stdout(`[bumpVersion] synced ${version}`)
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const state = error?.rollbackStatus === "complete"
      ? "; changes rolled back"
      : error?.rollbackStatus === "incomplete"
        ? "; rollback incomplete"
        : error?.metadataUpdated
          ? "; metadata updated but cleanup incomplete"
          : ""
    stderr(`[bumpVersion] failed${state}: ${message}`)
    return 1
  }
}

if (require.main === module) process.exitCode = runCli()

module.exports = {
  RECOVERY_FILE,
  RELEASE_PACKAGES,
  VERSION_LOCK_STALE_MS,
  acquireVersionLock,
  bumpVersion,
  readJson,
  recoverPersistedSnapshot,
  resolveVersion,
  restoreSnapshot,
  runCli,
  persistSnapshot,
  snapshotFiles,
  syncPackageMetadata,
  syncReleaseDocs,
  syncTauriMetadata,
  transactionPaths,
  writeFilePreservingMetadata,
}
