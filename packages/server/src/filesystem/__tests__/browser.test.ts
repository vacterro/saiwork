import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "node:test"
import { FileSystemBrowser } from "../browser"
import { WINDOWS_DRIVES_ROOT } from "../../api-types"

const tempRoots: string[] = []

describe("FileSystemBrowser", () => {
  afterEach(() => {
    for (const directory of tempRoots.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("starts unrestricted browsing from the configured root", () => {
    const rootDir = createTempRoot()
    fs.mkdirSync(path.join(rootDir, "project"))

    const browser = new FileSystemBrowser({ rootDir, unrestricted: true })
    const listing = browser.browse()

    assert.equal(listing.metadata.scope, "unrestricted")
    assert.equal(listing.metadata.currentPath, rootDir)
    assert.equal(listing.metadata.rootPath, rootDir)
    assert.equal(listing.metadata.displayPath, rootDir)
    assert.equal(listing.metadata.pathKind, "absolute")
    assert.ok(listing.entries.some((entry) => entry.name === "project" && entry.absolutePath === path.join(rootDir, "project")))
  })

  it("treats dot as the configured unrestricted root", () => {
    const rootDir = createTempRoot()
    const browser = new FileSystemBrowser({ rootDir, unrestricted: true })

    const listing = browser.browse(".")

    assert.equal(listing.metadata.currentPath, rootDir)
    assert.equal(listing.metadata.rootPath, rootDir)
  })

  it("allows unrestricted browsing outside the configured root", () => {
    const rootDir = createTempRoot()
    const parentDir = path.dirname(rootDir)
    const browser = new FileSystemBrowser({ rootDir, unrestricted: true })

    const listing = browser.browse(parentDir)

    assert.equal(listing.metadata.currentPath, parentDir)
    assert.equal(listing.metadata.rootPath, rootDir)
    assert.ok(listing.entries.some((entry) => entry.absolutePath === rootDir))
  })

  it("creates folders under the configured unrestricted root by default", () => {
    const rootDir = createTempRoot()
    const browser = new FileSystemBrowser({ rootDir, unrestricted: true })

    const created = browser.createFolder(undefined, "created-folder")

    assert.equal(created.path, path.join(rootDir, "created-folder"))
    assert.equal(created.absolutePath, path.join(rootDir, "created-folder"))
    assert.equal(fs.statSync(created.absolutePath).isDirectory(), true)
  })

  it("reports the configured root for the Windows drives pseudo-root", () => {
    const rootDir = createTempRoot()
    const browser = new FileSystemBrowser({ rootDir, unrestricted: true, platform: "win32" })

    const listing = browser.browse(WINDOWS_DRIVES_ROOT)

    assert.equal(listing.metadata.scope, "unrestricted")
    assert.equal(listing.metadata.currentPath, WINDOWS_DRIVES_ROOT)
    assert.equal(listing.metadata.rootPath, rootDir)
    assert.equal(listing.metadata.pathKind, "drives")
  })
})

function createTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "saiwork-browser-"))
  tempRoots.push(root)
  return fs.realpathSync(root)
}

function trySymlink(target: string, linkPath: string, type?: "file" | "dir" | "junction"): boolean {
  try {
    fs.symlinkSync(target, linkPath, type)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP" || code === "EINVAL") return false
    throw error
  }
}

