import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { ClientStateManager, type ClientStateWriter } from "./client-state"

function harness(t: test.TestContext, initial?: object) {
  const directory = mkdtempSync(join(tmpdir(), "saiwork-state-"))
  const statePath = join(directory, "client-state.json")
  if (initial) writeFileSync(statePath, JSON.stringify(initial))
  let failing = false
  let writes = 0
  const managers: ClientStateManager[] = []
  const create = (writer: ClientStateWriter = async (path, value) => {
    writes++
    if (failing) throw new Error("injected write failure")
    await writeFile(path, value, "utf8")
  }, processOwner?: { pid: number; runToken: string; processStartIdentity: string }) => {
    const manager = new ClientStateManager(directory, writer, { crossHostElectionDirectory: join(directory, "election"), processOwner })
    managers.push(manager)
    return manager
  }
  t.after(async () => {
    await Promise.all(managers.map((manager) => manager.drainAndReleasePrimary().catch(() => {})))
    rmSync(directory, { recursive: true, force: true })
  })
  return { create, directory, statePath, fail: (value: boolean) => { failing = value }, writes: () => writes }
}

test("renderer access is exclusive per document and resettable", async (t) => {
  const manager = harness(t, { version: 1, restoreEnabled: true }).create()
  assert.throws(() => manager.claimClientStateAccess(""), /nonempty string/)
  assert.throws(() => manager.assertRendererAccessToken("unclaimed"), /has not been claimed/)
  assert.equal(manager.claimClientStateAccess("document-1"), true)
  assert.equal(manager.claimClientStateAccess("document-1"), true)
  assert.throws(() => manager.claimClientStateAccess("document-2"), /does not match/)
  manager.assertRendererAccessToken("document-1")
  assert.equal(await manager.saveClientState({ saved: true }), true)
  manager.resetRendererAccessToken()
  assert.throws(() => manager.assertRendererAccessToken("document-1"), /has not been claimed/)
  assert.equal(manager.claimClientStateAccess("document-2"), true)
})

test("renderer rotation preserves admitted write order and rejects stale new writes", async (t) => {
  let started!: () => void
  let release!: () => void
  const began = new Promise<void>((resolve) => { started = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const h = harness(t)
  const manager = h.create(async (path, value) => {
    started()
    await gate
    await writeFile(path, value, "utf8")
  })
  manager.claimClientStateAccess("outgoing")
  const save = manager.saveClientState({ revision: 1 }, "outgoing")
  await began
  manager.resetRendererAccessToken()
  assert.throws(() => manager.saveClientState({ stale: true }, "outgoing"), /has not been claimed/)
  assert.equal(manager.claimClientStateAccess("incoming"), true)
  const incoming = manager.saveClientState({ revision: 2 }, "incoming")
  release()
  assert.equal(await save, true)
  assert.equal(await incoming, true)
  assert.deepEqual(manager.loadClientState().snapshot, { revision: 2 })
})

test("failed admitted write cannot block a replacement renderer", async (t) => {
  let attempts = 0
  const manager = harness(t).create(async (path, value) => {
    if (++attempts === 1) throw new Error("injected outgoing failure")
    await writeFile(path, value, "utf8")
  })
  manager.claimClientStateAccess("outgoing")
  const failed = manager.saveClientState({ stale: true }, "outgoing")
  manager.resetRendererAccessToken()
  manager.claimClientStateAccess("incoming")
  const replacement = manager.saveClientState({ current: true }, "incoming")

  await assert.rejects(failed, /injected outgoing failure/)
  assert.equal(await replacement, true)
  assert.deepEqual(manager.loadClientState().snapshot, { current: true })
})

test("restore defaults on unless explicitly disabled", (t) => {
  assert.equal(harness(t).create().loadClientState().restoreEnabled, true)
  assert.equal(harness(t, { version: 1 }).create().loadClientState().restoreEnabled, true)
  assert.equal(harness(t, { version: 1, restoreEnabled: true }).create().loadClientState().restoreEnabled, true)
  assert.equal(harness(t, { version: 1, restoreEnabled: false }).create().loadClientState().restoreEnabled, false)
})

test("async startup publishes no identity-less ownership before lookup resolves", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "saiwork-state-async-"))
  const election = join(directory, "election")
  let resolveIdentity!: (identity: string) => void
  const identity = new Promise<string>((resolve) => { resolveIdentity = resolve })
  const manager = new ClientStateManager(directory, undefined, {
    crossHostElectionDirectory: election,
    processStartIdentityAsync: async () => identity,
  })
  t.after(async () => {
    await manager.drainAndReleasePrimary().catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  })

  assert.equal(manager.isPrimary, false)
  assert.equal(existsSync(election), false)
  resolveIdentity("async-start")
  await manager.whenReady()
  assert.equal(manager.isPrimary, true)
  assert.equal(existsSync(join(election, "primary.owner.json", "owner.json")), true)
})

