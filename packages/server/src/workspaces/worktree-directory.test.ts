import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { invalidateWorktreeDirectoryCache, resolveWorktreeDirectory } from "./worktree-directory"

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

const nullLogger = {}

function removeTreeResilient(target: string): void {
  // Windows git processes can briefly hold a handle on the temp tree; retry
  // with backoff and give up only when the assertions are already done.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
      return
    } catch {
      // Synchronous sleep (node:test forbids nothing here; a busy-wait is the
      // simplest reliable way to let the OS release the handle).
      const end = Date.now() + 100
      while (Date.now() < end) { /* wait */ }
    }
  }
}

describe("worktree directory cache invalidation", () => {
  it("invalidating after a worktree removal makes the next resolution see the current list immediately", async () => {
    const temp = mkdtempSync(path.join(tmpdir(), "saiwork-wt-cache-"))
    const repoRoot = path.join(temp, "repo")
    const wtDir = path.join(repoRoot, "wt-feature")
    try {
      initRepo(repoRoot)
      git(repoRoot, "worktree", "add", "-b", "feature", wtDir)

      // Prime the cache with the feature worktree present.
      const primed = await awaitResolve(repoRoot, "feature")
      assert.equal(path.resolve(primed ?? ""), path.resolve(wtDir), "the cache resolves the worktree")

      // Remove the worktree out from under the cache (within the 2 s TTL).
      git(repoRoot, "worktree", "remove", "--force", wtDir)
      assert.equal(existsSync(wtDir), false)

      // The stale 2 s entry still resolves without explicit invalidation,
      // proving the cache is genuinely in play here.
      const stale = await awaitResolve(repoRoot, "feature")
      assert.equal(path.resolve(stale ?? ""), path.resolve(wtDir), "the un-invalidated cache still serves the stale entry")

      // Explicit invalidation is what makes the next read authoritative.
      invalidateWorktreeDirectoryCache("ws-cache-test")

      const after = await awaitResolve(repoRoot, "feature")
      assert.equal(after, null, "after invalidation the next resolution uses the current worktree list")
    } finally {
      removeTreeResilient(temp)
    }
  })

  it("invalidation is safe for unknown workspace ids and leaves no stale entry", () => {
    // Prime + invalidate must never throw, including for ids never seen.
    invalidateWorktreeDirectoryCache("never-seen-workspace")
    invalidateWorktreeDirectoryCache("ws-cache-test")
  })
})

function awaitResolve(repoRoot: string, slug: string): Promise<string | null> {
  return resolveWorktreeDirectory({
    workspaceId: "ws-cache-test",
    workspacePath: repoRoot,
    worktreeSlug: slug,
    logger: nullLogger,
  })
}
