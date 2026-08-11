const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const {
  RECOVERY_FILE,
  acquireVersionLock,
  bumpVersion,
  persistSnapshot,
  recoverPersistedSnapshot,
  resolveVersion,
  runCli,
  snapshotFiles,
  transactionPaths,
} = require("./bump-version.js")

function writeJson(filePath, value, indent = "  ") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, indent)}\n`)
}

function makeFixture() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "saiwork-bump-test-"))
  writeJson(path.join(rootDir, "package.json"), {
    name: "saiwork-workspace",
    version: "0.0.3",
    workspaces: {
      packages: [
        "packages/server",
        "packages/ui",
        "packages/electron-app",
        "packages/tauri-app",
        "packages/opencode-plugin",
      ],
    },
  })
  writeJson(path.join(rootDir, "package-lock.json"), {
    name: "saiwork-workspace",
    version: "0.0.3",
    packages: {
      "": { name: "saiwork-workspace", version: "0.0.3" },
      "packages/electron-app": { name: "@saiwork/electron-app", version: "0.0.3" },
      "packages/opencode-plugin": { name: "@saiwork/opencode-plugin", version: "0.0.3" },
      "packages/server": { name: "@saiwork/saiwork", version: "0.0.3" },
      "packages/tauri-app": { name: "@saiwork/tauri-app", version: "0.0.3" },
      "packages/ui": { name: "@saiwork/ui", version: "0.0.3" },
    },
  })
  writeJson(path.join(rootDir, "packages/server/package.json"), {
    name: "@saiwork/saiwork",
    version: "0.0.3",
  })
  writeJson(path.join(rootDir, "packages/server/package-lock.json"), {
    name: "@saiwork/saiwork",
    version: "0.0.3",
    packages: { "": { name: "@saiwork/saiwork", version: "0.0.3" } },
  })
  writeJson(path.join(rootDir, "packages/tauri-app/package.json"), {
    name: "@saiwork/tauri-app",
    version: "0.0.3",
  })
  writeJson(path.join(rootDir, "packages/electron-app/package.json"), {
    name: "@saiwork/electron-app",
    version: "0.0.3",
  })
  writeJson(path.join(rootDir, "packages/opencode-plugin/package.json"), {
    name: "@saiwork/opencode-plugin",
    version: "0.0.3",
  })
  writeJson(path.join(rootDir, "packages/ui/package.json"), {
    name: "@saiwork/ui",
    version: "0.0.3",
  })
  writeJson(path.join(rootDir, "packages/cloudflare/package.json"), {
    name: "@saiwork/ui-host-worker",
    version: "0.0.3",
  })
  writeJson(path.join(rootDir, "packages/cloudflare/package-lock.json"), {
    name: "@saiwork/ui-host-worker",
    version: "0.0.3",
    packages: { "": { name: "@saiwork/ui-host-worker", version: "0.0.3" } },
  })
  fs.mkdirSync(path.join(rootDir, "packages/tauri-app/src-tauri"), { recursive: true })
  fs.writeFileSync(
    path.join(rootDir, "packages/tauri-app/Cargo.lock"),
    "version = 3\n\n[[package]]\nname = \"saiwork-tauri\"\nversion = \"0.0.3\"\n",
  )
  fs.writeFileSync(
    path.join(rootDir, "packages/tauri-app/src-tauri/Cargo.toml"),
    "[package]\nname = \"saiwork-tauri\"\nversion = \"0.0.3\"\n",
  )
  writeJson(path.join(rootDir, "packages/tauri-app/src-tauri/tauri.conf.json"), { version: "0.0.3" })
  fs.writeFileSync(
    path.join(rootDir, "README.md"),
    "**Version 0.0.3**\n`SAIWORK-x64-0.0.3.zip`\n`SAIWORK-portable-x64-0.0.3.exe`\n",
  )
  fs.writeFileSync(path.join(rootDir, "CHANGELOG.md"), "# Changelog\n\n## [0.0.3] - current\n")
  return rootDir
}

function contentsByPath(paths) {
  return new Map(paths.map((filePath) => [filePath, fs.existsSync(filePath) ? fs.readFileSync(filePath) : null]))
}

function readJsonVersion(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8")).version
}

function assertSnapshot(snapshot) {
  for (const [filePath, contents] of snapshot) {
    if (contents === null) assert.equal(fs.existsSync(filePath), false, filePath)
    else assert.deepEqual(fs.readFileSync(filePath), contents, filePath)
  }
}

test("resolves explicit and semantic release versions", () => {
  assert.equal(resolveVersion("0.0.3", ["patch"]), "0.0.4")
  assert.equal(resolveVersion("0.0.3", ["minor"]), "0.1.0")
  assert.equal(resolveVersion("0.0.3", ["1.2.3"]), "1.2.3")
  assert.equal(resolveVersion("0.0.3", ["preminor", "--preid", "beta"]), "0.1.0-beta.0")
  assert.equal(resolveVersion("0.0.3", ["preminor", "--preid=beta"]), "0.1.0-beta.0")
  assert.throws(() => resolveVersion("0.0.3", ["0.0.3"]), /already 0\.0\.3/)
  assert.equal(resolveVersion("0.0.3", ["0.0.3", "--allow-same-version"]), "0.0.3")
})

test("syncs all SAIWORK, lock, Tauri, and release metadata", () => {
  const rootDir = makeFixture()
  const readmePath = path.join(rootDir, "README.md")
  writeJson(path.join(rootDir, "packages/rogue/package.json"), {
    name: "@saiwork/rogue",
    version: "0.0.3",
  })
  if (process.platform !== "win32") fs.chmodSync(readmePath, 0o640)

  assert.equal(bumpVersion({ rootDir, versionArgs: ["patch"] }), "0.0.4")
  const rootLock = JSON.parse(fs.readFileSync(path.join(rootDir, "package-lock.json"), "utf8"))
  assert.equal(rootLock.version, "0.0.4")
  assert.equal(rootLock.packages[""].version, "0.0.4")
  assert.equal(rootLock.packages["packages/electron-app"].version, "0.0.4")
  assert.equal(rootLock.packages["packages/opencode-plugin"].version, "0.0.4")
  assert.equal(rootLock.packages["packages/server"].version, "0.0.4")
  assert.equal(rootLock.packages["packages/tauri-app"].version, "0.0.4")
  assert.equal(rootLock.packages["packages/ui"].version, "0.0.4")
  for (const relativePath of [
    "package.json",
    "packages/server/package.json",
    "packages/server/package-lock.json",
    "packages/electron-app/package.json",
    "packages/opencode-plugin/package.json",
    "packages/tauri-app/package.json",
    "packages/ui/package.json",
    "packages/cloudflare/package.json",
    "packages/cloudflare/package-lock.json",
    "packages/tauri-app/src-tauri/tauri.conf.json",
  ]) {
    assert.equal(JSON.parse(fs.readFileSync(path.join(rootDir, relativePath), "utf8")).version, "0.0.4", relativePath)
  }
  assert.match(fs.readFileSync(path.join(rootDir, "packages/tauri-app/src-tauri/Cargo.toml"), "utf8"), /0\.0\.4/)
  assert.match(fs.readFileSync(path.join(rootDir, "packages/tauri-app/Cargo.lock"), "utf8"), /0\.0\.4/)
  assert.match(fs.readFileSync(readmePath, "utf8"), /Version 0\.0\.4/)
  assert.match(fs.readFileSync(path.join(rootDir, "CHANGELOG.md"), "utf8"), /## \[0\.0\.4\]/)
  assert.equal(readJsonVersion(path.join(rootDir, "packages/rogue/package.json")), "0.0.3")
  if (process.platform !== "win32") assert.equal(fs.statSync(readmePath).mode & 0o777, 0o640)
  fs.rmSync(rootDir, { recursive: true, force: true })
})

test("rolls back every metadata file when a required marker is missing", () => {
  const rootDir = makeFixture()
  fs.writeFileSync(path.join(rootDir, "README.md"), "# Missing release markers\n")
  const before = contentsByPath(transactionPaths(rootDir))
  assert.throws(
    () => bumpVersion({ rootDir, versionArgs: ["patch"] }),
    /README\.md is missing required version or Windows artifact markers/,
  )
  assertSnapshot(before)
  fs.rmSync(rootDir, { recursive: true, force: true })
})

test("rejects Unreleased before an older release heading and rolls back", () => {
  const rootDir = makeFixture()
  fs.writeFileSync(path.join(rootDir, "CHANGELOG.md"), "# Changelog\n\n## Unreleased\n\n## [0.0.3]\n")
  const before = contentsByPath(transactionPaths(rootDir))
  assert.throws(() => bumpVersion({ rootDir, versionArgs: ["patch"] }), /CHANGELOG\.md is missing a release heading/)
  assertSnapshot(before)
  fs.rmSync(rootDir, { recursive: true, force: true })
})

test("recovers a persisted snapshot before another bump", () => {
  const rootDir = makeFixture()
  const paths = transactionPaths(rootDir)
  const before = contentsByPath(paths)
  persistSnapshot(rootDir, snapshotFiles(paths))
  writeJson(path.join(rootDir, "package.json"), { name: "saiwork-workspace", version: "9.9.9" })
  fs.writeFileSync(path.join(rootDir, "README.md"), "partial write")

  assert.equal(recoverPersistedSnapshot(rootDir), true)
  assertSnapshot(before)
  assert.equal(fs.existsSync(path.join(rootDir, RECOVERY_FILE)), false)
  fs.rmSync(rootDir, { recursive: true, force: true })
})

test("recovery preserves a file that appeared after the snapshot", () => {
  const rootDir = makeFixture()
  const paths = transactionPaths(rootDir)
  persistSnapshot(rootDir, snapshotFiles(paths))
  const appearedPath = path.join(rootDir, "packages/electron-app/package-lock.json")
  writeJson(appearedPath, { name: "external", version: "9.9.9" })

  assert.throws(() => recoverPersistedSnapshot(rootDir), /target appeared after snapshot/)
  assert.equal(readJsonVersion(appearedPath), "9.9.9")
  assert.equal(fs.existsSync(path.join(rootDir, RECOVERY_FILE)), true)
  fs.rmSync(rootDir, { recursive: true, force: true })
})

test("recovery rejects a missing expected target before changing other files", () => {
  const rootDir = makeFixture()
  const paths = transactionPaths(rootDir)
  const before = contentsByPath(paths)
  persistSnapshot(rootDir, snapshotFiles(paths))
  const missingPath = path.join(rootDir, "packages/ui/package.json")
  fs.rmSync(missingPath)

  assert.throws(() => recoverPersistedSnapshot(rootDir), /expected target is missing before restore/)
  for (const [filePath, contents] of before) {
    if (filePath === missingPath || contents === null) continue
    assert.deepEqual(fs.readFileSync(filePath), contents, filePath)
  }
  assert.equal(fs.existsSync(path.join(rootDir, RECOVERY_FILE)), true)
  fs.rmSync(rootDir, { recursive: true, force: true })
})

test("rejects missing root workspace lock metadata and rolls back", () => {
  const rootDir = makeFixture()
  const lockPath = path.join(rootDir, "package-lock.json")
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"))
  delete lock.packages["packages/server"]
  writeJson(lockPath, lock)
  const before = contentsByPath(transactionPaths(rootDir))
  assert.throws(
    () => bumpVersion({ rootDir, versionArgs: ["patch"] }),
    /package-lock\.json has no workspace metadata for packages\/server/,
  )
  assertSnapshot(before)
  fs.rmSync(rootDir, { recursive: true, force: true })
})

test("requires every exact release package identity", () => {
  const rootDir = makeFixture()
  const uiPackagePath = path.join(rootDir, "packages/ui/package.json")
  fs.rmSync(uiPackagePath)
  assert.throws(() => bumpVersion({ rootDir, versionArgs: ["patch"] }), /missing release package manifest/)
  writeJson(uiPackagePath, { name: "@saiwork/not-ui", version: "0.0.3" })
  assert.throws(() => bumpVersion({ rootDir, versionArgs: ["patch"] }), /release package identity mismatch/)
  fs.rmSync(rootDir, { recursive: true, force: true })
})

test("rejects hardlinked transaction targets", (context) => {
  const rootDir = makeFixture()
  try {
    fs.linkSync(path.join(rootDir, "README.md"), path.join(rootDir, "README-link.md"))
  } catch (error) {
    fs.rmSync(rootDir, { recursive: true, force: true })
    context.skip(`hardlinks unavailable: ${error.code}`)
    return
  }
  assert.throws(() => bumpVersion({ rootDir, versionArgs: ["patch"] }), /hardlinked transaction target is forbidden/)
  fs.rmSync(rootDir, { recursive: true, force: true })
})

test("rejects symlinked transaction targets", (context) => {
  const rootDir = makeFixture()
  const readmePath = path.join(rootDir, "README.md")
  const targetPath = path.join(rootDir, "README-target.md")
  fs.renameSync(readmePath, targetPath)
  try {
    fs.symlinkSync(targetPath, readmePath, "file")
  } catch (error) {
    fs.rmSync(rootDir, { recursive: true, force: true })
    context.skip(`symlinks unavailable: ${error.code}`)
    return
  }
  assert.throws(() => bumpVersion({ rootDir, versionArgs: ["patch"] }), /transaction target must be a regular file/)
  fs.rmSync(rootDir, { recursive: true, force: true })
})

test("rejects a recovery journal outside the exact transaction path set", () => {
  const rootDir = makeFixture()
  const paths = transactionPaths(rootDir)
  persistSnapshot(rootDir, snapshotFiles(paths))
  const journalPath = path.join(rootDir, RECOVERY_FILE)
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"))
  journal.entries[0].path = "unrelated.txt"
  fs.writeFileSync(journalPath, `${JSON.stringify(journal)}\n`)
  assert.throws(() => recoverPersistedSnapshot(rootDir), /unexpected or duplicate path/)
  fs.rmSync(rootDir, { recursive: true, force: true })
})

test("rejects malformed recovery contents before restoring files", () => {
  const rootDir = makeFixture()
  const paths = transactionPaths(rootDir)
  const before = contentsByPath(paths)
  persistSnapshot(rootDir, snapshotFiles(paths))
  const journalPath = path.join(rootDir, RECOVERY_FILE)
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"))
  journal.entries[0].contents = "not-base64!"
  fs.writeFileSync(journalPath, `${JSON.stringify(journal)}\n`)
  assert.throws(() => recoverPersistedSnapshot(rootDir), /invalid contents or metadata/)
  assertSnapshot(before)
  fs.rmSync(rootDir, { recursive: true, force: true })
})

test("holds an exclusive lock and recovers a stale lock", () => {
  const rootDir = makeFixture()
  const release = acquireVersionLock(rootDir)
  assert.throws(() => acquireVersionLock(rootDir), /version bump lock unavailable/)
  release()

  const lockPath = path.join(rootDir, ".saiwork-bump-version.lock")
  fs.mkdirSync(lockPath)
  const staleTime = new Date(Date.now() - 10_000)
  fs.utimesSync(lockPath, staleTime, staleTime)
  const releaseAfterStale = acquireVersionLock(rootDir, { stale: 5_000 })
  assert.deepEqual(releaseAfterStale(), [])
  fs.rmSync(rootDir, { recursive: true, force: true })
})

test("CLI reports rollback state honestly", () => {
  const errors = []
  const incomplete = new AggregateError([], "both failed")
  incomplete.rollbackStatus = "incomplete"
  assert.equal(runCli({ bump: () => { throw incomplete }, stderr: (message) => errors.push(message) }), 1)
  assert.deepEqual(errors, ["[bumpVersion] failed; rollback incomplete: both failed"])

  errors.length = 0
  assert.equal(runCli({ bump: () => { throw new Error("lock busy") }, stderr: (message) => errors.push(message) }), 1)
  assert.deepEqual(errors, ["[bumpVersion] failed: lock busy"])
})