test("async startup retries an unavailable process identity", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "saiwork-state-async-retry-"))
  const election = join(directory, "election")
  let attempts = 0
  const manager = new ClientStateManager(directory, undefined, {
    crossHostElectionDirectory: election,
    processStartIdentityAsync: async () => ++attempts === 1 ? undefined : "retry-start",
    processStartIdentityRetryMs: 1,
  })
  t.after(async () => {
    await manager.drainAndReleasePrimary().catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  })

  await manager.whenReady()
  assert.equal(attempts, 2)
  assert.equal(manager.isPrimary, true)
})

test("async startup becomes a safe secondary after bounded identity failures", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "saiwork-state-async-unavailable-"))
  const election = join(directory, "election")
  let attempts = 0
  const manager = new ClientStateManager(directory, undefined, {
    crossHostElectionDirectory: election,
    processStartIdentityAsync: async () => { attempts += 1; return undefined },
    processStartIdentityRetryMs: 1,
    processStartIdentityMaxAttempts: 2,
  })
  t.after(() => rmSync(directory, { recursive: true, force: true }))

  await manager.whenReady()
  assert.equal(attempts, 2)
  assert.equal(manager.isPrimary, false)
  assert.deepEqual(manager.loadClientState(), { isPrimary: false, restoreEnabled: false, snapshot: null })
  assert.equal(existsSync(election), false)
})

test("shutdown during async startup prevents late ownership registration", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "saiwork-state-async-stop-"))
  const election = join(directory, "election")
  let resolveIdentity!: (identity: string) => void
  const identity = new Promise<string>((resolve) => { resolveIdentity = resolve })
  const manager = new ClientStateManager(directory, undefined, {
    crossHostElectionDirectory: election,
    processStartIdentityAsync: async () => identity,
  })
  t.after(() => rmSync(directory, { recursive: true, force: true }))

  await manager.drainAndReleasePrimary()
  resolveIdentity("too-late")
  await manager.whenReady()
  assert.equal(manager.isPrimary, false)
  assert.equal(existsSync(election), false)
})

test("shutdown preparation prevents late ownership registration", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "saiwork-state-async-prepare-stop-"))
  const election = join(directory, "election")
  let resolveIdentity!: (identity: string) => void
  const identity = new Promise<string>((resolve) => { resolveIdentity = resolve })
  const manager = new ClientStateManager(directory, undefined, {
    crossHostElectionDirectory: election,
    processStartIdentityAsync: async () => identity,
  })
  t.after(async () => {
    await manager.drainAndReleasePrimary().catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  })

  manager.stopOwnershipInitialization()
  resolveIdentity("too-late")
  await manager.whenReady()
  assert.equal(manager.isPrimary, false)
  assert.equal(existsSync(election), false)
})

test("CodeNomad cohort and SAIWORK restore through isolated state namespaces", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "saiwork-product-isolation-"))
  const codeElection = join(root, ".codenomad", "client-state", "election")
  const saiElection = join(root, ".saiwork", "client-state", "election")
  const identities = new Map([[8201, "code-primary"], [8202, "code-secondary"], [8203, "saiwork-primary"]])
  const dependencies = {
    pidAlive: (pid: number) => identities.has(pid),
    processStartIdentity: (pid: number) => identities.get(pid),
  }
  const create = (userData: string, election: string, pid: number, runToken: string) => new ClientStateManager(userData, undefined, {
    crossHostElectionDirectory: election,
    crossHostDependencies: dependencies,
    processOwner: { pid, runToken, processStartIdentity: identities.get(pid)! },
  })
  const codePrimary = create(join(root, "code-one"), codeElection, 8201, "code-one")
  const codeSecondary = create(join(root, "code-two"), codeElection, 8202, "code-two")
  const saiwork = create(join(root, "saiwork"), saiElection, 8203, "saiwork")
  t.after(async () => {
    await Promise.all([codePrimary, codeSecondary, saiwork].map((manager) => manager.drainAndReleasePrimary().catch(() => {})))
    rmSync(root, { recursive: true, force: true })
  })

  assert.equal(codePrimary.isPrimary, true)
  assert.deepEqual(codeSecondary.loadClientState(), { isPrimary: false, restoreEnabled: false, snapshot: null })
  assert.equal(saiwork.isPrimary, true)
  assert.equal(codePrimary.loadClientState().restoreEnabled, true)
  assert.equal(saiwork.loadClientState().restoreEnabled, true)

  await codePrimary.saveClientState({ product: "codenomad" })
  await saiwork.saveClientState({ product: "saiwork" })
  assert.deepEqual(JSON.parse(readFileSync(join(root, ".codenomad", "client-state", "client-state.json"), "utf8")).snapshot, { product: "codenomad" })
  assert.deepEqual(JSON.parse(readFileSync(join(root, ".saiwork", "client-state", "client-state.json"), "utf8")).snapshot, { product: "saiwork" })
})

