import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const saipenModulesDir = path.join(here, "..", "saipen")
const saipenRoutes = path.join(here, "..", "server", "routes", "saipen.ts")

// SAIPEN may run one-shot commands (auto-update runs `git pull` via execFile),
// but it must never spawn a second managed runtime or fork a child process.
const RUNTIME_SPAWN = /child_process\.spawn|child_process\.fork|spawnSync|fork\(|spawn\([^)]*opencode/i

describe("SAIPEN runs inside the single managed runtime", () => {
  it("never spawns a second runtime (embedded SAIPENVIEW is file+event only)", () => {
    const sources = [readFileSync(saipenRoutes, "utf8")]
    for (const name of readdirSync(saipenModulesDir)) {
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue
      sources.push(readFileSync(path.join(saipenModulesDir, name), "utf8"))
    }
    for (let index = 0; index < sources.length; index += 1) {
      assert.doesNotMatch(sources[index], RUNTIME_SPAWN, `SAIPEN module ${index} must not spawn a runtime`)
    }
  })

  it("the runtime smoke shows exactly one managed child per workspace", async () => {
    const runtimePath = path.join(here, "..", "workspaces", "runtime.ts")
    const runtime = readFileSync(runtimePath, "utf8")
    // The managed runtime is the single spawn site (one OpenCode child per
    // workspace); SAIPEN adds none.
    assert.match(runtime, /from "child_process"/)
    assert.match(runtime, /spawnProcess\(/)
  })
})
