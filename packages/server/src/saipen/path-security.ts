import { lstatSync, realpathSync } from "fs"
import path from "path"

function comparisonKey(value: string): string {
  const normalized = path.normalize(value)
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

export function pathsEqual(left: string, right: string): boolean {
  return comparisonKey(left) === comparisonKey(right)
}

export function pathEntryExists(candidate: string): boolean {
  try {
    lstatSync(candidate)
    return true
  } catch {
    return false
  }
}

export function canonicalExistingPath(candidate: string): string | null {
  try {
    return path.normalize(realpathSync(candidate))
  } catch {
    return null
  }
}

export function isPathWithin(root: string, candidate: string, allowRoot = false): boolean {
  const relative = path.relative(root, candidate)
  if (!relative) return allowRoot
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/**
 * Resolves an existing or future child through its nearest existing ancestor.
 * Both lexical traversal and symlink/junction escapes fail closed.
 */
export function resolvePathWithin(root: string, candidate: string): string | null {
  const lexicalRoot = path.resolve(root)
  const lexicalCandidate = path.resolve(candidate)
  if (!isPathWithin(lexicalRoot, lexicalCandidate)) return null

  const canonicalRoot = canonicalExistingPath(lexicalRoot)
  if (!canonicalRoot) return null

  let ancestor = lexicalCandidate
  while (!pathEntryExists(ancestor)) {
    const parent = path.dirname(ancestor)
    if (pathsEqual(parent, ancestor) || !isPathWithin(lexicalRoot, parent, true)) return null
    ancestor = parent
  }

  const canonicalAncestor = canonicalExistingPath(ancestor)
  if (!canonicalAncestor || !isPathWithin(canonicalRoot, canonicalAncestor, true)) return null

  const resolved = path.resolve(canonicalAncestor, path.relative(ancestor, lexicalCandidate))
  return isPathWithin(canonicalRoot, resolved) ? resolved : null
}

export function hasParentPathSegment(value: string): boolean {
  return value.replace(/\\/g, "/").split("/").includes("..")
}
