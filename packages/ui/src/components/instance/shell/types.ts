export type LayoutMode = "desktop" | "tablet" | "phone"

export type DrawerViewState = "pinned" | "floating-open" | "floating-closed"

export const DRAWER_INTERACTIVE_OVERLAY_SELECTOR = [
  ".MuiPopover-root",
  ".MuiModal-root",
  ".selector-popover",
  '[role="dialog"]',
  '[role="listbox"]',
  '[role="menu"]',
].join(",")

export function isFloatingDrawerOpen(open: boolean, pinned: boolean, forceFloating = false): boolean {
  return open && (forceFloating || !pinned)
}

interface FloatingDrawerDismissalOptions {
  open: boolean
  pinned: boolean
  forceFloating?: boolean
  targetInsideDrawer: boolean
  targetInsideOverlay: boolean
}

export function shouldDismissFloatingDrawer(options: FloatingDrawerDismissalOptions): boolean {
  return isFloatingDrawerOpen(options.open, options.pinned, options.forceFloating)
    && !options.targetInsideDrawer
    && !options.targetInsideOverlay
}

export type SessionModeDrawerAction = "none" | "close" | "reset-local"

interface SessionModeDrawerActionOptions {
  active: boolean
  open: boolean
  pinned: boolean
  previousSingleSessionMode: boolean
  currentSingleSessionMode: boolean
}

export function getSessionModeDrawerAction(options: SessionModeDrawerActionOptions): SessionModeDrawerAction {
  const modeChanged = options.previousSingleSessionMode !== options.currentSingleSessionMode
  const modeChangedWhileFloating = modeChanged && (
    isFloatingDrawerOpen(options.open, options.pinned, options.previousSingleSessionMode)
    || isFloatingDrawerOpen(options.open, options.pinned, options.currentSingleSessionMode)
  )
  const staleForcedPin = options.currentSingleSessionMode && options.pinned
  if (!modeChangedWhileFloating && !staleForcedPin) return "none"
  return options.active ? "close" : "reset-local"
}
