# BOARD -- SAIWORK 0.0.4

Downstream source based on CodeNomad 0.18.0 development commit `67cb394e`.
Default `saiwork` was squash-imported; inherited history remains on `backup/pre-squash-history`.
Remotes: `origin` -> github.com/vacterro/saiwork, `upstream` -> github.com/NeuralNomadsAI/CodeNomad.

## Decisions

- D-01 Default branch is a squash import. Upstream is retained for comparison and
  explicit ports, not plain merges; inherited history is preserved on the backup branch.
- D-02 Electron is the primary shell for 0.0.2. Tauri remains experimental.
- D-03 SAIPEN Core loads via opencode `instructions[]` pointing at the live
  `saipen_home` protocol dir -- never a copy, so upstream protocol edits apply at once.
- D-04 Prompt queue supports reorder, edit, delete, pause/resume and idle dispatch.
  Shell commands and recognized slash commands bypass it.
- D-05 Vintage structure and Golden default are applied by an override layer
  (`vintage-golden.css`); selectable Wintage palettes exist and upstream `tokens.css` stays untouched.
- D-06 Major fork feature cores live in dedicated files to keep tree comparisons explicit:
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
- D-12 Cavecrew agents inherit the selected session model. OpenCode requires
  qualified `provider/model` pins; aliases such as `haiku` can resolve to the
  invalid `haiku/.`. SAIWORK also strips stale unqualified agent pins at config load.
- D-13 Product promise: connect agents and work on projects seamlessly. First-run,
  project-open, session, agent, prompt, status, and recovery flows must be obvious
  without documentation; visual polish serves this path rather than decorating it.

## DOING
- [/] T-105 [P0] Replace top project-tab horizontal scrolling with an ellipsis dropdown listing tabs that do not fit | verify: UI tests and 320/640px Electron smoke show no horizontal scrollbar; active tab and fixed actions stay visible and hidden tabs remain keyboard-accessible through the overflow menu | owner: opencode | claim_time: 2026-08-11T17:52:06Z


## TODO
- [ ] T-106 [P0] Expose all 16 canonical Wintage palettes in Appearance settings with correct ordering, persistence, polarity, and schema validation | verify: Appearance picker lists all 16 themes; Vintage Classic uses light color-scheme; rapid selection persists latest value; generator rejects invalid schema and duplicate identities
- [x] T-108 [P1] FreeBuff tab model picker: select among quota-eligible FreeBuff models (deepseek-v4-flash, mimo-v2.5) and title new threads instead of always defaulting to deepseek-v4-flash | verify: LIVE -- thread created on mimo/mimo-v2.5 with custom title "SAIWORK smoke", history endpoint returns {thread,messages,items}; quota block highlights the selected model | owner: opencode | claim_time: 2026-08-11T20:40:00Z
- [x] T-107 [P1] FreeBuff engine + UI surface | verify: LIVE -- SAIWORK spawned the headless FreeBuff orchestrator (port 61833), created a codebuff-harness thread on deepseek/deepseek-v4-flash, ran real turns ("OK.", "DONE.", "PING."), SSE /api/freebuff/events streamed 15 agent events live; quota shows tier limited, 6/day pacific_day, resetAt 07:00Z (=10:00 local); root typecheck + all suites green (server 398 / ui 624 / plugin 8 / electron 134, exit 0) | owner: opencode | claim_time: 2026-08-11T20:20:00Z


- [ ] T-093 HUNT-7: stop feeding instance-shell2.tsx -- extract touched logic into focused controllers/hooks with tests | verify: extraction preserves behavior, no new orchestration in shell
- [ ] T-094 HUNT-8: embedded SAIPENVIEW product target -- one app, no manual backend, no second OpenCode runtime | verify: runtime smoke shows single managed runtime
- [ ] T-095 HUNT-9: defer pruning -- inventory then disable/delete only unused features with build+test+runtime smoke | verify: candidate list audited, kept surface green
- [ ] T-096 Mirror the agent's live CodeNomad plan (Status -> PLAN, between Usage and Background) on a PLAN button in SaipenBar; button reflects current plan state, not .saipen ROADMAP | verify: PLAN button shows agent plan list/state and opens the same view
- [ ] T-097 Pressed/sunken visual state for the selected session tab: both sidebar session rows and top project tabs indicate the active session | verify: selected rows/tabs render sunken distinct from idle
- [ ] T-079 Contain background-process startup, output-stream and asynchronous finalization failures so errors cannot crash the server, hang completion or leave a false running record | verify: server tests inject spawn, output-stream and finalize failures and confirm bounded cleanup plus a settled non-running record
- [ ] T-080 Preserve the background-process index on read or parse failure instead of treating corruption as an empty list and overwriting process history | verify: server tests inject unreadable and malformed indexes and confirm mutation fails closed without replacing original records
- [ ] T-081 Make YAML settings persistence fail honestly: write errors propagate, cache/API never report unsaved state, and PATCH returns failure | verify: settings store/route tests inject mkdir/write failure and confirm non-2xx response plus unchanged cached and persisted state
- [ ] T-082 Bound binary `--version` probes so a hanging executable cannot freeze the server event loop indefinitely | verify: spawn probe test runs a hanging shim and returns a timeout error within the configured bound