describe("FileSystemBrowser restricted containment", () => {
  afterEach(() => {
    for (const directory of tempRoots.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  function restrictedRoot() {
    const root = createTempRoot()
    fs.mkdirSync(path.join(root, "project"))
    fs.writeFileSync(path.join(root, "project", "ok.txt"), "ok")
    return new FileSystemBrowser({ rootDir: root })
  }

  it("allows plain children and rejects ../ escapes", () => {
    const browser = restrictedRoot()
    const listing = browser.list("project")
    assert.ok(listing.some((entry) => entry.name === "ok.txt"))
    assert.equal(browser.readFile("project/ok.txt"), "ok")
    assert.throws(() => browser.list("../"), /outside of root/)
    assert.throws(() => browser.readFile("../secret"), /outside of root/)
  })

  it("rejects a symlinked directory pointing outside the root for every operation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "saiwork-browser-symlink-"))
    tempRoots.push(root)
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "saiwork-browser-outside-"))
    tempRoots.push(outside)
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret")
    const link = path.join(root, "link")
    if (!trySymlink(outside, link, "dir")) return // platform cannot create symlinks

    const browser = new FileSystemBrowser({ rootDir: root })
    assert.throws(() => browser.list("link"), /outside of root/)
    assert.throws(() => browser.readFile("link/secret.txt"), /outside of root/)
    assert.throws(() => browser.writeFile("link/new.txt", "x"), /outside of root/)
    assert.throws(() => browser.createFolder("link", "x"), /outside of root/)
    assert.throws(() => browser.browse("link"), /outside of root/)
  })

  it("rejects a symlinked file pointing outside the root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "saiwork-browser-symlink-"))
    tempRoots.push(root)
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "saiwork-browser-outside-"))
    tempRoots.push(outside)
    const secret = path.join(outside, "secret.txt")
    fs.writeFileSync(secret, "secret")
    const link = path.join(root, "secret-link.txt")
    if (!trySymlink(secret, link, "file")) return

    const browser = new FileSystemBrowser({ rootDir: root })
    assert.throws(() => browser.readFile("secret-link.txt"), /outside of root/)
    assert.throws(() => browser.readFileBase64("secret-link.txt"), /outside of root/)
  })

  it("rejects a nested symlink escape", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "saiwork-browser-symlink-"))
    tempRoots.push(root)
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "saiwork-browser-outside-"))
    tempRoots.push(outside)
    fs.writeFileSync(path.join(outside, "pwned.txt"), "pwned")
    fs.mkdirSync(path.join(root, "nested"))
    const link = path.join(root, "nested", "link")
    if (!trySymlink(outside, link, "dir")) return

    const browser = new FileSystemBrowser({ rootDir: root })
    assert.throws(() => browser.list("nested/link"), /outside of root/)
    assert.throws(() => browser.readFile("nested/link/pwned.txt"), /outside of root/)
    assert.throws(() => browser.createFolder("nested/link", "x"), /outside of root/)
  })

  it("rejects a create path whose existing ancestor is an escaping symlink", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "saiwork-browser-symlink-"))
    tempRoots.push(root)
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "saiwork-browser-outside-"))
    tempRoots.push(outside)
    const link = path.join(root, "link")
    if (!trySymlink(outside, link, "dir")) return

    const browser = new FileSystemBrowser({ rootDir: root })
    assert.throws(() => browser.writeFile("link/newdir/file.txt", "x"), /outside of root/)
    assert.throws(() => browser.createFolder("link", "brand-new-folder"), /outside of root/)
  })

  it("allows in-root symlinks (they resolve inside the root)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "saiwork-browser-symlink-"))
    tempRoots.push(root)
    fs.mkdirSync(path.join(root, "real"))
    fs.writeFileSync(path.join(root, "real", "inside.txt"), "inside")
    const link = path.join(root, "inside-link")
    if (!trySymlink(path.join(root, "real"), link, "dir")) return

    const browser = new FileSystemBrowser({ rootDir: root })
    const listing = browser.list("inside-link")
    assert.ok(listing.some((entry) => entry.name === "inside.txt"))
    assert.equal(browser.readFile("inside-link/inside.txt"), "inside")
    assert.equal(browser.writeFile("inside-link/new.txt", "created"), undefined)
    assert.equal(browser.readFile("inside-link/new.txt"), "created")
  })

  it("uses the Windows junction type when available for an escape", () => {
    if (process.platform !== "win32") return
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "saiwork-browser-symlink-"))
    tempRoots.push(root)
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "saiwork-browser-outside-"))
    tempRoots.push(outside)
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret")
    const link = path.join(root, "junction")
    if (!trySymlink(outside, link, "junction")) return

    const browser = new FileSystemBrowser({ rootDir: root })
    assert.throws(() => browser.list("junction"), /outside of root/)
    assert.throws(() => browser.readFile("junction/secret.txt"), /outside of root/)
  })
})
