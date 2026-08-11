#!/usr/bin/env node

const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const REQUIRED_TYPECHECKS = [
  ["@saiwork/saiwork", "packages/server"],
  ["@saiwork/ui", "packages/ui"],
  ["@saiwork/electron-app", "packages/electron-app"],
]
const ELECTRON_VERSION = "38.0.0"
const ARTIFACT_INSPECTOR_DEPENDENCIES = {
  "@electron/asar": "3.4.1",
  yauzl: "2.10.0",
}

function readJson(rootDir, relativePath, errors) {
  try {
    return JSON.parse(fs.readFileSync(path.join(rootDir, relativePath), "utf8"))
  } catch (error) {
    errors.push(`${relativePath}: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

function expect(errors, condition, message) {
  if (!condition) errors.push(message)
}

function packageManifests(rootDir, errors) {
  const packagesDir = path.join(rootDir, "packages")
  let entries
  try {
    entries = fs.readdirSync(packagesDir, { withFileTypes: true })
  } catch (error) {
    errors.push(`packages: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const relativePath = `packages/${entry.name}/package.json`
      if (!fs.existsSync(path.join(rootDir, relativePath))) return null
      const json = readJson(rootDir, relativePath, errors)
      return json ? { directory: `packages/${entry.name}`, relativePath, json } : null
    })
    .filter(Boolean)
}

function interpolateArtifactName(template, values) {
  return template.replace(/\$\{(arch|version|ext)\}/g, (_, key) => values[key])
}

function artifactNamePattern(template, version, ext) {
  const tokens = template.split(/(\$\{(?:arch|version|ext)\})/g)
  const source = tokens.map((token) => {
    if (token === "${arch}") return "(?<arch>[A-Za-z0-9_-]+)"
    if (token === "${version}") return version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    if (token === "${ext}") return ext.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    return token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }).join("")
  return new RegExp(`^${source}$`)
}

function artifactFamilyPattern(template, ext) {
  const tokens = template.split(/(\$\{(?:arch|version|ext)\})/g)
  const source = tokens.map((token) => {
    if (token === "${arch}") return "[A-Za-z0-9_-]+"
    if (token === "${version}") return "[0-9A-Za-z.+-]+"
    if (token === "${ext}") return ext.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    return token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }).join("")
  return new RegExp(`^${source}$`)
}

function findPeVersions(filePath) {
  const contents = fs.readFileSync(filePath)
  const versions = {}
  for (const label of ["ProductVersion", "FileVersion"]) {
    const marker = Buffer.from(label, "utf16le")
    const offset = contents.indexOf(marker)
    if (offset < 0) continue
    const nearby = contents.subarray(offset + marker.length, offset + marker.length + 512).toString("utf16le")
    const match = nearby.match(/\d+\.\d+\.\d+(?:\.\d+)?/)
    if (match) versions[label] = match[0]
  }
  return versions
}

function peVersionMatches(actual, expected) {
  const numeric = expected.match(/^\d+\.\d+\.\d+/)?.[0]
  return Boolean(numeric && (actual === numeric || actual === `${numeric}.0`))
}

function extractZipAsar(zipPath, outputPath) {
  let yauzl
  try {
    yauzl = require("yauzl")
  } catch {
    return Promise.reject(new Error("yauzl is required to inspect ZIP metadata"))
  }

  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (openError, zip) => {
      if (openError) return reject(openError)
      let found = false
      zip.on("error", reject)
      zip.on("entry", (entry) => {
        if (!/(^|\/)resources\/app\.asar$/.test(entry.fileName)) {
          zip.readEntry()
          return
        }
        found = true
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return reject(streamError)
          const output = fs.createWriteStream(outputPath)
          stream.on("error", reject)
          output.on("error", reject)
          output.on("close", () => {
            zip.close()
            resolve()
          })
          stream.pipe(output)
        })
      })
      zip.on("end", () => {
        if (!found) reject(new Error("resources/app.asar is missing"))
      })
      zip.readEntry()
    })
  })
}

