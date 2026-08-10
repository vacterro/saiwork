# BOARD -- SAIWORK 0.0.1

Fork of CodeNomad 0.18.0, rebranded in place on branch `saiwork`.
Remotes: `origin` -> github.com/vacterro/saiwork, `upstream` -> github.com/NeuralNomadsAI/CodeNomad.

## Decisions

- D-01 Rebrand in place, same working tree, branch `saiwork`. Upstream kept for merges.
- D-02 Electron is the primary shell for 0.0.1. Tauri kept compiling, not polished.
- D-03 SAIPEN Core loads via opencode `instructions[]` pointing at the live
  `saipen_home` protocol dir -- never a copy, so upstream protocol edits apply at once.
- D-04 Prompt queue is full FreeBuff-style: reorder, edit, delete, pause/resume,
  auto-send on idle. Shell and slash commands are excluded by design.
- D-05 Vintage Golden (saipen `UI.md`) is the default and only palette, applied as an
  override layer (`vintage-golden.css`) so upstream `tokens.css` stays untouched.
- D-06 Fork-specific code lives in its own files to keep upstream merges cheap:
  `saipen/core.ts`, `routes/saipen.ts`, `prompt-queue.ts`, `prompt-queue-panel.tsx`,
  `saipen-bar.tsx`, `saipen-commands.ts`, `shortcuts/saiwork.ts`,
  `shortcuts-overlay.tsx`, `vintage-golden.css`.
- D-07 Anything that does not exist for this fork was removed rather than repointed:
  Discord link, GitHub star pill, star-history badge, npx install instructions.
- D-08 Icon is the SAIPEN mark from `_SAIPEN/assets/__SAIPEN_Alpha.png`, tinted to
  Vintage Golden by `packages/electron-app/scripts/tint-icon.mjs`, square corners
  (`generate-icons.js --radius 0`).
- D-09 The palette is saipen `UI.md`'s eighteen values, NOT the darker set in the
  `vintage` skill. UI.md states in its own text that it superseded those numbers,
  and the global CLAUDE.md points UI work at UI.md. If the darker set is ever
  wanted, change it in UI.md first -- do not fork the palette here.
- D-10 The 10/11/12/14/16 type scale is enforced by pinning Tailwind's `text-*`
  utilities in `vintage-golden.css` rather than fixing call sites, so an upstream
  merge cannot quietly reintroduce an off-scale size.
- D-11 Yolo default lives at the wiring layer (`AutoAcceptManager.defaultEnabled`),
  not inside the store, so the upstream opt-in tests keep testing real behaviour.
- D-12 HUNT workers use `general` only until SAIWORK validates configured agent
  model pins; global cavecrew `model: haiku` resolves to unavailable `haiku/.`.
- D-13 Product promise: connect agents and work on projects seamlessly. First-run,
  project-open, session, agent, prompt, status, and recovery flows must be obvious
  without documentation; visual polish serves this path rather than decorating it.

## DOING

(empty)

## TODO

(empty)

Wave 3 -- window management, as the user scoped it: split panes in one window
plus detached OS windows, Ctrl+Q snaps the active window to a preset size and
position, window-layout presets are saveable/restorable, all configurable in
settings.

Wave 2 order: the four defects the user hit in a live session come first, then
the gate that keeps them from coming back, then wave 1's remaining findings.

## DONE

- [x] T-070 README provenance pass + version-drift fix: added "Fork provenance" notice (commit totals include upstream CodeNomad history, not SAIWORK-specific); split README into "Upstream / inherited" vs "What I changed (SAIWORK delta)" with every delta claim verified against code (saipen injection, prompt queue, SAIPEN bar/VIEW/Goal Auto, portable workflow, vintage-golden, split panes); fixed stale 0.0.1 references (electron shell, portable exe name) -> 0.0.2; GitHub About description updated via gh | verify: README claims cross-checked against repo files (prompt-queue.ts, saipen/core.ts, saipen-bar.tsx, vintage-golden.css, split-picker.ts, window-snap.ts), no 0.0.1 drift remains | review_passes: 1

