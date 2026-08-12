import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "node:test"

import { readSaipenHomeFromProjectState, readSaipenProjectState, readSaipenSubStates, resolveSaipenCore } from "./core"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("resolveSaipenCore instruction paths", () => {
  it("allows nested protocol files but rejects absolute, parent, and symlink escapes", (context) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "saiwork-saipen-core-"))
    roots.push(root)
    const home = path.join(root, "home")
    const protocol = path.join(home, "saipen")
    const nested = path.join(protocol, "guides")
    const outside = path.join(root, "outside")
    mkdirSync(nested, { recursive: true })
    mkdirSync(outside)
    writeFileSync(path.join(protocol, "BOOT.md"), "# BOOT\n")
    writeFileSync(path.join(nested, "GUIDE.md"), "# Guide\n")
    const outsideFile = path.join(outside, "SECRET.md")
    writeFileSync(outsideFile, "outside\n")

    try {
      symlinkSync(outside, path.join(protocol, "escape"), process.platform === "win32" ? "junction" : "dir")
    } catch {
      context.skip("directory links unavailable on this host")
      return
    }

    const resolution = resolveSaipenCore({
      enabled: true,
      home,
      files: ["guides/GUIDE.md", outsideFile, "../outside/SECRET.md", "escape/SECRET.md"],
      extraInstructions: [outsideFile],
    })

    assert.equal(resolution.error, null)
    assert.deepEqual(resolution.instructions, [
      path.join(protocol, "guides", "GUIDE.md").replace(/\\/g, "/"),
      outsideFile.replace(/\\/g, "/"),
    ])
    assert.equal(resolution.missing.length, 3)
    assert.equal(resolution.instructions.filter((entry) => entry === outsideFile.replace(/\\/g, "/")).length, 1)
  })

  it("accepts an absolute existing extraInstructions file on the host semantics", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "saiwork-saipen-extra-"))
    roots.push(root)
    const home = path.join(root, "home")
    const protocol = path.join(home, "saipen")
    mkdirSync(protocol, { recursive: true })
    writeFileSync(path.join(protocol, "BOOT.md"), "# BOOT\n")
    const extraFile = path.join(root, "extra.md")
    writeFileSync(extraFile, "# Extra\n")

    const resolution = resolveSaipenCore({
      enabled: true,
      home,
      extraInstructions: [extraFile],
    })
    assert.equal(resolution.error, null)
    assert.equal(resolution.rejected.length, 0)
    assert.ok(resolution.instructions.some((entry) => entry === extraFile.replace(/\\/g, "/")))
  })

  it("rejects relative extraInstructions values outright (no cwd-dependent resolution)", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "saiwork-saipen-extra-"))
    roots.push(root)
    const home = path.join(root, "home")
    const protocol = path.join(home, "saipen")
    mkdirSync(protocol, { recursive: true })
    writeFileSync(path.join(protocol, "BOOT.md"), "# BOOT\n")

    const resolution = resolveSaipenCore({
      enabled: true,
      home,
      extraInstructions: ["./file.md", "../file.md", "file.md"],
    })
    assert.equal(resolution.error, null)
    assert.deepEqual(resolution.rejected, ["./file.md", "../file.md", "file.md"])
    assert.ok(resolution.instructions.every((entry) => !entry.endsWith("file.md")))
  })

  it("rejects a directory and a missing absolute path as extraInstructions", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "saiwork-saipen-extra-"))
    roots.push(root)
    const home = path.join(root, "home")
    const protocol = path.join(home, "saipen")
    mkdirSync(protocol, { recursive: true })
    writeFileSync(path.join(protocol, "BOOT.md"), "# BOOT\n")
    const directory = path.join(root, "notes")
    mkdirSync(directory)

    const resolution = resolveSaipenCore({
      enabled: true,
      home,
      extraInstructions: [directory, path.join(root, "absent.md")],
    })
    assert.equal(resolution.error, null)
    assert.deepEqual(resolution.rejected, [directory, path.join(root, "absent.md")])
  })
})

