import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

/**
 * Guards against the recurring blank-shell regression where a Solid createMemo
 * or createEffect eagerly reads a `const` declared later in the same component
 * (TDZ ReferenceError at mount). instance-shell2.tsx has hit this twice
 * (split-pane block, then singleSessionMode).
 *
 * The heuristic: for every createMemo/createEffect block, every identifier that
 * names a `const X =` declared anywhere in the file must be declared above the
 * block. Solid memos/effects evaluate eagerly at creation, so a later const is
 * a real TDZ crash, not a style nit.
 */

const here = dirname(fileURLToPath(import.meta.url))
const target = join(here, "instance-shell2.tsx")

const CONST_DECL = /^ {0,2}(?:const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g
const MEMO_START = /createMemo\s*\(\s*(?:on\s*\()?/g
const EFFECT_START = /createEffect\s*\(\s*(?:on\s*\()?/g

function collectConstLines(source: string): Map<string, number> {
  const constLines = new Map<string, number>()
  const lines = source.split("\n")
  for (let i = 0; i < lines.length; i += 1) {
    CONST_DECL.lastIndex = 0
    // Only component-level consts (0-2 leading spaces) participate: a local
    // const inside a memo body is declared before use in its own scope.
    if (!/^ {0,2}const|^ {0,2}let/.test(lines[i])) continue
    let match: RegExpExecArray | null
    while ((match = CONST_DECL.exec(lines[i])) !== null) {
      const name = match[1]
      const existing = constLines.get(name)
      if (existing === undefined || i < existing) constLines.set(name, i)
    }
  }
  return constLines
}

function extractBlockIdentifiers(source: string, startLine: number): { ids: Set<string>; endLine: number } {
  const lines = source.split("\n")
  const ids = new Set<string>()
  // The body of a memo/effect block runs from the line after `createMemo(` up
  // to its matching `})` / `)` on its own line (typical Solid style: one line
  // per argument, closing parens on their own line). Collect identifiers from
  // the opening line and every following line until one that closes the call.
  let i = startLine
  let depth = 0
  let opened = false
  for (; i < lines.length; i += 1) {
    const line = lines[i]
    for (const ch of line) {
      if (ch === "(") {
        depth += 1
        opened = true
      } else if (ch === ")") {
        depth -= 1
      }
    }
    if (opened) {
      for (const m of line.matchAll(/\b[A-Za-z_$][A-Za-z0-9_$]*\b/g)) ids.add(m[0])
      if (depth <= 0) break
    }
  }
  return { ids, endLine: i }
}

describe("instance-shell2 TDZ ordering guard", () => {
  it("declares every component const before any createMemo/createEffect reads it", async () => {
    const source = await readFile(target, "utf8")
    const constLines = collectConstLines(source)
    const lines = source.split("\n")

    const offenders: string[] = []
    for (const { index } of [...source.matchAll(MEMO_START), ...source.matchAll(EFFECT_START)]) {
      const startLine = source.slice(0, index).split("\n").length - 1
      const { ids, endLine } = extractBlockIdentifiers(source, startLine)
      for (const id of ids) {
        const declLine = constLines.get(id)
        if (declLine === undefined) continue
        // A const declared INSIDE the block is a local — declared before use in
        // its own scope, no TDZ risk. Only a const declared outside the block
        // (above or below it) participates in the ordering check.
        if (declLine > startLine && declLine <= endLine) continue
        if (declLine > startLine) {
          offenders.push(`L${startLine + 1}: memo/effect reads component const '${id}' declared at L${declLine + 1}`)
        }
      }
    }

    assert.deepEqual(offenders, [], "createMemo/createEffect must not read a const declared later in the file")
  })
})