test("cross-host ownership is required in addition to each host-local election", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "saiwork-cross-host-state-"))
  const electronDirectory = join(root, "electron"), tauriDirectory = join(root, "tauri"), election = join(root, "election")
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const identities = new Map([[8101, "tauri-start"], [8102, "electron-start"], [8103, "successor-start"]])
  const crossHostDependencies = { pidAlive: (pid: number) => identities.has(pid), processStartIdentity: (pid: number) => identities.get(pid) }
  const primary = new ClientStateManager(tauriDirectory, undefined, {
    crossHostElectionDirectory: election,
    crossHostDependencies,
    processOwner: { pid: 8101, runToken: "tauri", processStartIdentity: "tauri-start" },
  })
  mkdirSync(electronDirectory)
  writeFileSync(join(electronDirectory, "client-state.json"), JSON.stringify({
    version: 1,
    restoreEnabled: true,
    snapshot: { tabs: ["must-not-restore"] },
  }))
  const secondary = new ClientStateManager(electronDirectory, undefined, {
    crossHostElectionDirectory: election,
    crossHostDependencies,
    processOwner: { pid: 8102, runToken: "electron", processStartIdentity: "electron-start" },
  })
  assert.deepEqual(secondary.loadClientState(), { isPrimary: false, restoreEnabled: false, snapshot: null })
  await secondary.drainAndReleasePrimary()

  await primary.drainAndReleasePrimary()
  identities.delete(8101); identities.delete(8102)
  const successor = new ClientStateManager(electronDirectory, undefined, {
    crossHostElectionDirectory: election,
    crossHostDependencies,
    processOwner: { pid: 8103, runToken: "successor", processStartIdentity: "successor-start" },
  })
  assert.equal(successor.isPrimary, true)
  await successor.drainAndReleasePrimary()
})

test("first shared primary deterministically migrates legacy host envelopes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "saiwork-migration-"))
  const electron = join(root, "electron"), tauri = join(root, "tauri"), election = join(root, "shared", "election")
  mkdirSync(electron, { recursive: true }); mkdirSync(tauri, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(electron, "client-state.json"), JSON.stringify({ version: 1, restoreEnabled: true, snapshot: { revision: 999, savedAt: 10, host: "electron" } }))
  writeFileSync(join(tauri, "client-state.json"), JSON.stringify({
    version: 1,
    restoreEnabled: true,
    snapshot: { savedAt: 20, host: "tauri" },
    window: { bounds: { x: 10, y: 10, width: 1000, height: 700 }, maximized: false, fullscreen: false, zoomFactor: 1 },
  }))
  const manager = new ClientStateManager(electron, undefined, { crossHostElectionDirectory: election, legacyTauriDataPath: tauri })
  assert.deepEqual(manager.loadClientState().snapshot, { savedAt: 20, host: "tauri" })
  assert.equal(manager.getWindowState(), undefined)
  assert.equal(existsSync(join(electron, "client-state.json")), false)
  assert.equal(existsSync(join(tauri, "client-state.json")), false)
  await manager.drainAndReleasePrimary()
})

test("legacy migration prefers disabled and ignores malformed candidates", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "saiwork-migration-"))
  const electron = join(root, "electron"), tauri = join(root, "tauri"), election = join(root, "shared", "election")
  mkdirSync(electron, { recursive: true }); mkdirSync(tauri, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(electron, "client-state.json"), "malformed")
  writeFileSync(join(tauri, "client-state.json"), JSON.stringify({ version: 1, restoreEnabled: false, snapshot: { savedAt: 1 } }))
  const manager = new ClientStateManager(electron, undefined, { crossHostElectionDirectory: election, legacyTauriDataPath: tauri })
  assert.deepEqual(manager.loadClientState(), { isPrimary: true, restoreEnabled: false, snapshot: null })
  assert.equal(JSON.parse(readFileSync(join(root, "shared", "client-state.json"), "utf8")).restoreEnabled, false)
  await manager.drainAndReleasePrimary()
})

