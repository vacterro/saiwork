import fs from "fs"
import path from "path"

/**
 * Canonical restricted-filesystem containment.
 *
 * Lexical containment (`path.resolve` + `path.relative`) proves nothing about
 * the real filesystem target: a symlink or Windows junction inside the root
 * can point anywhere. Every restricted operation resolves the target with
 * `realpath` and proves the PHYSICAL target is a descendant of the PHYSICAL
 * root before acting. In-root symlinks stay allowed (they resolve inside);
 * anything that resolves outside is rejected.
 */

function normalizeComparison(value: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? value.toLowerCase() : value
}

/** True when `targetReal` is `rootReal` itself or a descendant of it. */
export function isRealPathWithinRoot(rootReal: string, targetReal: string, platform: NodeJS.Platform): boolean {
  if (rootReal === targetReal) return true
  const root = normalizeComparison(rootReal, platform)
  const target = normalizeComparison(targetReal, platform)
  const sep = platform === "win32" ? path.win32.sep : path.posix.sep
  return target.startsWith(`${root}${sep}`) || target.startsWith(`${root}/`)
}

/** Cheap lexical guard: `..` escapes are rejected before any filesystem call. */
function isLexicallyWithin(rootLexical: string, targetLexical: string): boolean {
  if (targetLexical === rootLexical) return true
  return targetLexical.startsWith(`${rootLexical}${path.sep}`)
}

/**
 * Resolve a restricted relative path to a lexical absolute and prove the
 * real target stays inside the real root. Throws on any escape.
 */
export function resolveContainedPath(rootDir: string, relativePath: string, platform: NodeJS.Platform): string {
  const rootLexical = path.resolve(rootDir)
  const targetLexical = path.resolve(rootLexical, relativePath)
  if (!isLexicallyWithin(rootLexical, targetLexical)) {
    throw new Error("Access outside of root is not allowed")
  }
  const rootReal = fs.realpathSync(rootLexical)
  const targetReal = fs.realpathSync(targetLexical)
  if (!isRealPathWithinRoot(rootReal, targetReal, platform)) {
    throw new Error("Access outside of root is not allowed")
  }
  return targetLexical
}

/**
 * Resolve a restricted CREATE target (file/folder that may not exist yet).
 * Walks up to the nearest existing ancestor, realpaths it, and proves that
 * ancestor stays inside the real root; any symlink/junction component in the
 * existing prefix that points outside therefore rejects, and the not-yet-
 * existing remainder cannot contain a link by construction.
 */
export function resolveContainedCreateTarget(rootDir: string, relativePath: string, platform: NodeJS.Platform): string {
  const rootLexical = path.resolve(rootDir)
  const targetLexical = path.resolve(rootLexical, relativePath)
  if (!isLexicallyWithin(rootLexical, targetLexical)) {
    throw new Error("Access outside of root is not allowed")
  }
  const rootReal = fs.realpathSync(rootLexical)

  let ancestor = targetLexical
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor)
    if (parent === ancestor) break
    ancestor = parent
  }
  const ancestorReal = fs.realpathSync(ancestor)
  if (!isRealPathWithinRoot(rootReal, ancestorReal, platform)) {
    throw new Error("Access outside of root is not allowed")
  }
  return targetLexical
}
