import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "node:test"
import type { WorkspaceEventPayload } from "../api-types"
import { EventBus } from "../events/bus"
import { SaipenFileWatcher, SAIPEN_CHANGED_EVENT } from "./file-watcher"

const tempDirs = new Set<string>()
const watchers: SaipenFileWatcher[] = []

afterEach(() => {
  for (const watcher of watchers) watcher.stop()
  watchers.length = 0
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
  tempDirs.clear()
})

function createTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "saiwork-saipen-watch-"))
  tempDirs.add(dir)
  return dir
}

function createWatcher(folder: string) {
  const eventBus = new EventBus()
  const events: WorkspaceEventPayload[] = []
  eventBus.on(SAIPEN_CHANGED_EVENT, (event) => events.push(event))
  const watcher = new SaipenFileWatcher({ eventBus, logger: { debug() {}, warn() {}, error() {} } as never })
  watchers.push(watcher)
  return { eventBus, events, watcher }
}

function waitForEvents(events: WorkspaceEventPayload[], count: number, timeoutMs = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (events.length >= count) {
        clearInterval(timer)
        resolve()
        return
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error(`Timed out waiting for ${count} events; got ${events.length}`))
      }
    }, 20)
  })
}

function settle(ms = 500): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function canonical(folder: string): string {
  return path.normalize(fs.realpathSync(folder))
}