- [x] T-069 Fix "app turns itself back on" on quit: before-quit ran startShutdown and on ANY failure called restoreWindowAfterRejectedShutdown, resurrecting the window and leaving the app alive (user saw the app reopen and hunt sessions); now a failed shutdown logs "not contained" and exits with code 1 instead of showing the window again; removed the dead restoreWindow helper | verify: electron typecheck PASS, `npm test` exit 0 (118 electron pass) | review_passes: 1

- [x] T-068 Remove orphan UI components x7: deleted session-picker.tsx, advanced-settings-modal.tsx, notifications-settings-modal.tsx, remote-access-overlay.tsx, message-list-header.tsx, theme-mode-toggle.tsx, code-block-inline.tsx — all confirmed zero-referenced (static + dynamic, ui + electron), all tracked at HEAD (recoverable); reference sweep done before deletion | verify: UI typecheck PASS, `npm test` exit 0 (575 UI pass) | review_passes: 1

- [x] T-067 Remove dead code formatCompactCount: exported from lib/formatters.ts but referenced nowhere (grep across packages/ui/src incl. tests = 0); deleted the unused function, formatTokenTotal untouched | verify: UI typecheck PASS, `npm test` exit 0 (575 UI pass) | review_passes: 1

- [x] T-065 Isolate SAIWORK from the shared global opencode storage: every spawned `opencode serve` now gets `XDG_DATA_HOME` pointing at `~/.config/saiwork/opencode-data` (workspaces/manager.ts resolveOpencodeDataHome), so sessions/history/DB never mix with the packaged CodeNomad install or a bare opencode CLI; first launch seeds the private auth.json from the global one so provider tokens survive; XDG_DATA_HOME added to WSL_PATH_ENV_KEYS for correct WSL path translation | verify: server typecheck PASS, `npm test` exit 0 (287 server pass), live launch created ~/.config/saiwork/opencode-data/opencode + seeded auth.json | review_passes: 1

- [x] T-066 Fix single-session shell: with exactly one session the sessions sidebar can never be pinned (it got stuck that way); renderLeftPanel now opens only the floating drawer, and the hamburger is always visible in single-session mode (independent of the stored pin state) toggling the drawer open/closed | verify: UI typecheck PASS, `npm test` exit 0 (575 UI pass) | review_passes: 1

- [x] T-064 Make START_HIDDEN.vbs tolerate a locked dev.log: vbs now probes dev.log for a write lock before redirecting (OpenTextFile append test) and falls back to a timestamped dev-YYYY-MM-DD-HHMMSS.log when locked, so a phantom handle can no longer silently kill the launcher; verified LIVE against the still-locked dev.log -- fallback log created and SAIWORK launched (window + 3 workspaces) | verify: live launch with dev.log locked started SAIWORK via fallback log | review_passes: 1

- [x] T-063 Guard against the recurring TDZ blank-shell: added instance-shell2.tdz.test.ts, a node-test that scans instance-shell2.tsx and FAILs if any createMemo/createEffect reads a component-level const declared later in the file (the exact crash pattern seen twice: split-pane block, singleSessionMode); filters local-in-block consts so only real component-scope TDZ trips it | verify: UI typecheck PASS, `npm test` exit 0 (575 UI pass) | review_passes: 1

- [x] T-062 Migrate the three legacy ticking-clock signals onto useNow: instance-shell2.tsx, instance-tab.tsx and session-list.tsx each hand-rolled `createSignal(Date.now())` + `setInterval` (duplicating lib/hooks/use-now.ts); all three swapped to `useNow()`, dead interval/effects removed | verify: UI typecheck PASS, `npm test` exit 0 (574 UI pass) | review_passes: 1

- [x] T-061 Deduplicate formatRelativeTime: extracted shared lib/relative-time.ts (formatRelativeTime(timestamp, now, t)) and wired all three call sites (folder-selection-view, session-picker, opencode-binary-selector) onto it; added relative-time.test.ts (3 cases) | verify: UI typecheck PASS, `npm test` exit 0 (574 UI pass) | review_passes: 1

## BLOCKED

(empty)
