import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const pixelCss = fs.readFileSync(path.join(sourceRoot, "styles/components/pixel-icons.css"), "utf8")

const walk = (directory: string): string[] => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const fullPath = path.join(directory, entry.name)
  return entry.isDirectory() ? walk(fullPath) : [fullPath]
})

const className = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()

describe("pixel icon registry", () => {
  it("contains a 20x20 binary mask for every imported Lucide icon", () => {
    const imported = new Set<string>()
    for (const file of walk(sourceRoot).filter((candidate) => candidate.endsWith(".tsx"))) {
      const source = fs.readFileSync(file, "utf8")
      for (const match of source.matchAll(/import\s*{([^}]*)}\s*from\s*["']lucide-solid["']/g)) {
        for (const specifier of match[1].split(",")) {
          const name = specifier.trim().split(/\s+as\s+/)[0]
          if (name) imported.add(name)
        }
      }
    }

    assert.match(pixelCss, /20x20, 1-bit alpha/)
    for (const name of imported) {
      assert.match(pixelCss, new RegExp(`svg\\.lucide-${className(name)} \\{`), `missing ${name} pixel mask`)
    }
  })

  it("leaves no hand-drawn UI icon SVGs or Material icon components", () => {
    const remainingSvgFiles: string[] = []
    const materialIconFiles: string[] = []
    for (const file of walk(sourceRoot).filter((candidate) => candidate.endsWith(".tsx"))) {
      const source = fs.readFileSync(file, "utf8")
      if (source.includes("<svg") && !file.endsWith(`${path.sep}context-meter.tsx`)) remainingSvgFiles.push(file)
      if (source.includes("@suid/icons-material")) materialIconFiles.push(file)
    }

    assert.deepEqual(remainingSvgFiles, [])
    assert.deepEqual(materialIconFiles, [])
  })
})