function readAsarPackage(asarPath) {
  let asar
  try {
    asar = require("@electron/asar")
  } catch {
    throw new Error("@electron/asar is required to inspect packaged metadata")
  }
  return JSON.parse(asar.extractFile(asarPath, "package.json").toString("utf8"))
}

function checkAsarVersion(asarPath, version, label, errors) {
  try {
    const packageJson = readAsarPackage(asarPath)
    expect(errors, packageJson.version === version, `${label}: embedded package version ${packageJson.version} != ${version}`)
  } catch (error) {
    errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function checkArtifacts(rootDir, errors = [], options = {}) {
  const rootPackage = readJson(rootDir, "package.json", errors)
  const electronPackage = readJson(rootDir, "packages/electron-app/package.json", errors)
  if (!rootPackage || !electronPackage) return errors

  const version = rootPackage.version
  expect(errors, electronPackage.version === version, `packages/electron-app/package.json version ${electronPackage.version} != ${version}`)

  const winTemplate = electronPackage.build?.win?.artifactName
  const portableTemplate = electronPackage.build?.portable?.artifactName
  expect(errors, typeof winTemplate === "string", "Electron Windows artifactName is missing")
  expect(errors, typeof portableTemplate === "string", "Electron portable artifactName is missing")
  if (typeof winTemplate !== "string" || typeof portableTemplate !== "string") return errors

  const targets = electronPackage.build?.win?.target?.map((target) => target.target) ?? []
  expect(errors, targets.includes("zip"), "Electron Windows targets must include zip")
  expect(errors, targets.includes("portable"), "Electron Windows targets must include portable")

  const releaseDir = path.join(rootDir, "packages", "electron-app", "release")
  if (!fs.existsSync(releaseDir)) {
    if (options.required) errors.push("packages/electron-app/release: Windows artifacts are missing")
    return errors
  }

  const entries = fs.readdirSync(releaseDir, { withFileTypes: true })
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
  const zipPattern = artifactNamePattern(winTemplate, version, "zip")
  const portablePattern = artifactNamePattern(portableTemplate, version, "exe")
  const zipFamilyPattern = artifactFamilyPattern(winTemplate, "zip")
  const portableFamilyPattern = artifactFamilyPattern(portableTemplate, "exe")
  const windowsArtifacts = files.filter((name) => zipFamilyPattern.test(name) || portableFamilyPattern.test(name))
  if (options.required && windowsArtifacts.length === 0) {
    errors.push("packages/electron-app/release: no versioned Windows ZIP/portable artifact pair found")
  }
  const arches = new Set()

  for (const name of windowsArtifacts) {
    const zipMatch = name.match(zipPattern)
    const portableMatch = name.match(portablePattern)
    if (!zipMatch && !portableMatch) {
      errors.push(`packages/electron-app/release/${name}: filename does not match current artifactName/version ${version}`)
      continue
    }
    arches.add((zipMatch || portableMatch).groups.arch)
  }

  for (const arch of arches) {
    const expectedZip = interpolateArtifactName(winTemplate, { arch, version, ext: "zip" })
    const expectedPortable = interpolateArtifactName(portableTemplate, { arch, version, ext: "exe" })
    expect(errors, files.includes(expectedZip), `release artifact pair is missing ${expectedZip}`)
    expect(errors, files.includes(expectedPortable), `release artifact pair is missing ${expectedPortable}`)
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "saiwork-release-check-"))
  try {
    for (const name of files.filter((file) => zipPattern.test(file))) {
      const asarPath = path.join(tempDir, `${name}.asar`)
      try {
        await extractZipAsar(path.join(releaseDir, name), asarPath)
        checkAsarVersion(asarPath, version, `packages/electron-app/release/${name}`, errors)
      } catch (error) {
        errors.push(`packages/electron-app/release/${name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    for (const name of files.filter((file) => portablePattern.test(file))) {
      const versions = findPeVersions(path.join(releaseDir, name))
      for (const key of ["ProductVersion", "FileVersion"]) {
        const actual = versions[key]
        expect(errors, typeof actual === "string", `packages/electron-app/release/${name}: ${key} metadata is missing`)
        if (actual) {
          expect(errors, peVersionMatches(actual, version), `packages/electron-app/release/${name}: ${key} ${actual} != ${version}`)
        }
      }
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }

  const unpackedDir = path.join(releaseDir, "win-unpacked")
  if (fs.existsSync(unpackedDir)) {
    const unpackedAsar = path.join(unpackedDir, "resources", "app.asar")
    expect(errors, fs.existsSync(unpackedAsar), "packages/electron-app/release/win-unpacked/resources/app.asar is missing")
    if (fs.existsSync(unpackedAsar)) {
      checkAsarVersion(unpackedAsar, version, "packages/electron-app/release/win-unpacked/resources/app.asar", errors)
    }
  }

  return errors
}

function checkMetadata(rootDir, errors = []) {
  const rootPackage = readJson(rootDir, "package.json", errors)
  if (!rootPackage) return errors
  const version = rootPackage.version
  expect(errors, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version), `root package version is invalid: ${version}`)

  const manifests = packageManifests(rootDir, errors)
  const saiworkManifests = manifests.filter(({ json }) => json.name?.startsWith("@saiwork/"))
  for (const manifest of saiworkManifests) {
    expect(errors, manifest.json.version === version, `${manifest.relativePath} version ${manifest.json.version ?? "missing"} != ${version}`)
  }

  const rootLock = readJson(rootDir, "package-lock.json", errors)
  if (rootLock) {
    expect(errors, rootLock.name === rootPackage.name, `package-lock.json name ${rootLock.name} != ${rootPackage.name}`)
    expect(errors, rootLock.version === version, `package-lock.json version ${rootLock.version} != ${version}`)
    expect(errors, rootLock.packages?.[""]?.version === version, `package-lock.json root package version ${rootLock.packages?.[""]?.version} != ${version}`)
    const workspacePaths = Array.isArray(rootPackage.workspaces)
      ? rootPackage.workspaces
      : rootPackage.workspaces?.packages ?? []
    for (const workspacePath of workspacePaths) {
      const manifest = saiworkManifests.find(({ directory }) => directory === workspacePath)
      expect(errors, Boolean(manifest), `workspace ${workspacePath} has no SAIWORK package manifest`)
      if (!manifest) continue
      const lockPackage = rootLock.packages?.[workspacePath]
      expect(errors, Boolean(lockPackage), `package-lock.json is missing workspace metadata for ${workspacePath}`)
      if (!lockPackage) continue
      expect(errors, lockPackage.name === manifest.json.name, `package-lock.json ${manifest.directory} name ${lockPackage.name} != ${manifest.json.name}`)
      expect(errors, lockPackage.version === version, `package-lock.json ${manifest.directory} version ${lockPackage.version} != ${version}`)
    }
  }

  for (const manifest of saiworkManifests) {
    const lockPath = `${manifest.directory}/package-lock.json`
    if (!fs.existsSync(path.join(rootDir, lockPath))) continue
    const lock = readJson(rootDir, lockPath, errors)
    if (!lock) continue
    expect(errors, lock.name === manifest.json.name, `${lockPath} name ${lock.name} != ${manifest.json.name}`)
    expect(errors, lock.version === version, `${lockPath} version ${lock.version ?? "missing"} != ${version}`)
    expect(errors, lock.packages?.[""]?.name === manifest.json.name, `${lockPath} root name ${lock.packages?.[""]?.name} != ${manifest.json.name}`)
    expect(errors, lock.packages?.[""]?.version === version, `${lockPath} root version ${lock.packages?.[""]?.version ?? "missing"} != ${version}`)
  }

  const packageByName = new Map(manifests.map((manifest) => [manifest.json.name, manifest]))
  const manifestByDirectory = new Map(manifests.map((manifest) => [manifest.directory, manifest]))
  const workspacePaths = Array.isArray(rootPackage.workspaces)
    ? rootPackage.workspaces
    : rootPackage.workspaces?.packages ?? []
  const typecheckedWorkspaces = workspacePaths
    .map((workspacePath) => manifestByDirectory.get(workspacePath))
    .filter((manifest) => typeof manifest?.json.scripts?.typecheck === "string" && manifest.json.scripts.typecheck.trim().length > 0)
  const typecheckedNames = typecheckedWorkspaces.map((manifest) => manifest.json.name)
  expect(
    errors,
    JSON.stringify(typecheckedNames) === JSON.stringify(REQUIRED_TYPECHECKS.map(([name]) => name)),
    `workspace typecheck set/order changed: ${typecheckedNames.join(" -> ")}`,
  )
  const expectedTypecheck = typecheckedNames
    .map((name) => `npm run typecheck --workspace ${name}`)
    .join(" && ")
  expect(errors, rootPackage.scripts?.typecheck === expectedTypecheck, "root typecheck must run server -> UI -> Electron without omissions")
  expect(
    errors,
    rootPackage.scripts?.["release:check"] === "npm run test:release && node ./scripts/check-release-consistency.js && npm run typecheck",
    "release:check must retain consistency tests, metadata check, and root typecheck",
  )
  for (const [name] of REQUIRED_TYPECHECKS) {
    const script = packageByName.get(name)?.json.scripts?.typecheck
    expect(errors, typeof script === "string" && script.trim().length > 0, `${name} typecheck script is missing`)
  }

  const electronPackage = packageByName.get("@saiwork/electron-app")?.json
  expect(errors, rootPackage.devDependencies?.electron === ELECTRON_VERSION, `root Electron must be exactly ${ELECTRON_VERSION}`)
  expect(errors, electronPackage?.devDependencies?.electron === ELECTRON_VERSION, `Electron app must pin Electron exactly ${ELECTRON_VERSION}`)
  for (const [name, expectedVersion] of Object.entries(ARTIFACT_INSPECTOR_DEPENDENCIES)) {
    expect(errors, rootPackage.devDependencies?.[name] === expectedVersion, `release checker dependency ${name} must be exactly ${expectedVersion}`)
  }
  if (rootLock) {
    expect(errors, rootLock.packages?.[""]?.devDependencies?.electron === ELECTRON_VERSION, `root lock Electron spec must be exactly ${ELECTRON_VERSION}`)
    expect(errors, rootLock.packages?.["packages/electron-app"]?.devDependencies?.electron === ELECTRON_VERSION, `Electron app lock spec must be exactly ${ELECTRON_VERSION}`)
    expect(errors, rootLock.packages?.["node_modules/electron"]?.version === ELECTRON_VERSION, `locked Electron package must be ${ELECTRON_VERSION}`)
    for (const [name, expectedVersion] of Object.entries(ARTIFACT_INSPECTOR_DEPENDENCIES)) {
      expect(errors, rootLock.packages?.[""]?.devDependencies?.[name] === expectedVersion, `root lock release checker spec ${name} must be ${expectedVersion}`)
      expect(errors, rootLock.packages?.[`node_modules/${name}`]?.version === expectedVersion, `locked release checker package ${name} must be ${expectedVersion}`)
    }
  }

  const cargoToml = fs.readFileSync(path.join(rootDir, "packages/tauri-app/src-tauri/Cargo.toml"), "utf8")
  const cargoLock = fs.readFileSync(path.join(rootDir, "packages/tauri-app/Cargo.lock"), "utf8")
  const tauriConfig = readJson(rootDir, "packages/tauri-app/src-tauri/tauri.conf.json", errors)
  expect(errors, /\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m.exec(cargoToml)?.[1] === version, `Tauri Cargo.toml version != ${version}`)
  expect(errors, /\[\[package\]\]\s*\r?\nname = "saiwork-tauri"\s*\r?\nversion = "([^"]+)"/.exec(cargoLock)?.[1] === version, `Tauri Cargo.lock version != ${version}`)
  expect(errors, tauriConfig?.version === version, `tauri.conf.json version ${tauriConfig?.version} != ${version}`)

  const readme = fs.readFileSync(path.join(rootDir, "README.md"), "utf8")
  const changelog = fs.readFileSync(path.join(rootDir, "CHANGELOG.md"), "utf8")
  expect(errors, /\*\*Version ([^*]+)\*\*/.exec(readme)?.[1] === version, `README current version != ${version}`)
  expect(errors, /^## \[?([^\]\s]+)\]?/m.exec(changelog)?.[1] === version, `CHANGELOG current version != ${version}`)
  if (electronPackage?.build?.win?.artifactName && electronPackage?.build?.portable?.artifactName) {
    const expectedZip = interpolateArtifactName(electronPackage.build.win.artifactName, { arch: "x64", version, ext: "zip" })
    const expectedPortable = interpolateArtifactName(electronPackage.build.portable.artifactName, { arch: "x64", version, ext: "exe" })
    expect(errors, readme.includes(`\`${expectedZip}\``), `README must name artifact ${expectedZip}`)
    expect(errors, readme.includes(`\`${expectedPortable}\``), `README must name artifact ${expectedPortable}`)
  }

  const releaseWorkflow = fs.readFileSync(path.join(rootDir, ".github/workflows/release.yml"), "utf8")
  const reusableWorkflow = fs.readFileSync(path.join(rootDir, ".github/workflows/reusable-release.yml"), "utf8")
  const releaseUiWorkflow = fs.readFileSync(path.join(rootDir, ".github/workflows/release-ui.yml"), "utf8")
  const npmPublishWorkflow = fs.readFileSync(path.join(rootDir, ".github/workflows/manual-npm-publish.yml"), "utf8")
  const prWorkflow = fs.readFileSync(path.join(rootDir, ".github/workflows/pr-build.yml"), "utf8")
  const buildWorkflow = fs.readFileSync(path.join(rootDir, ".github/workflows/build-and-upload.yml"), "utf8")
  expect(errors, /branches:\s*\r?\n\s*- saiwork\b/.test(releaseWorkflow), "release workflow must trigger from default branch saiwork")
  expect(errors, reusableWorkflow.includes("npm run release:check"), "reusable release workflow must run release:check")
  expect(errors, releaseUiWorkflow.includes("npm run release:check"), "UI release workflow must run release:check")
  expect(errors, npmPublishWorkflow.includes("npm run release:check"), "npm publish workflow must run release:check")
  expect(errors, prWorkflow.includes("npm run release:check"), "PR workflow must run release:check")
  expect(errors, buildWorkflow.includes("packages/electron-app/release/*.exe"), "Windows workflow must retain portable EXE artifact coverage")

  return errors
}

async function checkRepository(rootDir, options = {}) {
  const errors = []
  if (options.metadata !== false) checkMetadata(rootDir, errors)
  if (options.artifacts !== false) await checkArtifacts(rootDir, errors, { required: options.requireArtifacts === true })
  return errors
}

async function main() {
  const artifactsOnly = process.argv.includes("--artifacts-only")
  const errors = await checkRepository(path.resolve(__dirname, ".."), {
    metadata: !artifactsOnly,
    artifacts: true,
    requireArtifacts: artifactsOnly,
  })
  if (errors.length > 0) {
    console.error(`[release:check] FAIL (${errors.length})`)
    for (const error of errors) console.error(`- ${error}`)
    process.exitCode = 1
    return
  }
  console.log(`[release:check] PASS${artifactsOnly ? " artifacts" : " metadata and artifacts"}`)
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[release:check] FAIL: ${error instanceof Error ? error.stack : String(error)}`)
    process.exitCode = 1
  })
}

module.exports = {
  checkArtifacts,
  checkMetadata,
  checkRepository,
  findPeVersions,
  interpolateArtifactName,
  peVersionMatches,
}
