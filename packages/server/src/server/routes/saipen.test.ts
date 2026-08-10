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

function createApp() {
  const app = Fastify({ logger: false })
  registerSaipenRoutes(app, {
    settings: { getOwner: () => undefined } as never,
    getSaipenLaunchState: () => null,
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

    const app = createApp()
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
    await app.close()
  })

  it("reports missing when the folder has no .saipen directory", async () => {
    const dir = createTempDir()
    const app = createApp()
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

    const app = createApp()
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
  it("writes an allowlisted file and it round-trips", async () => {
    const dir = createTempDir()
    const saipen = path.join(dir, ".saipen")
    fs.mkdirSync(saipen)
    fs.writeFileSync(saipen + path.sep + "STATE.md", "---\nphase: DONE\n---\n")

    const app = createApp()
    const write = await app.inject({
      method: "PUT",
      url: "/api/saipen/file",
      payload: { folder: dir, relativePath: "STATE.md", content: "---\nphase: BUILD\ntask: T-051\n---\n" },
    })
    assert.equal(write.statusCode, 200)
    assert.equal(fs.readFileSync(saipen + path.sep + "STATE.md", "utf8"), "---\nphase: BUILD\ntask: T-051\n---\n")
    await app.close()
  })

  it("refuses a traversal path", async () => {
    const dir = createTempDir()
    const app = createApp()
    const response = await app.inject({
      method: "PUT",
      url: "/api/saipen/file",
      payload: { folder: dir, relativePath: "../outside.md", content: "x" },
    })
    assert.equal(response.statusCode, 403)
    await app.close()
  })

  it("refuses a file outside the allowlist", async () => {
    const dir = createTempDir()
    const app = createApp()
    const response = await app.inject({
      method: "PUT",
      url: "/api/saipen/file",
      payload: { folder: dir, relativePath: "config.json", content: "{}" },
    })
    assert.equal(response.statusCode, 403)
    await app.close()
  })
})
