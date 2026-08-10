// Shim: work around npm electron package shadowing built-in electron module.
// In CJS builds, require("electron") from within an npm workspace may resolve
// to the npm electron package (which returns the path string) instead of the
// built-in Electron module. This module intercepts and returns the correct module.
import { createRequire } from "node:module"
import electronDefault from "electron"

function isNpmPackageStub(e: unknown): boolean {
  return typeof e === "string" || (typeof e === "object" && e !== null && !("app" in e))
}

let cachedElectron: typeof electronDefault | null = null

export function getElectron(): typeof electronDefault {
  if (cachedElectron) return cachedElectron

  if (isNpmPackageStub(electronDefault)) {
    const r = createRequire(import.meta.url)
    const resolved = r.resolve("electron")
    delete r.cache[resolved]
    const reloaded = r("electron")
    r.cache[resolved] = { exports: electronDefault, ...{} as any }
    if (!isNpmPackageStub(reloaded)) {
      cachedElectron = reloaded as typeof electronDefault
      return cachedElectron
    }
  }

  cachedElectron = electronDefault as typeof electronDefault
  return cachedElectron
}

export default getElectron()