Wave 3 -- window management, as the user scoped it: split panes in one window
plus detached OS windows, Ctrl+Q snaps the active window to a preset size and
position, window-layout presets are saveable/restorable, all configurable in
settings.

Wave 2 order: the four defects the user hit in a live session come first, then
the gate that keeps them from coming back, then wave 1's remaining findings.

## DONE
- [x] T-103 [P0] Fix Windows release bump invocation without shell execution | verify: bump-version tests pass and npm run bumpVersion succeeds on Windows | owner: opencode | claim_time: 2026-08-11T14:47:12Z
- [x] T-099 Detached-window ownership hardening: prevent duplicate detached owners for one pane; deterministic recovery when a detached renderer crashes or its window is force-closed; session must never become unreachable because its detached owner disappeared | verify: hostile-lifecycle tests cover close-with-X, renderer crash, and duplicate-owner rejection | owner: opencode | claim_time: 2026-08-11T14:16:59Z
- [x] T-100 [P0] Queue durability and server-authority hardening: globally serialize CAS/persist/commit, fail closed on storage errors, migrate renderer localStorage, preserve at-most-once dequeue and dispatch | verify: write, rename, fsync, failed-dequeue restart, concurrent-key, two-client race, mirror-ordering and legacy-migration tests pass | owner: opencode | claim_time: 2026-08-11T14:15:51Z
- [x] T-101 [P0] SAIPEN integration hardening: canonical parser and board API, registered-workspace containment, revisioned atomic writes, watcher lifecycle, protocol-file confinement and byte-safe UTF-8 caps | verify: STATE/BOARD semantics, conflict drafts, create/change/delete, symlink/junction escapes, core file paths and multilingual byte-boundary tests pass | owner: opencode | claim_time: 2026-08-11T14:15:05Z
- [x] T-102 [P0] Release truth and gate hardening: root typecheck covers server, UI and Electron; package, lock, README, CHANGELOG and artifact versions stay one transactional value | verify: release consistency fixtures, rollback injection, exact Electron pin, workflow metadata checks and root typecheck pass at version 0.0.3 | owner: opencode | claim_time: 2026-08-11T14:14:17Z
- [x] T-083 Recreate the Electron main window on app activation when auxiliary windows remain after the main window closes | verify: Electron lifecycle test closes main with an auxiliary window, activates app, and confirms exactly one recreated main window while auxiliary window survives | owner: opencode | claim_time: 2026-08-11T12:13:46Z
- [x] T-092 HUNT-6: queue ownership before detached windows -- central server queue store, revisioned CAS mutations, at-most-once dispatch | verify: multi-client stale-mutation test cannot destroy newer changes | owner: opencode | claim_time: 2026-08-11T12:11:25Z
- [x] T-091 HUNT-5: remove duplicate protocol knowledge -- UI consumes canonical parsed state instead of re-parsing STATE; keep stronger standalone SAIPENVIEW logic | verify: no UI re-parse of canonical STATE beyond shared parser | owner: opencode | claim_time: 2026-08-11T11:32:25Z
- [x] T-090 HUNT-4: live SAIPEN change stream (STATE/BOARD/LOG/kitchen) -- workspace-scoped event, debounced, mounted SAIPENVIEW refreshes; dirty drafts survive with conflict state | verify: event propagation + dirty-draft conflict tests | owner: opencode | claim_time: 2026-08-10T23:40:44Z
- [x] T-098 blocked ticket parser regression -- BOARD status is section-aware; canonical TODO/DOING/BLOCKED/DONE sections win over checkbox state, matching server BOARD semantics | verify: golden BLOCKED fixture + external-change dirty-draft tests pass | owner: opencode | claim_time: 2026-08-11T11:27:30Z
- [x] T-089 HUNT-3: lock /api/saipen/* folder params to registered workspaces; reject unknown/escaping/noncanonical paths and symlink escapes | verify: negative route tests for unknown workspace, traversal, noncanonical, symlink escape | owner: opencode | claim_time: 2026-08-10T23:37:18Z
- [x] T-088 HUNT-2: safe optimistic-concurrency .saipen writes -- SHA-256 revision, 409 on mismatch, atomic same-dir temp replace, per-root serialization | verify: write route tests cover conflict/mismatch/atomicity/Windows replace; no silent overwrite | owner: opencode | claim_time: 2026-08-10T23:36:42Z
- [x] T-087 HUNT-1: canonical STATE.md scalar parser -- frontmatter-scoped, first-match, duplicate detection; server+UI agree; saipen_home/agent/role_revision surfaced in UI State view | verify: server state/core tests 14/14, UI saipen-view 7/7, typechecks, realistic current-format fixture PASS | owner: opencode | claim_time: 2026-08-10T23:30:41Z
- [x] T-086 Compact strict controls, preserve SaipenBar groups without prose, keep model popup inside sidebar click-away semantics, and auto-create one root session for a settled empty project | verify: focused regressions, UI typecheck/full tests/build and 320/640px browser smoke pass | owner: opencode | claim_time: 2026-08-10T23:07:13Z
- [x] T-085 Pack narrow SaipenBar controls without grid-created empty space | verify: UI typecheck and 640x1080 responsive smoke show natural wrapping with no clipped controls or empty reserved cell | owner: opencode | claim_time: 2026-08-10T22:41:38Z | review_passes: 2
- [x] T-084 Make Queue pasted text editable, harden SaipenBar middle-drag/wheel/wrapping, and support 320px desktop width | verify: UI typecheck, tests and build plus Electron typecheck pass | owner: opencode | claim_time: 2026-08-10T22:35:13Z | review_passes: 2
- [x] T-073 Complete Windows package verification: Electron 38.0.0 exact pin, Windows compression default 5, ZIP/portable EXE generated | verify: SHA-256, resource smoke, root typecheck, test suite, SHIP gate and diff check PASS after host virtual memory recovered | owner: opencode | claim_time: 2026-08-10T21:22:58Z | review_passes: 2
- [x] T-078 Replace literal ballot boxes and emoji-only SAIPEN/tool/status/message/diagnostic labels with font-safe text under forced Verdana | verify: source guard and locale parity tests PASS; UI typecheck PASS; UI suite 589/589 PASS | owner: opencode | claim_time: 2026-08-10T20:59:19Z | review_passes: 2
- [x] T-077 Fix sessions drawer behavior: actual floating render mode drives click-away, hidden-shell reset, tab/session/new-session dismissal, portal safety and Escape | owner: opencode | claim_time: 2026-08-10T20:35:59.4413480Z | verify: focused drawer, TDZ and visibility tests 9/9 PASS; live CDP unavailable, manual smoke steps logged at E-437 | review_passes: 2

- [x] T-076 Prove T-075 cannot conflict with CodeNomad: fix is confined to SAIWORK source and leaves `@suid`/installed CodeNomad untouched; upstream `67cb394e` retains its own temporary Drawer path; SAIWORK and CodeNomad have distinct app IDs, executables, config roots, Electron userData/sessionData and OpenCode data homes; concurrent live run exercised both SAIWORK drawers plus tab teardown, then stopped SAIWORK without stopping CodeNomad | verify: live Playwright CDP smoke zero page/console errors, root typecheck PASS, server 288 PASS/4 SKIP, Electron 118 PASS, CodeNomad processes survived SAIWORK stop | review_passes: 1

- [x] T-075 Fix `Cannot read properties of undefined (reading 'modals')`: renderer stacks showed `@suid/base` ModalManager losing its container while temporary left/right Drawers were cleaned up; floating drawers now use the non-modal persistent path while existing pointer click-away and Escape dismissal remain; static regression blocks temporary Drawers in instance-shell2 | verify: focused regression PASS, UI typecheck PASS, 581 UI tests PASS, diff check PASS | review_passes: 1

- [x] T-074 Remove invalid cavecrew Haiku pins for CodeNomad + SAIWORK: global investigator/reviewer definitions now inherit the selected session model; cavecrew docs require qualified OpenCode IDs and warn that agent definitions are process-cached; fresh config resolution for normal CodeNomad and isolated SAIWORK data profiles contains no model override; SAIWORK sanitizer remains the second guard | verify: global shorthand-pin sweep clean, fresh `opencode debug agent` PASS in both profiles, opencode-plugin tests 8/8 PASS | review_passes: 1

- [x] T-072 Make sidebar collapse obvious + shortcuts layout-neutral: collapse button is always visible for pinned/floating sessions sidebar; every registry shortcut and direct letter/number shortcut resolves physical `KeyboardEvent.code`; new rebinds store `physical: true`, legacy overrides retain `event.key` semantics; Escape/click-away sync visibility and restore focus | verify: UI typecheck PASS, 580 UI tests PASS, 5 focused layout tests PASS, two review passes clean | review_passes: 2

- [x] T-071 Finish employer/public provenance pass: documented exact `67cb394e` CodeNomad basis and default-branch squash vs `backup/pre-squash-history`; reduced "What I changed" to 7 code-backed delta bullets; credited inherited package/docs baseline; removed false npm/Winget release, portable-state, direct-merge, performance/reliability, version and build claims; About changed to truthful "persistent prompt queues" wording; stale public docs normalized | verify: claim map against current code + actual upstream base, README links 6/6 PASS, markdown/diff check PASS, two review passes clean | review_passes: 2

- [x] T-070 Initial README provenance draft + version-drift fix, superseded by T-071 after audit found the default-branch squash boundary and unsupported absolute claims | verify: superseded by T-071 | review_passes: 1

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
- [ ] T-104 [P0] Fix release workflow dependency order: install before dependency-backed bumpVersion | verify: release workflow order test passes and GitHub Release Binaries run succeeds | owner: opencode | claim_time: 2026-08-11T16:28:41Z | blocker: GitHub run 31516153390 passed prepare and all Electron builds; WINGET_GITHUB_TOKEN is empty and npm token lacks @saiwork/saiwork publish access
