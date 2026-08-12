import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "node:test"

import { instructionDigests, saipenRestartRequired, type SaipenLaunchState } from "./core"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Creates a protocol dir with two real instruction files and a matching launch state. */
function makeFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "saiwork-restart-"))
  roots.push(root)
  const protocol = path.join(root, "saipen")
  mkdirSync(protocol)
  const boot = path.join(protocol, "BOOT.md")
  const style = path.join(protocol, "STYLE.md")
  writeFileSync(boot, "# BOOT content A\n")
  writeFileSync(style, "# STYLE content A\n")
  const instructions = [boot, style]
  const state: SaipenLaunchState = {
    enabled: true,
    protocolDir: protocol,
    instructions,
    instructionDigests: instructionDigests(instructions),
    launchedAt: 1_000,
  }
  return { root, protocol, boot, style, state }
}

describe("saipenRestartRequired", () => {
  it("says no when nothing is running", () => {
    assert.equal(saipenRestartRequired({ enabled: true, instructions: ["a"] }, null), false)
  })

  it("says no while the settings still match the launch", () => {
    const { state } = makeFixture()
    assert.equal(saipenRestartRequired({ enabled: true, instructions: [...state.instructions] }, state), false)
  })

  it("catches SAIPEN being switched off after launch", () => {
    const { state } = makeFixture()
    assert.equal(saipenRestartRequired({ enabled: false, instructions: [] }, state), true)
  })

  it("catches SAIPEN being switched on after a workspace launched without it", () => {
    const state: SaipenLaunchState = {
      enabled: false,
      protocolDir: null,
      instructions: [],
      instructionDigests: {},
      launchedAt: 1_000,
    }
    assert.equal(saipenRestartRequired({ enabled: true, instructions: ["/protocol/saipen/BOOT.md"] }, state), true)
  })

  it("catches a changed file list", () => {
    const { state, boot } = makeFixture()
    assert.equal(saipenRestartRequired({ enabled: true, instructions: [boot] }, state), true)
  })

  it("treats order as significant, because SAIPEN Core has to load first", () => {
    const { state } = makeFixture()
    assert.equal(
      saipenRestartRequired({ enabled: true, instructions: [...state.instructions].reverse() }, state),
      true,
    )
  })

  it("catches a home change that keeps the same file count", () => {
    const { state } = makeFixture()
    assert.equal(
      saipenRestartRequired(
        { enabled: true, instructions: ["/other/saipen/BOOT.md", "/other/saipen/STYLE.md"] },
        state,
      ),
      true,
    )
  })

  it("detects SAME-PATH content drift of an instruction file (live-core proof, conservative)", () => {
    const { state, boot } = makeFixture()
    // The running OpenCode process was launched with content A; the file now
    // holds content B on the SAME path. OpenCode never re-reads instructions,
    // so this drift needs a restart.
    writeFileSync(boot, "# BOOT content B\n")
    assert.equal(saipenRestartRequired({ enabled: true, instructions: [...state.instructions] }, state), true)
  })

  it("reports no drift when the same-path content is unchanged", () => {
    const { state } = makeFixture()
    writeFileSync(state.instructions[0], "# BOOT content A\n")
    assert.equal(saipenRestartRequired({ enabled: true, instructions: [...state.instructions] }, state), false)
  })
})
