import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"

import {
  capturePidIdentity,
  orphanRegistryPath,
  readOrphanRegistry,
  sweepOrphanProcesses,
  writeOrphanRegistry,
  type OrphanEntry,
} from "./orphan-cleanup"
import type { ProcessSnapshot } from "./process-identity"

function identity(pid: number, startTime: string) {
  return { pid, parentPid: 1, groupId: pid, startTime }
}

function snapshotWith(...entries: ReturnType<typeof identity>[]): ProcessSnapshot {
  return { ok: true, processes: new Map(entries.map((entry) => [entry.pid, entry])) }
}

function neverSignals(): { ok: boolean; signalSent: boolean } {
  return { ok: true, signalSent: true }
}

describe("orphan workspace cleanup", () => {
  it("round-trips the registry file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "saiwork-orphan-"))
    const file = path.join(dir, "workspace-pids.json")
    const entry: OrphanEntry = { workspaceId: "ws-1", pid: 42, startTime: "638000000000000000", folder: "C:/proj", launchedAt: 1 }
    writeOrphanRegistry(file, [entry])
    assert.deepEqual(readOrphanRegistry(file), [entry])
    writeOrphanRegistry(file, [])
    assert.deepEqual(readOrphanRegistry(file), [])
    assert.deepEqual(readOrphanRegistry(path.join(dir, "missing.json")), [])
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("signals only orphans whose identity still matches", () => {
    const alive: string[] = []
    const entries: OrphanEntry[] = [
      { workspaceId: "ws-live", pid: 11, startTime: "A", folder: "C:/a", launchedAt: 1 },
      { workspaceId: "ws-recycled", pid: 22, startTime: "OLD", folder: "C:/b", launchedAt: 1 },
      { workspaceId: "ws-gone", pid: 33, startTime: "C", folder: "C:/c", launchedAt: 1 },
    ]
    const result = sweepOrphanProcesses(entries, {
      platform: "win32",
      probe: () => snapshotWith(identity(11, "A"), identity(22, "NEW")),
      signal: (_spawn, request) => {
        alive.push(request.leader!.pid.toString())
        return neverSignals()
      },
    })
    assert.deepEqual(result.terminated, ["ws-live"])
    // Recycled pid is untouched; missing process is skipped entirely.
    assert.deepEqual(alive, ["11"])
    assert.deepEqual(result.failed, [])
  })

  it("reports probe failure without touching anything", () => {
    const result = sweepOrphanProcesses(
      [{ workspaceId: "ws-1", pid: 11, startTime: "A", folder: "C:/a", launchedAt: 1 }],
      { platform: "win32", probe: () => ({ ok: false, error: "probe exploded" }) },
    )
    assert.equal(result.terminated.length, 0)
    assert.equal(result.failed.length, 1)
    assert.match(result.failed[0]!.error, /probe exploded/)
  })

  it("captures a pid identity from the process table", () => {
    const startTime = capturePidIdentity(11, {
      platform: "win32",
      probe: () => snapshotWith(identity(11, "START-A")),
    })
    assert.equal(startTime, "START-A")
    const missing = capturePidIdentity(99, { platform: "win32", probe: () => snapshotWith() })
    assert.equal(missing, null)
  })

  it("resolves the registry path under the saiwork config dir", () => {
    assert.equal(orphanRegistryPath("C:/base"), path.join("C:/base", "workspace-pids.json"))
  })
})
