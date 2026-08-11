import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"

import {
  DRAWER_INTERACTIVE_OVERLAY_SELECTOR,
  getSessionModeDrawerAction,
  isFloatingDrawerOpen,
  shouldDismissFloatingDrawer,
} from "./shell/types"

const here = dirname(fileURLToPath(import.meta.url))
const target = join(here, "instance-shell2.tsx")
const drawerChromeTarget = join(here, "shell", "useDrawerChrome.ts")

describe("instance-shell2 floating drawers", () => {
  it("uses rendered floating state instead of trusting a stale pin flag", () => {
    assert.equal(isFloatingDrawerOpen(false, false), false)
    assert.equal(isFloatingDrawerOpen(true, false), true)
    assert.equal(isFloatingDrawerOpen(true, true), false)
    assert.equal(isFloatingDrawerOpen(true, true, true), true)
  })

  it("dismisses only outside clicks that are not inside a portaled control", () => {
    const base = {
      open: true,
      pinned: true,
      forceFloating: true,
      targetInsideDrawer: false,
      targetInsideOverlay: false,
    }

    assert.equal(shouldDismissFloatingDrawer(base), true)
    assert.equal(shouldDismissFloatingDrawer({ ...base, targetInsideDrawer: true }), false)
    assert.equal(shouldDismissFloatingDrawer({ ...base, targetInsideOverlay: true }), false)
    assert.equal(shouldDismissFloatingDrawer({ ...base, open: false }), false)
    assert.equal(shouldDismissFloatingDrawer({ ...base, forceFloating: false }), false)
  })

  it("treats selector portals as part of the floating drawer interaction", () => {
    assert.equal(DRAWER_INTERACTIVE_OVERLAY_SELECTOR.split(",").includes(".selector-popover"), true)
  })

  it("keeps hidden session-mode transitions local", () => {
    const base = {
      open: true,
      pinned: true,
      previousSingleSessionMode: false,
      currentSingleSessionMode: true,
    }

    assert.equal(getSessionModeDrawerAction({ ...base, active: true }), "close")
    assert.equal(getSessionModeDrawerAction({ ...base, active: false }), "reset-local")
    assert.equal(getSessionModeDrawerAction({ ...base, open: false, active: false }), "reset-local")
    assert.equal(getSessionModeDrawerAction({
      ...base,
      active: false,
      pinned: false,
      previousSingleSessionMode: true,
      currentSingleSessionMode: false,
    }), "reset-local")
    assert.equal(getSessionModeDrawerAction({
      ...base,
      active: true,
      open: false,
      pinned: false,
      previousSingleSessionMode: true,
      currentSingleSessionMode: false,
    }), "none")
  })

  it("avoids the SUID temporary drawer ModalManager cleanup crash", async () => {
    const source = await readFile(target, "utf8")

    assert.equal(source.match(/variant="persistent"/g)?.length, 2)
    assert.equal(source.includes('variant="temporary"'), false)
  })

  it("dismisses floating sessions UI across pointer, selection, and hidden-shell transitions", async () => {
    const source = await readFile(target, "utf8")
    const drawerChromeSource = await readFile(drawerChromeTarget, "utf8")

    assert.match(source, /leftForceFloating: singleSessionMode/)
    assert.match(source, /else if \(action === "reset-local"\) resetLeftDrawerLocally\(\)/)
    assert.match(source, /targetElement\?\.closest\(DRAWER_INTERACTIVE_OVERLAY_SELECTOR\)/)
    assert.match(drawerChromeSource, /isFloatingDrawerOpen\(leftOpen\(\), leftPinned\(\), leftForceFloating\(\)\)/)
    assert.equal(source.match(/onSelectSession=\{handleFloatingDrawerSessionSelect\}/g)?.length, 1)
    assert.equal(source.match(/onNewSession=\{handleFloatingDrawerNewSession\}/g)?.length, 1)
    assert.match(source, /if \(!isActive\) \{[\s\S]*?isFloatingDrawerOpen\(leftOpen\(\), leftPinned\(\), singleSessionMode\(\)\)/)
  })
})