test("legacy migration does not resurrect a snapshot after clear", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "saiwork-migration-"))
  const electron = join(root, "electron"), tauri = join(root, "tauri"), election = join(root, "shared", "election")
  mkdirSync(electron, { recursive: true }); mkdirSync(tauri, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(electron, "client-state.json"), JSON.stringify({ version: 1, restoreEnabled: true }))
  writeFileSync(join(tauri, "client-state.json"), JSON.stringify({ version: 1, restoreEnabled: true, snapshot: { savedAt: 20 } }))
  const manager = new ClientStateManager(electron, undefined, { crossHostElectionDirectory: election, legacyTauriDataPath: tauri })
  assert.equal(manager.loadClientState().snapshot, null)
  await manager.drainAndReleasePrimary()
})

test("legacy cleanup failure cannot abort startup after shared state replacement", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "saiwork-migration-"))
  const electron = join(root, "electron"), shared = join(root, "shared"), election = join(shared, "election")
  mkdirSync(electron, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(electron, "client-state.json"), JSON.stringify({ version: 1, restoreEnabled: true, snapshot: { savedAt: 10 } }))

  const manager = new ClientStateManager(electron, undefined, {
    crossHostElectionDirectory: election,
    removeLegacyState: () => { throw new Error("injected cleanup failure") },
  })
  assert.deepEqual(manager.loadClientState().snapshot, { savedAt: 10 })
  assert.equal(existsSync(join(shared, "client-state.json")), true)
  await manager.drainAndReleasePrimary()
})

test("ownership loss immediately disables restore reads and mutations", async (t) => {
  const h = harness(t, {
    version: 1,
    restoreEnabled: true,
    snapshot: { tabs: ["must-stop"] },
    window: { width: 900, height: 700 },
  })
  const manager = h.create()
  writeFileSync(join(h.directory, "election", "primary.owner.json", "owner.json"), "malformed")
  assert.equal(manager.isPrimary, false)
  assert.deepEqual(manager.loadClientState(), { isPrimary: false, restoreEnabled: false, snapshot: null })
  assert.equal(manager.getWindowState(), undefined)
  assert.equal(await manager.saveClientState({ ignored: true }), false)
})

test("failed preference and clear writes roll memory and suppression back", async (t) => {
  const h = harness(t, { version: 1, restoreEnabled: true })
  const manager = h.create()
  await manager.saveClientState({ kept: true })
  h.fail(true)
  await assert.rejects(manager.setRestoreEnabled(false), /injected write failure/)
  assert.deepEqual(manager.loadClientState(), { isPrimary: true, restoreEnabled: true, snapshot: { kept: true } })
  assert.equal(JSON.parse(readFileSync(h.statePath, "utf8")).restoreEnabled, true)
  await assert.rejects(manager.clearClientState(), /injected write failure/)
  h.fail(false)
  await manager.setRestoreEnabled(true)
  const before = h.writes()
  await manager.saveClientState({ replacement: true })
  assert.equal(h.writes(), before + 1)
  assert.deepEqual(manager.loadClientState().snapshot, { replacement: true })
})

test("successful clear suppresses saves, including after failed re-enable", async (t) => {
  const h = harness(t, { version: 1, restoreEnabled: true })
  const manager = h.create()
  await manager.saveClientState({ kept: true })
  await manager.clearClientState()
  h.fail(true)
  await assert.rejects(manager.setRestoreEnabled(true), /injected write failure/)
  const before = h.writes()
  assert.equal(await manager.saveClientState({ ignored: true }), true)
  assert.equal(h.writes(), before)
  assert.equal(manager.loadClientState().snapshot, null)
})

