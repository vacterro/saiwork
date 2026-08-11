const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const {
  checkArtifacts,
  checkMetadata,
  findPeVersions,
  peVersionMatches,
} = require("./check-release-consistency.js")

const VERSION = "0.0.3"
const TYPECHECK = "npm run typecheck --workspace @saiwork/saiwork && npm run typecheck --workspace @saiwork/ui && npm run typecheck --workspace @saiwork/electron-app"
const RELEASE_CHECK = "npm run test:release && node ./scripts/check-release-consistency.js && npm run typecheck"

function write(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, contents)
}

function writeJson(filePath, value) {
  write(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function makeFixture() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "saiwork-release-test-"))
  const packageDefinitions = [
    ["server", "@saiwork/saiwork", true],
    ["ui", "@saiwork/ui", true],
    ["electron-app", "@saiwork/electron-app", true],
    ["tauri-app", "@saiwork/tauri-app", false],
    ["opencode-plugin", "@saiwork/opencode-plugin", false],
    ["cloudflare", "@saiwork/ui-host-worker", false],
  ]
  const rootPackage = {
    name: "saiwork-workspace",
    version: VERSION,
    workspaces: { packages: packageDefinitions.filter(([directory]) => directory !== "cloudflare").map(([directory]) => `packages/${directory}`) },
    scripts: { typecheck: TYPECHECK, "release:check": RELEASE_CHECK },
    devDependencies: { "@electron/asar": "3.4.1", electron: "38.0.0", yauzl: "2.10.0" },
  }
  writeJson(path.join(rootDir, "package.json"), rootPackage)

  const lockPackages = {
    "": { name: rootPackage.name, version: VERSION, devDependencies: rootPackage.devDependencies },
    "node_modules/@electron/asar": { version: "3.4.1" },
    "node_modules/electron": { version: "38.0.0" },
    "node_modules/yauzl": { version: "2.10.0" },
  }
  for (const [directory, name, typecheck] of packageDefinitions) {
    const packageJson = {
      name,
      version: VERSION,
      scripts: typecheck ? { typecheck: "tsc --noEmit" } : {},
    }
    if (directory === "electron-app") {
      packageJson.devDependencies = { electron: "38.0.0" }
      packageJson.build = {
        win: {
          target: [{ target: "portable" }, { target: "zip" }],
          artifactName: "SAIWORK-${arch}-${version}.${ext}",
        },
        portable: { artifactName: "SAIWORK-portable-${arch}-${version}.exe" },
      }
    }
    writeJson(path.join(rootDir, `packages/${directory}/package.json`), packageJson)
    if (directory !== "cloudflare") {
      lockPackages[`packages/${directory}`] = {
        name,
        version: VERSION,
        ...(directory === "electron-app" ? { devDependencies: { electron: "38.0.0" } } : {}),
      }
    }
    if (directory === "server" || directory === "cloudflare") {
      writeJson(path.join(rootDir, `packages/${directory}/package-lock.json`), {
        name,
        version: VERSION,
        packages: { "": { name, version: VERSION } },
      })
    }
  }
  writeJson(path.join(rootDir, "package-lock.json"), {
    name: rootPackage.name,
    version: VERSION,
    packages: lockPackages,
  })

  write(path.join(rootDir, "packages/tauri-app/src-tauri/Cargo.toml"), `[package]\nname = "saiwork-tauri"\nversion = "${VERSION}"\n`)
  write(path.join(rootDir, "packages/tauri-app/Cargo.lock"), `[[package]]\nname = "saiwork-tauri"\nversion = "${VERSION}"\n`)
  writeJson(path.join(rootDir, "packages/tauri-app/src-tauri/tauri.conf.json"), { version: VERSION })
  write(path.join(rootDir, "README.md"), `**Version ${VERSION}**\n\`SAIWORK-x64-${VERSION}.zip\`\n\`SAIWORK-portable-x64-${VERSION}.exe\`\n`)
  write(path.join(rootDir, "CHANGELOG.md"), `# Changelog\n\n## [${VERSION}] - 2026-08-11\n`)
  write(path.join(rootDir, ".github/workflows/release.yml"), "on:\n  push:\n    branches:\n      - saiwork\n")
  write(
    path.join(rootDir, ".github/workflows/reusable-release.yml"),
    "run: npm ci --workspaces --include-workspace-root --include=optional\nrun: npm run bumpVersion -- 0.0.3 --allow-same-version\nrun: npm run release:check\n",
  )
  write(path.join(rootDir, ".github/workflows/release-ui.yml"), "run: npm run release:check\n")
  write(path.join(rootDir, ".github/workflows/manual-npm-publish.yml"), "run: npm run release:check\n")
  write(path.join(rootDir, ".github/workflows/pr-build.yml"), "run: npm run release:check\n")
  write(path.join(rootDir, ".github/workflows/build-and-upload.yml"), "path: packages/electron-app/release/*.exe\n")
  return rootDir
}

test("accepts aligned package, lock, docs, workflow, and typecheck metadata", () => {
  const rootDir = makeFixture()
  assert.deepEqual(checkMetadata(rootDir), [])
  fs.rmSync(rootDir, { recursive: true, force: true })
})

test("reports package drift and a removed workspace typecheck", () => {
  const rootDir = makeFixture()
  const cloudflarePath = path.join(rootDir, "packages/cloudflare/package.json")
  const cloudflare = JSON.parse(fs.readFileSync(cloudflarePath, "utf8"))
  cloudflare.version = "0.0.2"
  writeJson(cloudflarePath, cloudflare)
  const serverPath = path.join(rootDir, "packages/server/package.json")
  const server = JSON.parse(fs.readFileSync(serverPath, "utf8"))
  delete server.scripts.typecheck
  writeJson(serverPath, server)

  const errors = checkMetadata(rootDir)
  assert.ok(errors.some((error) => error.includes("cloudflare/package.json version 0.0.2")))
  assert.ok(errors.some((error) => error.includes("@saiwork/saiwork typecheck script is missing")))
  fs.rmSync(rootDir, { recursive: true, force: true })
})

