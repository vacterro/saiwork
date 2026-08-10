import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { saipenRestartRequired, type SaipenLaunchState } from "./core"

function launched(overrides: Partial<SaipenLaunchState> = {}): SaipenLaunchState {
  return {
    enabled: true,
    protocolDir: "/protocol/saipen",
    instructions: ["/protocol/saipen/BOOT.md", "/protocol/saipen/STYLE.md"],
    launchedAt: 1_000,
    ...overrides,
  }
}

describe("saipenRestartRequired", () => {
  it("says no when nothing is running", () => {
    // Settings changes are free until a workspace exists to be out of date.
    assert.equal(saipenRestartRequired({ enabled: true, instructions: ["a"] }, null), false)
  })

  it("says no while the settings still match the launch", () => {
    const state = launched()
    assert.equal(saipenRestartRequired({ enabled: true, instructions: [...state.instructions] }, state), false)
  })

  it("catches SAIPEN being switched off after launch", () => {
    assert.equal(saipenRestartRequired({ enabled: false, instructions: [] }, launched()), true)
  })

  it("catches SAIPEN being switched on after a workspace launched without it", () => {
    const state = launched({ enabled: false, instructions: [], protocolDir: null })
    assert.equal(saipenRestartRequired({ enabled: true, instructions: ["/protocol/saipen/BOOT.md"] }, state), true)
  })

  it("catches a changed file list", () => {
    const state = launched()
    assert.equal(
      saipenRestartRequired({ enabled: true, instructions: ["/protocol/saipen/BOOT.md"] }, state),
      true,
      "dropping STYLE.md changes what the session would receive",
    )
    assert.equal(
      saipenRestartRequired(
        { enabled: true, instructions: [...state.instructions, "/protocol/saipen/CORE.md"] },
        state,
      ),
      true,
    )
  })

  it("treats order as significant, because SAIPEN Core has to load first", () => {
    const state = launched()
    assert.equal(
      saipenRestartRequired({ enabled: true, instructions: [...state.instructions].reverse() }, state),
      true,
    )
  })

  it("catches a home change that keeps the same file count", () => {
    const state = launched()
    assert.equal(
      saipenRestartRequired(
        { enabled: true, instructions: ["/other/saipen/BOOT.md", "/other/saipen/STYLE.md"] },
        state,
      ),
      true,
    )
  })
})