describe("readSaipenProjectState", () => {
  it("counts open board work and reads stop gates", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "saiwork-saipen-"))
    roots.push(root)
    const memory = path.join(root, ".saipen")
    mkdirSync(memory)
    writeFileSync(path.join(memory, "STATE.md"), "---\nphase: BUILD\nnext_action: \"WAIT: user brake -- inspect\"\n---\n")
    writeFileSync(
      path.join(memory, "BOARD.md"),
      "## DOING\n- [/] T-001 Work\n## TODO\n- [ ] T-002 Next\n- [ ] T-003 Later\n## DONE\n- [x] T-004 Done\n## BLOCKED\n- [ ] T-005 Stuck\n",
    )

    assert.deepEqual(readSaipenProjectState(root), {
      phase: "BUILD",
      nextAction: "WAIT: user brake -- inspect",
      todoCount: 2,
      doingCount: 1,
      blockedCount: 1,
    })
  })

  it("does not count checked-off tickets under TODO as open work", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "saiwork-saipen-"))
    roots.push(root)
    const memory = path.join(root, ".saipen")
    mkdirSync(memory)
    writeFileSync(path.join(memory, "STATE.md"), "---\nphase: BUILD\nnext_action: \"PHASE BUILD\"\n---\n")
    writeFileSync(
      path.join(memory, "BOARD.md"),
      "## TODO\n- [ ] T-002 Real next\n- [x] T-003 Finished but not moved\n## DONE\n- [x] T-004 Done\n",
    )

    // The checked `[x]` under TODO is not actionable: Goal Auto must not keep
    // sending continue against it.
    const state = readSaipenProjectState(root)!
    assert.equal(state.todoCount, 1)
    assert.equal(state.doingCount, 0)
  })

  it("returns null without complete project memory", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "saiwork-saipen-"))
    roots.push(root)
    assert.equal(readSaipenProjectState(root), null)
  })

  it("reads the current canonical fixture regardless of body prose", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "saiwork-saipen-"))
    roots.push(root)
    const memory = path.join(root, ".saipen")
    mkdirSync(memory)
    writeFileSync(
      path.join(memory, "STATE.md"),
      `---
phase: DONE
task: none
next_action: "PHASE HUNT"
blocker: none
transition_from: SHIP
saipen_home: "V:\\\\___VAC\\\\__K\\\\__CODE\\\\_AI_STUFF_AGENTIC\\\\_SAIPEN"
updated: 2026-08-10T23:22:18Z
---

Notes below must never redefine state.
phase: BUILD
next_action: "PHASE BUILD T-086"
`,
    )
    writeFileSync(path.join(memory, "BOARD.md"), "## TODO\n- [ ] T-001 Next\n")

    assert.deepEqual(readSaipenProjectState(root), {
      phase: "DONE",
      nextAction: "PHASE HUNT",
      todoCount: 1,
      doingCount: 0,
      blockedCount: 0,
    })
    assert.equal(
      readSaipenHomeFromProjectState(root),
      "V:\\___VAC\\__K\\__CODE\\_AI_STUFF_AGENTIC\\_SAIPEN",
    )
  })
})

function createSubsRoot(names: string[]): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "saiwork-subs-"))
  roots.push(root)
  const subs = path.join(root, ".saipen", "extensions", "subs")
  mkdirSync(subs, { recursive: true })
  writeFileSync(
    path.join(subs, "MANIFEST.md"),
    `# SubSaipen Manifest\n\n${names.map((name) => `- ${name} -- .saipen/extensions/subs/${name}/`).join("\n")}\n`,
  )
  return root
}

function writeSubState(root: string, name: string, phase = "SCOUT", body = "") {
  const directory = path.join(root, ".saipen", "extensions", "subs", name)
  mkdirSync(path.join(directory, "kitchen"), { recursive: true })
  writeFileSync(
    path.join(directory, "STATE.md"),
    `---\nphase: ${phase}\ntask: TEST-001\nnext_action: "PHASE ${phase} TEST-001"\nblocker: ${phase === "BLOCKED" ? "waiting for evidence" : "none"}\nagent: ${name}\nrole_revision: sha256:current\nupdated: 2026-08-08T12:00:00Z\n${body}---\n`,
  )
  writeFileSync(path.join(directory, "kitchen", "OUTBOX.md"), "# OUTBOX\n")
}

function writeOutbox(root: string, name: string, content: string) {
  const kitchen = path.join(root, ".saipen", "extensions", "subs", name, "kitchen")
  mkdirSync(kitchen, { recursive: true })
  writeFileSync(path.join(kitchen, "OUTBOX.md"), `# OUTBOX\n\n${content}`)
}