test("disabling restore atomically removes snapshot/window and survives restart", async (t) => {
  const h = harness(t, { version: 1, restoreEnabled: true })
  const manager = h.create(undefined, { pid: process.pid, runToken: "before-restart", processStartIdentity: "old-start" })
  await manager.saveClientState({ kept: true })
  await manager.saveWindowState({ bounds: { x: 10, y: 20, width: 1200, height: 800 }, maximized: true, fullscreen: false, zoomFactor: 1.25 })
  const before = h.writes()
  assert.equal(await manager.setRestoreEnabled(false), true)
  assert.equal(h.writes(), before + 1)
  assert.deepEqual(manager.loadClientState(), { isPrimary: true, restoreEnabled: false, snapshot: null })
  assert.equal(manager.getWindowState(), undefined)
  const disabled = JSON.stringify({ version: 1, restoreEnabled: false })
  assert.equal(readFileSync(h.statePath, "utf8"), disabled)
  await manager.drainAndReleasePrimary()
  const restarted = h.create()
  assert.equal(await restarted.saveWindowState({ bounds: { x: 0, y: 0, width: 800, height: 600 }, maximized: false, fullscreen: false, zoomFactor: 1 }), true)
  assert.equal(readFileSync(h.statePath, "utf8"), disabled)
})

test("drain freezes mutations and waits for admitted writes", async (t) => {
  const h = harness(t, { version: 1, restoreEnabled: true })
  let started!: () => void
  let release!: () => void
  const began = new Promise<void>((resolve) => { started = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const manager = h.create(async (path, value) => { await writeFile(path, value); started(); await gate })
  const admitted = manager.saveClientState({ admitted: true })
  await began
  let settled = false
  const drain = manager.drainAndReleasePrimary().finally(() => { settled = true })
  await assert.rejects(manager.saveClientState({ late: true }), /frozen for shutdown/)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, false)
  assert.equal(manager.isPrimary, true)
  release()
  await Promise.all([admitted, drain])
  assert.equal(manager.isPrimary, false)
  assert.deepEqual(JSON.parse(readFileSync(h.statePath, "utf8")).snapshot, { admitted: true })
})

test("an old writer cannot replace a successor after PID reuse", async (t) => {
  const h = harness(t, { version: 1, restoreEnabled: true })
  let started!: () => void
  let release!: () => void
  const began = new Promise<void>((resolve) => { started = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const old = h.create(
    async (path, value) => { await writeFile(path, value); started(); await gate },
    { pid: process.pid, runToken: "old-run", processStartIdentity: "old-start" },
  )
  const staleWrite = old.saveClientState({ stale: true })
  await began
  const oldDrain = old.drainAndReleasePrimary()
  const successor = h.create()
  assert.equal(successor.isPrimary, true)
  await successor.saveClientState({ successor: true })
  release()
  await assert.rejects(staleWrite, /ownership changed before atomic replacement/)
  await assert.rejects(oldDrain, /ownership changed before atomic replacement/)
  assert.deepEqual(JSON.parse(readFileSync(h.statePath, "utf8")).snapshot, { successor: true })
})

test("future envelopes are preserved until a successful explicit clear", async (t) => {
  const future = { version: 7, restoreEnabled: false, snapshot: { future: true }, futurePreference: "keep" }
  const h = harness(t, future)
  const manager = h.create(undefined, { pid: process.pid, runToken: "future-before-restart", processStartIdentity: "old-start" })
  assert.deepEqual(manager.loadClientState(), { isPrimary: true, restoreEnabled: false, snapshot: null })
  assert.equal(await manager.saveClientState({ ignored: true }), true)
  assert.equal(await manager.setRestoreEnabled(false), false)
  assert.deepEqual(JSON.parse(readFileSync(h.statePath, "utf8")), future)
  await manager.drainAndReleasePrimary()
  const restarted = h.create()
  assert.deepEqual(JSON.parse(readFileSync(h.statePath, "utf8")), future)
  assert.equal(await restarted.clearClientState(), true)
  assert.deepEqual(JSON.parse(readFileSync(h.statePath, "utf8")), { version: 1, restoreEnabled: false })
  assert.equal(await restarted.saveClientState({ supported: true }), true)
  assert.deepEqual(JSON.parse(readFileSync(h.statePath, "utf8")).snapshot, { supported: true })
})

test("failed future-envelope clear leaves persistence blocked", async (t) => {
  const future = { version: 7, future: true }
  const h = harness(t, future)
  let writes = 0
  const manager = h.create(async () => { writes++; throw new Error("clear failed") })
  await assert.rejects(manager.clearClientState(), /clear failed/)
  assert.equal(await manager.setRestoreEnabled(false), false)
  assert.equal(await manager.saveClientState({ ignored: true }), true)
  assert.equal(writes, 1)
  assert.deepEqual(JSON.parse(readFileSync(h.statePath, "utf8")), future)
})
