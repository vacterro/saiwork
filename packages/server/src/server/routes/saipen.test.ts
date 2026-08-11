import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "node:test"
import Fastify from "fastify"

import { getSaipenWriteQueueSize, registerSaipenRoutes } from "./saipen"

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

function createDirectoryLink(target: string, link: string): boolean {
  try {
    fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir")
    return true
  } catch {
    return false
  }
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
    assert.equal(body.revisions["STATE.md"], createHash("sha256").update(body.state).digest("hex"))
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

  it("returns LOG and empty-file revisions when STATE and BOARD are absent", async () => {
    const dir = createTempDir()
    const saipen = path.join(dir, ".saipen")
    fs.mkdirSync(saipen)
    fs.writeFileSync(path.join(saipen, "LOG.md"), "- event\n")
    const app = createApp([dir])
    const response = await app.inject({ method: "GET", url: `/api/saipen/view?folder=${encodeURIComponent(dir)}` })
    const body = response.json()
    assert.equal(body.missing, false)
    assert.match(body.log, /event/)
    assert.equal(body.revisions["STATE.md"].length, 64)
    assert.equal(body.revisions["BOARD.md"].length, 64)
    await app.close()
  })

  it("caps multilingual LOG tails and plan heads without broken UTF-8", async () => {
    const dir = createTempDir()
    const saipen = path.join(dir, ".saipen")
    const kitchen = path.join(saipen, "kitchen")
    fs.mkdirSync(kitchen, { recursive: true })
    fs.writeFileSync(path.join(saipen, "STATE.md"), "---\nphase: BUILD\n---\n")
    const multilingual = "ASCII Кириллица õäöü 日本語 😀🧭\n".repeat(5000)
    fs.writeFileSync(path.join(saipen, "LOG.md"), multilingual)
    fs.writeFileSync(path.join(kitchen, "unicode.md"), multilingual)

    const app = createApp([dir])
    const response = await app.inject({
      method: "GET",
      url: `/api/saipen/view?folder=${encodeURIComponent(dir)}`,
    })
    const body = response.json()
    assert.equal(response.statusCode, 200)
    assert.ok(Buffer.byteLength(body.log, "utf8") <= 64 * 1024)
    assert.ok(Buffer.byteLength(body.plans[0].content, "utf8") <= 32 * 1024)
    assert.equal(body.log.includes("\uFFFD"), false)
    assert.equal(body.plans[0].content.includes("\uFFFD"), false)
    assert.equal(body.plans[0].truncated, true)
    await app.close()
  })
})

