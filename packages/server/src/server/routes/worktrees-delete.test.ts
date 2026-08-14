import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import Fastify from "fastify"
import { registerWorktreeRoutes } from "./worktrees"

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" })
}

function initRepo(root: string): void {
  mkdirSync(root, { recursive: true })
  git(root, "init", "-b", "main")
  git(root, "config", "user.email", "test@saiwork.local")
  git(root, "config", "user.name", "SAIWORK Test")
  git(root, "config", "commit.gpgsign", "false")
  writeFileSync(path.join(root, "README.md"), "test\n")
  git(root, "add", "README.md")
  git(root, "commit", "-m", "initial")
}

function addWorktree(repoRoot: string, directory: string, branch: string): void {
  git(repoRoot, "worktree", "add", "-b", branch, directory)
}

function buildApp(workspacePath: string) {
  const workspaceManager = {
    get: (id: string) => (id === "ws" ? { path: workspacePath } : undefined),
  }
  const app = Fastify({ logger: false })
  registerWorktreeRoutes(app, {
    workspaceManager: workspaceManager as never,
    sessionMetadataPersistence: {} as never,
  })
  return app
}

function newRepo(): { temp: string; repoRoot: string; wtDir: string } {
  const temp = mkdtempSync(path.join(tmpdir(), "saiwork-worktree-delete-"))
  const repoRoot = path.join(temp, "repo")
  initRepo(repoRoot)
  const wtDir = path.join(repoRoot, "wt-feature")
  addWorktree(repoRoot, wtDir, "feature")
  return { temp, repoRoot, wtDir }
}

describe("DELETE worktree reports truthful removal state", () => {
  it("returns removed=true mappingPruned=true after a clean delete", async () => {
    const { temp, repoRoot, wtDir } = newRepo()
    try {
      const app = buildApp(repoRoot)
      const response = await app.inject({ method: "DELETE", url: "/api/workspaces/ws/worktrees/feature" })
      assert.equal(response.statusCode, 200)
      assert.deepEqual(response.json(), { removed: true, mappingPruned: true })
      assert.equal(existsSync(wtDir), false, "the worktree directory is gone")
      await app.close()
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it("reports removed=true mappingPruned=false when secondary map cleanup fails after a successful remove", async () => {
    const { temp, repoRoot, wtDir } = newRepo()
    try {
      // Corrupt the worktree map so readWorktreeMap fails closed AFTER the
      // worktree has already been removed -- the response must still admit the
      // removal succeeded.
      mkdirSync(path.join(repoRoot, ".saiwork"), { recursive: true })
      writeFileSync(path.join(repoRoot, ".saiwork", "worktreeMap.json"), "{ not valid json")

      const app = buildApp(repoRoot)
      const response = await app.inject({ method: "DELETE", url: "/api/workspaces/ws/worktrees/feature" })
      assert.equal(response.statusCode, 200)
      assert.deepEqual(response.json(), { removed: true, mappingPruned: false })
      assert.equal(existsSync(wtDir), false, "the worktree stays removed despite the cleanup failure")
      await app.close()
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it("a retry observes already-removed state without a second destructive removal", async () => {
    const { temp, repoRoot, wtDir } = newRepo()
    try {
      const app = buildApp(repoRoot)
      const first = await app.inject({ method: "DELETE", url: "/api/workspaces/ws/worktrees/feature" })
      assert.deepEqual(first.json(), { removed: true, mappingPruned: true })
      const second = await app.inject({ method: "DELETE", url: "/api/workspaces/ws/worktrees/feature" })
      assert.equal(second.statusCode, 404, "the second delete reports the worktree is already gone")
      await app.close()
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })
})