test("reports missing root lock workspace metadata", () => {
  const rootDir = makeFixture()
  const lockPath = path.join(rootDir, "package-lock.json")
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"))
  delete lock.packages["packages/server"]
  writeJson(lockPath, lock)

  assert.ok(checkMetadata(rootDir).some((error) => error.includes("missing workspace metadata for packages/server")))
  fs.rmSync(rootDir, { recursive: true, force: true })
})

test("rejects a workspace typecheck script omitted from the root gate", () => {
  const rootDir = makeFixture()
  const pluginPath = path.join(rootDir, "packages/opencode-plugin/package.json")
  const plugin = JSON.parse(fs.readFileSync(pluginPath, "utf8"))
  plugin.scripts.typecheck = "tsc --noEmit"
  writeJson(pluginPath, plugin)

  assert.ok(checkMetadata(rootDir).some((error) => error.includes("workspace typecheck set/order changed")))
  fs.rmSync(rootDir, { recursive: true, force: true })
})

test("requires release dependencies before version metadata", () => {
  const rootDir = makeFixture()
  write(
    path.join(rootDir, ".github/workflows/reusable-release.yml"),
    "run: npm run bumpVersion -- 0.0.3 --allow-same-version\nrun: npm ci --workspaces --include-workspace-root --include=optional\nrun: npm run release:check\n",
  )

  assert.ok(checkMetadata(rootDir).some((error) => error.includes("install dependencies before bumpVersion")))

  write(
    path.join(rootDir, ".github/workflows/reusable-release.yml"),
    "run: npm ci --workspaces --include-workspace-root --include=optional\nrun: npm run bumpVersion -- 0.0.3 --allow-same-version\nrun: npm run release:check\n",
  )
  write(
    path.join(rootDir, ".github/workflows/build-and-upload.yml"),
    "  windows:\n    steps:\n      - run: npm run bumpVersion -- 0.0.3 --allow-same-version\n      - run: npm ci --workspaces --include-workspace-root --include=optional\npath: packages/electron-app/release/*.exe\n",
  )
  assert.ok(checkMetadata(rootDir).some((error) => error.includes("build workflow must install dependencies before every bumpVersion")))
  fs.rmSync(rootDir, { recursive: true, force: true })
})

test("requires workspace root installation to be enabled", () => {
  const rootDir = makeFixture()
  const workflowPath = path.join(rootDir, ".github/workflows/reusable-release.yml")
  write(
    workflowPath,
    "run: npm ci --workspaces --include-workspace-root=false\nrun: npm run bumpVersion -- 0.0.3 --allow-same-version\nrun: npm run release:check\n",
  )
  assert.ok(checkMetadata(rootDir).some((error) => error.includes("reusable release workflow must install dependencies")))

  write(
    workflowPath,
    "run: npm ci --workspaces # --include-workspace-root\nrun: npm run bumpVersion -- 0.0.3 --allow-same-version\nrun: npm run release:check\n",
  )
  assert.ok(checkMetadata(rootDir).some((error) => error.includes("reusable release workflow must install dependencies")))

  write(
    workflowPath,
    "run: npm ci --workspaces --include-workspace-root --include-workspace-root=false\nrun: npm run bumpVersion -- 0.0.3 --allow-same-version\nrun: npm run release:check\n",
  )
  assert.ok(checkMetadata(rootDir).some((error) => error.includes("reusable release workflow must install dependencies")))

  write(
    workflowPath,
    "run: npm ci --workspaces --include-workspace-root --no-include-workspace-root\nrun: npm run bumpVersion -- 0.0.3 --allow-same-version\nrun: npm run release:check\n",
  )
  assert.ok(checkMetadata(rootDir).some((error) => error.includes("reusable release workflow must install dependencies")))
  fs.rmSync(rootDir, { recursive: true, force: true })
})

test("requires ZIP and portable artifacts as a versioned pair", async () => {
  const rootDir = makeFixture()
  const releaseDir = path.join(rootDir, "packages/electron-app/release")
  fs.mkdirSync(releaseDir, { recursive: true })
  const metadata = Buffer.concat([
    Buffer.from("ProductVersion", "utf16le"),
    Buffer.from(`\0${VERSION}\0`, "utf16le"),
  ])
  const portablePath = path.join(releaseDir, `SAIWORK-portable-x64-${VERSION}.exe`)
  fs.writeFileSync(portablePath, metadata)

  const errors = await checkArtifacts(rootDir)
  assert.ok(errors.some((error) => error.includes(`missing SAIWORK-x64-${VERSION}.zip`)))
  assert.deepEqual(findPeVersions(portablePath), { ProductVersion: VERSION })
  assert.equal(peVersionMatches("0.0.3.0", VERSION), true)
  assert.equal(peVersionMatches("0.0.2.0", VERSION), false)
  fs.rmSync(rootDir, { recursive: true, force: true })
})

test("fails an artifacts-only gate when no Windows artifacts exist", async () => {
  const rootDir = makeFixture()
  const errors = await checkArtifacts(rootDir, [], { required: true })
  assert.ok(errors.some((error) => error.includes("Windows artifacts are missing")))
  fs.rmSync(rootDir, { recursive: true, force: true })
})