describe("saipen file write route", () => {
  it("creates a missing allowlisted file against the empty-byte revision", async () => {
    const dir = createTempDir()
    const saipen = path.join(dir, ".saipen")
    fs.mkdirSync(saipen)
    fs.writeFileSync(path.join(saipen, "BOARD.md"), "## TODO\n")
    const app = createApp([dir])
    const view = await app.inject({ method: "GET", url: `/api/saipen/view?folder=${encodeURIComponent(dir)}` })
    const expectedRevision = view.json().revisions["STATE.md"]
    assert.equal(expectedRevision.length, 64)

    const response = await app.inject({
      method: "PUT",
      url: "/api/saipen/file",
      payload: { folder: dir, relativePath: "STATE.md", content: "---\nphase: BUILD\n---\n", expectedRevision },
    })
    assert.equal(response.statusCode, 200)
    assert.match(fs.readFileSync(path.join(saipen, "STATE.md"), "utf8"), /phase: BUILD/)
    await app.close()
  })

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
    assert.equal(fs.readdirSync(saipen).some((name) => name.endsWith(".saiwork-tmp")), false)
    await app.close()
  })

  it("writes a kitchen plan through the same CAS and atomic path", async () => {
    const dir = createTempDir()
    const saipen = path.join(dir, ".saipen")
    const kitchen = path.join(saipen, "kitchen")
    fs.mkdirSync(kitchen, { recursive: true })
    fs.writeFileSync(path.join(saipen, "STATE.md"), "---\nphase: BUILD\n---\n")
    fs.writeFileSync(path.join(kitchen, "plan.md"), "old\n")

    const app = createApp([dir])
    const view = await app.inject({ method: "GET", url: `/api/saipen/view?folder=${encodeURIComponent(dir)}` })
    const revision = view.json().revisions["kitchen/plan.md"]
    assert.ok(revision)
    const write = await app.inject({
      method: "PUT",
      url: "/api/saipen/file",
      payload: { folder: dir, relativePath: "kitchen/plan.md", content: "new\n", expectedRevision: revision },
    })
    assert.equal(write.statusCode, 200)
    assert.equal(fs.readFileSync(path.join(kitchen, "plan.md"), "utf8"), "new\n")
    assert.equal(fs.readdirSync(kitchen).some((name) => name.endsWith(".saiwork-tmp")), false)
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
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(getSaipenWriteQueueSize(), 0)
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

  it("rejects a traversal spelling of a registered workspace", async () => {
    const registered = createTempDir()
    fs.mkdirSync(path.join(registered, "child"))
    const traversal = `${registered}${path.sep}child${path.sep}..`
    const app = createApp([registered])
    const view = await app.inject({
      method: "GET",
      url: `/api/saipen/view?folder=${encodeURIComponent(traversal)}`,
    })
    assert.equal(view.statusCode, 403)
    await app.close()
  })

  it("rejects a noncanonical symlink/junction alias of a registered workspace", async (context) => {
    const registered = createTempDir()
    const aliasRoot = createTempDir()
    const link = path.join(aliasRoot, "alias")
    fs.mkdirSync(path.join(registered, ".saipen"))
    fs.writeFileSync(path.join(registered, ".saipen", "STATE.md"), "---\nphase: BUILD\n---\n")
    if (!createDirectoryLink(registered, link)) {
      context.skip("directory links unavailable on this host")
      return
    }

    const app = createApp([registered])
    const view = await app.inject({
      method: "GET",
      url: `/api/saipen/view?folder=${encodeURIComponent(link)}`,
    })
    assert.equal(view.statusCode, 403)
    await app.close()
  })

  it("rejects an escaping .saipen symlink/junction", async (context) => {
    const registered = createTempDir()
    const outside = createTempDir()
    fs.writeFileSync(path.join(outside, "STATE.md"), "---\nphase: BUILD\n---\n")
    if (!createDirectoryLink(outside, path.join(registered, ".saipen"))) {
      context.skip("directory links unavailable on this host")
      return
    }

    const app = createApp([registered])
    const view = await app.inject({ method: "GET", url: `/api/saipen/view?folder=${encodeURIComponent(registered)}` })
    const status = await app.inject({ method: "GET", url: `/api/saipen/status?folder=${encodeURIComponent(registered)}` })
    const write = await app.inject({
      method: "PUT",
      url: "/api/saipen/file",
      payload: { folder: registered, relativePath: "STATE.md", content: "x", expectedRevision: "r" },
    })
    assert.equal(view.statusCode, 403)
    assert.equal(status.statusCode, 403)
    assert.equal(write.statusCode, 403)
    await app.close()
  })

  it("rejects an escaping kitchen parent symlink/junction", async (context) => {
    const registered = createTempDir()
    const outside = createTempDir()
    const saipen = path.join(registered, ".saipen")
    fs.mkdirSync(saipen)
    fs.writeFileSync(path.join(saipen, "STATE.md"), "---\nphase: BUILD\n---\n")
    fs.writeFileSync(path.join(outside, "plan.md"), "outside\n")
    if (!createDirectoryLink(outside, path.join(saipen, "kitchen"))) {
      context.skip("directory links unavailable on this host")
      return
    }

    const app = createApp([registered])
    const view = await app.inject({ method: "GET", url: `/api/saipen/view?folder=${encodeURIComponent(registered)}` })
    const write = await app.inject({
      method: "PUT",
      url: "/api/saipen/file",
      payload: { folder: registered, relativePath: "kitchen/plan.md", content: "x", expectedRevision: "r" },
    })
    assert.equal(view.statusCode, 403)
    assert.equal(write.statusCode, 403)
    assert.equal(fs.readFileSync(path.join(outside, "plan.md"), "utf8"), "outside\n")
    await app.close()
  })

  it("rejects an escaping file target symlink", async (context) => {
    const registered = createTempDir()
    const outside = createTempDir()
    const saipen = path.join(registered, ".saipen")
    const outsideState = path.join(outside, "STATE.md")
    fs.mkdirSync(saipen)
    fs.writeFileSync(outsideState, "---\nphase: OUTSIDE\n---\n")
    try {
      fs.symlinkSync(outsideState, path.join(saipen, "STATE.md"), "file")
    } catch {
      context.skip("file links unavailable on this host")
      return
    }

    const app = createApp([registered])
    const view = await app.inject({ method: "GET", url: `/api/saipen/view?folder=${encodeURIComponent(registered)}` })
    const status = await app.inject({ method: "GET", url: `/api/saipen/status?folder=${encodeURIComponent(registered)}` })
    assert.equal(view.statusCode, 403)
    assert.equal(status.statusCode, 403)
    await app.close()
  })
})
