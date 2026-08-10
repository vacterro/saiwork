import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { listWorktrees } from "../git-worktrees"

/**
 * These run against a real repository rather than a fake `git` on PATH.
 *
 * The previous version wrote a `git.cmd` shim and shadowed PATH with it, which
 * stopped working on Windows: `runGit` calls `spawn("git", ...)` without
 * `shell: true`, and Node refuses to spawn `.bat`/`.cmd` that way, so the shim
 * was never executed and `listWorktrees` silently returned its "git failed"
 * fallback. The assertions on slug and directory still passed, because the
 * fallback produces the same values -- only the branch assertion caught it.
 * A stub that can pass by not running at all is worse than no stub.
 */

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" })
}

function initRepo(root: string): void {
  mkdirSync(root, { recursive: true })
  // `-b main` pins the branch name; the global init.defaultBranch is not ours.
  git(root, "init", "-b", "main")
  git(root, "config", "user.email", "test@saiwork.local")
  git(root, "config", "user.name", "SAIWORK Test")
  git(root, "config", "commit.gpgsign", "false")
  writeFileSync(path.join(root, "README.md"), "test\n")
  git(root, "add", "README.md")
  git(root, "commit", "-m", "initial")
}

describe("listWorktrees", () => {
  it("uses the selected workspace folder for the root worktree directory", async () => {
    const temp = mkdtempSync(path.join(tmpdir(), "saiwork-git-worktrees-"))
    const repoRoot = path.join(temp, "repo")
    // The point of the test: the user opened a subdirectory, not the repo root.
    const workspaceFolder = path.join(repoRoot, "proj-1")

    try {
      initRepo(repoRoot)
      mkdirSync(workspaceFolder, { recursive: true })

      const worktrees = await listWorktrees({ repoRoot, workspaceFolder })

      assert.equal(worktrees[0]?.slug, "root")
      assert.equal(worktrees[0]?.directory, workspaceFolder)
      assert.equal(worktrees[0]?.kind, "root")
      assert.equal(worktrees[0]?.branch, "main")
      assert.notEqual(worktrees[0]?.directory, repoRoot)
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it("reports linked worktrees alongside the root", async () => {
    const temp = mkdtempSync(path.join(tmpdir(), "saiwork-git-worktrees-"))
    const repoRoot = path.join(temp, "repo")
    const linkedPath = path.join(temp, "feature")

    try {
      initRepo(repoRoot)
      git(repoRoot, "worktree", "add", "-b", "feature", linkedPath)

      const worktrees = await listWorktrees({ repoRoot, workspaceFolder: repoRoot })

      assert.equal(worktrees[0]?.slug, "root")
      assert.equal(worktrees[0]?.branch, "main")

      const linked = worktrees.find((entry) => entry.branch === "feature")
      assert.ok(linked, "expected the linked worktree to be listed")
      assert.equal(linked?.kind, "worktree")
    } finally {
      // The linked worktree holds a lock file inside .git; remove it first.
      try {
        git(repoRoot, "worktree", "remove", "--force", linkedPath)
      } catch {
        // Already gone, or the repo never got that far. rmSync handles the rest.
      }
      rmSync(temp, { recursive: true, force: true })
    }
  })
})