describe("saipen file watcher", () => {
  it("tracks create, change, and delete for STATE, BOARD, LOG, and kitchen files", async () => {
    const dir = createTempDir()
    const saipen = path.join(dir, ".saipen")
    const kitchen = path.join(saipen, "kitchen")
    fs.mkdirSync(kitchen, { recursive: true })

    const { events, watcher } = createWatcher(dir)
    watcher.start(() => [{ id: "ws-1", folder: dir }])
    const files = ["STATE.md", "BOARD.md", "LOG.md"]
    const writeAll = (content: string) => {
      for (const name of files) fs.writeFileSync(path.join(saipen, name), `${name} ${content}\n`)
      fs.writeFileSync(path.join(kitchen, "plan.md"), `plan ${content}\n`)
    }
    const expected = ["STATE.md", "BOARD.md", "LOG.md", "kitchen/plan.md"]

    writeAll("created")
    await waitForEvents(events, 1)
    assert.deepEqual((events[0] as Extract<WorkspaceEventPayload, { type: "saipen.changed" }>).files, expected)

    writeAll("changed")
    await waitForEvents(events, 2)
    assert.deepEqual((events[1] as Extract<WorkspaceEventPayload, { type: "saipen.changed" }>).files, expected)

    for (const name of files) fs.rmSync(path.join(saipen, name))
    fs.rmSync(path.join(kitchen, "plan.md"))
    await waitForEvents(events, 3)
    assert.deepEqual((events[2] as Extract<WorkspaceEventPayload, { type: "saipen.changed" }>).files, expected)
  })

  it("publishes saipen.changed when a watched .saipen file changes", async () => {
    const dir = createTempDir()
    const saipen = path.join(dir, ".saipen")
    fs.mkdirSync(saipen)
    fs.writeFileSync(path.join(saipen, "STATE.md"), "---\nphase: DONE\n---\n")

    const { events, watcher } = createWatcher(dir)
    watcher.start(() => [{ id: "ws-1", folder: dir }])

    fs.writeFileSync(path.join(saipen, "STATE.md"), "---\nphase: BUILD\n---\n")
    await waitForEvents(events, 1)

    const event = events[0] as Extract<WorkspaceEventPayload, { type: "saipen.changed" }>
    assert.equal(event.type, "saipen.changed")
    assert.equal(event.folder, canonical(dir))
    assert.deepEqual(event.files, ["STATE.md"])
  })

  it("does not re-emit when the content is unchanged", async () => {
    const dir = createTempDir()
    const saipen = path.join(dir, ".saipen")
    fs.mkdirSync(saipen)
    fs.writeFileSync(path.join(saipen, "STATE.md"), "---\nphase: DONE\n---\n")

    const { events, watcher } = createWatcher(dir)
    watcher.start(() => [{ id: "ws-1", folder: dir }])

    fs.writeFileSync(path.join(saipen, "STATE.md"), "---\nphase: BUILD\n---\n")
    await waitForEvents(events, 1)

    fs.writeFileSync(path.join(saipen, "STATE.md"), "---\nphase: BUILD\n---\n")
    await settle()
    assert.equal(events.length, 1)
  })

  it("coalesces a burst of writes into a single event", async () => {
    const dir = createTempDir()
    const saipen = path.join(dir, ".saipen")
    fs.mkdirSync(saipen)
    fs.writeFileSync(path.join(saipen, "BOARD.md"), "## TODO\n")

    const { events, watcher } = createWatcher(dir)
    watcher.start(() => [{ id: "ws-1", folder: dir }])

    for (let index = 0; index < 5; index += 1) {
      fs.writeFileSync(path.join(saipen, "BOARD.md"), `## TODO\n- [ ] T-00${index} burst\n`)
    }
    await waitForEvents(events, 1)
    await settle()
    assert.equal(events.length, 1)
    const event = events[0] as Extract<WorkspaceEventPayload, { type: "saipen.changed" }>
    assert.deepEqual(event.files, ["BOARD.md"])
  })

  it("tracks kitchen plan files and their deletion", async () => {
    const dir = createTempDir()
    const saipen = path.join(dir, ".saipen")
    const kitchen = path.join(saipen, "kitchen")
    fs.mkdirSync(kitchen, { recursive: true })

    const { events, watcher } = createWatcher(dir)
    watcher.start(() => [{ id: "ws-1", folder: dir }])

    fs.writeFileSync(path.join(kitchen, "plan-a.md"), "# Plan A\n")
    await waitForEvents(events, 1)
    let event = events[0] as Extract<WorkspaceEventPayload, { type: "saipen.changed" }>
    assert.deepEqual(event.files, ["kitchen/plan-a.md"])

    fs.rmSync(path.join(kitchen, "plan-a.md"))
    await waitForEvents(events, 2)
    event = events[1] as Extract<WorkspaceEventPayload, { type: "saipen.changed" }>
    assert.deepEqual(event.files, ["kitchen/plan-a.md"])
  })

  it("emits when the .saipen directory appears for a workspace that had none", async () => {
    const dir = createTempDir()

    const { events, watcher } = createWatcher(dir)
    watcher.start(() => [{ id: "ws-1", folder: dir }])

    const saipen = path.join(dir, ".saipen")
    fs.mkdirSync(saipen)
    fs.writeFileSync(path.join(saipen, "STATE.md"), "---\nphase: SCOUT\n---\n")
    await waitForEvents(events, 1)

    const event = events[0] as Extract<WorkspaceEventPayload, { type: "saipen.changed" }>
    assert.ok(event.files.includes("STATE.md"))
  })

  it("keeps watching when the .saipen directory disappears and reappears", async () => {
    const dir = createTempDir()
    const saipen = path.join(dir, ".saipen")
    fs.mkdirSync(saipen)
    fs.writeFileSync(path.join(saipen, "STATE.md"), "---\nphase: DONE\n---\n")
    const { events, watcher } = createWatcher(dir)
    watcher.start(() => [{ id: "ws-1", folder: dir }])

    fs.rmSync(saipen, { recursive: true, force: true })
    await waitForEvents(events, 1)
    assert.ok((events[0] as Extract<WorkspaceEventPayload, { type: "saipen.changed" }>).files.includes("STATE.md"))

    fs.mkdirSync(saipen)
    fs.writeFileSync(path.join(saipen, "STATE.md"), "---\nphase: BUILD\n---\n")
    await waitForEvents(events, 2)
    assert.ok((events[1] as Extract<WorkspaceEventPayload, { type: "saipen.changed" }>).files.includes("STATE.md"))
  })

  it("stops watching a workspace after workspace.stopped", async () => {
    const dir = createTempDir()
    const saipen = path.join(dir, ".saipen")
    fs.mkdirSync(saipen)
    fs.writeFileSync(path.join(saipen, "STATE.md"), "---\nphase: DONE\n---\n")

    const { eventBus, events, watcher } = createWatcher(dir)
    watcher.start(() => [{ id: "ws-1", folder: dir }])

    eventBus.publish({ type: "workspace.stopped", workspaceId: "ws-1", reason: "stopped" })
    fs.writeFileSync(path.join(saipen, "STATE.md"), "---\nphase: HUNT\n---\n")
    await settle()
    assert.equal(events.length, 0)
  })

  it("keeps a shared-folder watcher until every registered workspace ID stops", async () => {
    const dir = createTempDir()
    const saipen = path.join(dir, ".saipen")
    fs.mkdirSync(saipen)
    fs.writeFileSync(path.join(saipen, "STATE.md"), "---\nphase: DONE\n---\n")

    const { eventBus, events, watcher } = createWatcher(dir)
    watcher.start(() => [
      { id: "ws-1", folder: dir },
      { id: "ws-2", folder: dir },
    ])

    eventBus.publish({ type: "workspace.stopped", workspaceId: "ws-1", reason: "stopped" })
    fs.writeFileSync(path.join(saipen, "STATE.md"), "---\nphase: BUILD\n---\n")
    await waitForEvents(events, 1)

    eventBus.publish({ type: "workspace.stopped", workspaceId: "ws-2", reason: "stopped" })
    fs.writeFileSync(path.join(saipen, "STATE.md"), "---\nphase: SHIP\n---\n")
    await settle()
    assert.equal(events.length, 1)
  })

  it("ignores a stopped event for a workspace it never watched", async () => {
    const dir = createTempDir()
    const { eventBus, events, watcher } = createWatcher(dir)
    watcher.start(() => [{ id: "ws-1", folder: dir }])
    eventBus.publish({ type: "workspace.stopped", workspaceId: "unknown", reason: "stopped" })
    await settle()
    assert.equal(events.length, 0)
  })

  it("picks up workspaces started after the watcher starts", async () => {
    const dir = createTempDir()
    const saipen = path.join(dir, ".saipen")
    fs.mkdirSync(saipen)
    fs.writeFileSync(path.join(saipen, "STATE.md"), "---\nphase: DONE\n---\n")

    const { eventBus, events, watcher } = createWatcher(dir)
    watcher.start(() => [])

    eventBus.publish({
      type: "workspace.started",
      workspace: {
        id: "ws-2",
        path: dir,
        status: "ready",
        proxyPath: "/proxy/ws-2",
        binaryId: "opencode",
        binaryLabel: "opencode",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    })
    fs.writeFileSync(path.join(saipen, "STATE.md"), "---\nphase: VERIFY\n---\n")
    await waitForEvents(events, 1)
    const event = events[0] as Extract<WorkspaceEventPayload, { type: "saipen.changed" }>
    assert.equal(event.folder, canonical(dir))
  })

  it("stops publishing after watcher.stop()", async () => {
    const dir = createTempDir()
    const saipen = path.join(dir, ".saipen")
    fs.mkdirSync(saipen)
    fs.writeFileSync(path.join(saipen, "STATE.md"), "---\nphase: DONE\n---\n")

    const { events, watcher } = createWatcher(dir)
    watcher.start(() => [{ id: "ws-1", folder: dir }])
    watcher.start(() => [{ id: "duplicate-start", folder: dir }])
    fs.writeFileSync(path.join(saipen, "STATE.md"), "---\nphase: REVIEW\n---\n")
    await settle(25)
    watcher.stop()

    fs.writeFileSync(path.join(saipen, "STATE.md"), "---\nphase: SHIP\n---\n")
    await settle()
    assert.equal(events.length, 0)
  })
})
