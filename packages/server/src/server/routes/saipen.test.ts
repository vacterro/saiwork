import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "node:test"
import Fastify from "fastify"

import { registerSaipenRoutes } from "./saipen"

const tempDirs = new Set<string>()

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  tempDirs.clear()
})

function createTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "saiwork-saipen-test-"))
  tempDirs.add(dir)
  return dir
}

function createApp(workspaces: string[] = []) {
  const app = Fastify({ logger: false })
  registerSaipenRoutes(app, {
    settings: { getOwner: () => undefined } as never,
    getSaipenLaunchState: () => null,
    workspaceManager: {
      list: () => workspaces.map((workspace) => ({
        id: `ws-${workspace}`,
        path: workspace,
        status: "ready" as const,
        proxyPath: `/proxy/${workspace}`,
        binaryId: "opencode",
        binaryLabel: "opencode",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })),
    },
  })
  return app
}

describe("saipen view route", () => {
  it("returns the allowlisted .saipen files with a capped log tail", async () => {
    const dir = createTempDir()
    const saipen = path.join(dir, ".saipen")
    fs.mkdirSync(saipen)
    fs.writeFileSync(saipen + path.sep + "STATE.md", '---\nphase: BUILD\ntask: T-051\nnext_action: "PHASE VERIFY T-051"\n---\n')
    fs.writeFileSync(saipen + path.sep + "BOARD.md", "## DOING\n\n- [/] T-051 Work\n")
    fs.writeFileSync(saipen + path.sep + "LOG.md", "- 08.08.26 23:00 [E-900] one\n- 08.08.26 23:01 [E-901] two\n")
    const kitchen = path.join(saipen, "kitchen")
    fs.mkdirSync(kitchen)
    fs.writeFileSync(path.join(kitchen, "plan-a.md"), "# Plan A\n\nDo the thing.\n")

    const app = createApp([dir])
    const response = await app.inject({
      method: "GET",
      url: `/api/saipen/view?folder=${encodeURIComponent(dir)}`,
    })

    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.missing, false)
    assert.match(body.state, /phase: BUILD/)
    assert.match(body.board, /T-051/)
    assert.match(body.log, /E-901/)
    assert.equal(body.logTruncated, false)
    assert.deepEqual(body.plans.map((plan: { name: string }) => plan.name), ["plan-a.md"])
    assert.match(body.plans[0].content, /# Plan A/)
    assert.equal(typeof body.revisions["STATE.md"], "string")
    assert.ok(body.revisions["STATE.md"].length > 0)
    assert.ok(body.revisions["BOARD.md"].length > 0)
    assert.ok(body.revisions["LOG.md"].length > 0)
    await app.close()
  })

  it("returns BOARD.md parsed into canonical sections, section-aware", async () => {
    const dir = createTempDir()
    const saipen = path.join(dir, ".saipen")
    fs.mkdirSync(saipen)
    fs.writeFileSync(saipen + path.sep + "STATE.md", "---\nphase: SCOUT\n---\n")
    fs.writeFileSync(saipen + path.sep + "BOARD.md", "## TODO\n- [ ] T-001 queued\n\n## BLOCKED\n- [ ] T-003 stuck\n\n## DONE\n- [x] T-004 shipped\n")

    const app = createApp([dir])
    const response = await app.inject({
      method: "GET",
      url: `/api/saipen/view?folder=${encodeURIComponent(dir)}`,
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    const byId = new Map(
      (body.boardSections as Array<{ title: string; tickets: Array<{ id: string; status: string }> }>)
        .flatMap((section) => section.tickets.map((ticket) => [ticket.id, ticket.status])),
    )
    assert.equal(byId.get("T-001"), "todo")
    // Section wins over checkbox: `- [ ]` under BLOCKED is blocked, not "todo".
    assert.equal(byId.get("T-003"), "blocked")
    assert.equal(byId.get("T-004"), "done")
    await app.close()
  })

  it("reports missing when the folder has no .saipen directory", async () => {
    const dir = createTempDir()
    const app = createApp([dir])
    const response = await app.inject({
      method: "GET",
      url: `/api/saipen/view?folder=${encodeURIComponent(dir)}`,
    })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().missing, true)
    await app.close()
  })

  it("caps the log tail and says so", async () => {
    const dir = createTempDir()
    const saipen = path.join(dir, ".saipen")
    fs.mkdirSync(saipen)
    fs.writeFileSync(saipen + path.sep + "STATE.md", "---\nphase: BUILD\n---\n")
    const lines = Array.from({ length: 500 }, (_, i) => `- 08.08.26 23:00 [E-${1000 + i}] line ${i}`)
    fs.writeFileSync(saipen + path.sep + "LOG.md", lines.join("\n") + "\n")

    const app = createApp([dir])
    const response = await app.inject({
      method: "GET",
      url: `/api/saipen/view?folder=${encodeURIComponent(dir)}`,
    })
    const body = response.json()
    assert.equal(body.logTruncated, true)
    assert.equal(body.log.split("\n").length, 200)
    await app.close()
  })
})

describe("saipen file write route", () => {
  it("writes an allowlisted file against its revision and round-trips", async () => {
    const dir = createTempDir()
    const saipen = path.join(dir, ".saipen")
    fs.mkdirSync(saipen)
    const original = "---\nphase: DONE\n---\n"
    fs.writeFileSync(saipen + path.sep + "STATE.md", original)

    const app = createApp([dir])
    const view = await app.inject({ method: "GET", url: `/api/saipen/view?folder=${encodeURIComponent(dir)}` })
    const body = view.json()
    const revision = body.revisions["STATE.md"]

    const write = await app.inject({
      method: "PUT",
      url: "/api/saipen/file",
      payload: {
        folder: dir,
        relativePath: "STATE.md",
        content: "---\nphase: BUILD\ntask: T-051\n---\n",
        expectedRevision: revision,
      },
    })
    assert.equal(write.statusCode, 200)
    const result = write.json()
    assert.equal(result.ok, true)
    assert.notEqual(result.revision, revision)
    assert.equal(fs.readFileSync(saipen + path.sep + "STATE.md", "utf8"), "---\nphase: BUILD\ntask: T-051\n---\n")
    await app.close()
  })

  it("refuses to overwrite a file that changed since the client last read it", async () => {
    const dir = createTempDir()
    const saipen = path.join(dir, ".saipen")
    fs.mkdirSync(saipen)
    fs.writeFileSync(saipen + path.sep + "STATE.md", "---\nphase: DONE\n---\n")

    const app = createApp([dir])
    const response = await app.inject({
      method: "PUT",
      url: "/api/saipen/file",
      payload: {
        folder: dir,
        relativePath: "STATE.md",
        content: "---\nphase: BUILD\n---\n",
        expectedRevision: "stale-revision",
      },
    })
    assert.equal(response.statusCode, 409)
    assert.match(response.json().error, /changed externally/)
    assert.ok(response.json().currentRevision.length > 0)
    // The newer on-disk content is untouched.
    assert.equal(fs.readFileSync(saipen + path.sep + "STATE.md", "utf8"), "---\nphase: DONE\n---\n")
    await app.close()
  })

  it("serializes concurrent writes to the same .saipen root", async () => {
    const dir = createTempDir()
    const saipen = path.join(dir, ".saipen")
    fs.mkdirSync(saipen)
    fs.writeFileSync(saipen + path.sep + "STATE.md", "---\nphase: DONE\n---\n")

    const app = createApp([dir])
    const view = await app.inject({ method: "GET", url: `/api/saipen/view?folder=${encodeURIComponent(dir)}` })
    const revision = view.json().revisions["STATE.md"]

    const write = async (content: string) => app.inject({
      method: "PUT",
      url: "/api/saipen/file",
      payload: { folder: dir, relativePath: "STATE.md", content, expectedRevision: revision },
    })
    const [a, b] = await Promise.all([write("---\nphase: A\n---\n"), write("---\nphase: B\n---\n")])
    assert.equal(a.statusCode, 200)
    assert.equal(b.statusCode, 409)
    const onDisk = fs.readFileSync(saipen + path.sep + "STATE.md", "utf8")
    assert.ok(onDisk === "---\nphase: A\n---\n" || onDisk === "---\nphase: B\n---\n")
    await app.close()
  })

  it("refuses a traversal path", async () => {
    const dir = createTempDir()
    const app = createApp([dir])
    const response = await app.inject({
      method: "PUT",
      url: "/api/saipen/file",
      payload: { folder: dir, relativePath: "../outside.md", content: "x", expectedRevision: "r" },
    })
    assert.equal(response.statusCode, 403)
    await app.close()
  })

  it("refuses a file outside the allowlist", async () => {
    const dir = createTempDir()
    const app = createApp([dir])
    const response = await app.inject({
      method: "PUT",
      url: "/api/saipen/file",
      payload: { folder: dir, relativePath: "config.json", content: "{}", expectedRevision: "r" },
    })
    assert.equal(response.statusCode, 403)
    await app.close()
  })

  it("treats LOG.md as read-only", async () => {
    const dir = createTempDir()
    const saipen = path.join(dir, ".saipen")
    fs.mkdirSync(saipen)
    const log = "- 08.08.26 23:00 [E-900] one\n"
    fs.writeFileSync(saipen + path.sep + "LOG.md", log)

    const app = createApp([dir])
    const response = await app.inject({
      method: "PUT",
      url: "/api/saipen/file",
      payload: { folder: dir, relativePath: "LOG.md", content: "clobbered\n", expectedRevision: "r" },
    })
    assert.equal(response.statusCode, 403)
    assert.equal(fs.readFileSync(saipen + path.sep + "LOG.md", "utf8"), log)
    await app.close()
  })
})

describe("saipen workspace boundary", () => {
  it("rejects a folder that is not a registered workspace", async () => {
    const registered = createTempDir()
    const rogue = createTempDir()
    fs.mkdirSync(path.join(rogue, ".saipen"))
    fs.writeFileSync(path.join(rogue, ".saipen", "STATE.md"), "---\nphase: BUILD\n---\n")

    const app = createApp([registered])
    const view = await app.inject({
      method: "GET",
      url: `/api/saipen/view?folder=${encodeURIComponent(rogue)}`,
    })
    assert.equal(view.statusCode, 403)

    const write = await app.inject({
      method: "PUT",
      url: "/api/saipen/file",
      payload: { folder: rogue, relativePath: "STATE.md", content: "---\nphase: DONE\n---\n", expectedRevision: "r" },
    })
    assert.equal(write.statusCode, 403)

    const status = await app.inject({
      method: "GET",
      url: `/api/saipen/status?folder=${encodeURIComponent(rogue)}`,
    })
    assert.equal(status.statusCode, 403)
    await app.close()
  })

  it("rejects a symlink/junction that points outside the registry", { skip: process.platform === "win32" }, async () => {
    const registered = createTempDir()
    const outside = createTempDir()
    const link = path.join(path.dirname(registered), "saiwork-link-outside")
    fs.mkdirSync(path.join(registered, ".saipen"))
    fs.writeFileSync(path.join(registered, ".saipen", "STATE.md"), "---\nphase: BUILD\n---\n")
    fs.symlinkSync(outside, link, "junction")

    const app = createApp([registered])
    const view = await app.inject({
      method: "GET",
      url: `/api/saipen/view?folder=${encodeURIComponent(link)}`,
    })
    assert.equal(view.statusCode, 403)
    await app.close()
  })
})