function packageEntry(name: string, status: string, roleRevision = "sha256:current"): string {
  const complete = status === "ready"
    ? `- **producer:** ${name}\n- **source_head:** no-git\n- **source_tree_fingerprint:** no-git-tree-v1:abc\n- **role_revision:** ${roleRevision}\n- **coverage:** all\n- **payload:** report\n- **verified:** PASS\n- **instructions:**\n  1. review\n`
    : ""
  return `## TEST-001: result\n- **status:** ${status}\n${complete}`
}

describe("readSaipenSubStates", () => {
  it("reports every manifest lifecycle instead of omitting missing or malformed state", () => {
    const root = createSubsRoot(["active", "blocked", "done", "missing", "malformed"])
    writeSubState(root, "active")
    writeSubState(root, "blocked", "BLOCKED")
    writeSubState(root, "done", "DONE")
    writeSubState(root, "malformed", "BUILD")

    assert.deepEqual(
      readSaipenSubStates(root).map((sub) => [sub.name, sub.lifecycle]),
      [
        ["active", "active"],
        ["blocked", "blocked"],
        ["done", "done"],
        ["malformed", "malformed"],
        ["missing", "missing"],
      ],
    )
  })

  it("marks a sub state with duplicate scalars malformed", () => {
    const root = createSubsRoot(["dup"])
    const directory = path.join(root, ".saipen", "extensions", "subs", "dup")
    mkdirSync(path.join(directory, "kitchen"), { recursive: true })
    writeFileSync(
      path.join(directory, "STATE.md"),
      `---\nphase: SCOUT\nphase: DONE\ntask: TEST-001\nnext_action: "PHASE SCOUT TEST-001"\nblocker: none\nagent: dup\nrole_revision: sha256:current\nupdated: 2026-08-08T12:00:00Z\n---\n`,
    )
    writeFileSync(path.join(directory, "kitchen", "OUTBOX.md"), "# OUTBOX\n")

    const sub = readSaipenSubStates(root).find((entry) => entry.name === "dup")
    assert.ok(sub)
    assert.equal(sub.lifecycle, "malformed")
    assert.equal(sub.phase, "SCOUT")
    assert.ok(sub.issues.some((issue) => issue.includes("Duplicate scalar phase")))
  })

  it("reports every OUTBOX package verdict and detects stale role evidence", () => {
    const names = ["none", "ready", "draft", "blocked", "reviewed", "stale", "missing", "malformed", "role-stale"]
    const root = createSubsRoot(names)
    for (const name of names) writeSubState(root, name)
    writeOutbox(root, "ready", packageEntry("ready", "ready"))
    writeOutbox(root, "draft", packageEntry("draft", "draft"))
    writeOutbox(root, "blocked", packageEntry("blocked", "blocked"))
    writeOutbox(root, "reviewed", packageEntry("reviewed", "reviewed"))
    writeOutbox(root, "stale", packageEntry("stale", "stale"))
    rmSync(path.join(root, ".saipen", "extensions", "subs", "missing", "kitchen", "OUTBOX.md"))
    writeOutbox(root, "malformed", packageEntry("malformed", "unknown"))
    writeOutbox(root, "role-stale", packageEntry("role-stale", "ready", "sha256:old"))

    assert.deepEqual(
      Object.fromEntries(readSaipenSubStates(root).map((sub) => [sub.name, sub.packageStatus])),
      {
        blocked: "blocked",
        draft: "draft",
        malformed: "malformed",
        missing: "missing",
        none: "none",
        ready: "ready",
        reviewed: "reviewed",
        "role-stale": "stale",
        stale: "stale",
      },
    )
  })

  it("marks incomplete ready packages malformed", () => {
    const root = createSubsRoot(["incomplete"])
    writeSubState(root, "incomplete")
    writeOutbox(root, "incomplete", "## TEST-001: result\n- **status:** ready\n")

    const [sub] = readSaipenSubStates(root)
    assert.equal(sub.packageStatus, "malformed")
    assert.match(sub.issues.join(" "), /freshness evidence/)
  })

  it("does not treat package detail headings as separate entries", () => {
    const root = createSubsRoot(["details"])
    writeSubState(root, "details")
    writeOutbox(root, "details", `${packageEntry("details", "ready")}\n## Evidence\nMore detail\n`)

    assert.equal(readSaipenSubStates(root)[0].packageStatus, "ready")
  })
})
