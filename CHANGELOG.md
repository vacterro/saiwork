# Changelog

## 0.0.2 (2026-08-10)

Work-in-progress SAIWORK UI, tracked since `0.0.1` in `.saipen/LOG.md`
(E-001..E-363).

### Hardening & isolation (T-061..T-068, E-386..E-401)

- **OpenCode storage isolation** (`T-065`): every spawned `opencode serve` gets
  `XDG_DATA_HOME` → `~/.config/saiwork/opencode-data`, so sessions/history/DB
  never mix with a packaged CodeNomad install or a bare opencode CLI; first
  launch seeds the private `auth.json` from the global one. `XDG_DATA_HOME`
  added to WSL path propagation.
- **Single-session shell** (`T-066`): with one session the sidebar is never
  pinned (it got stuck that way) — only a floating drawer via the always-visible
  hamburger.
- **Launcher resilience** (`T-064`): `START_HIDDEN.vbs` probes `dev.log` for a
  write lock and falls back to a timestamped log instead of dying silently.
- **TDZ blank-shell guard** (`T-063`): `instance-shell2.tdz.test.ts` fails if a
  `createMemo`/`createEffect` reads a component `const` declared later (the
  twice-seen crash pattern).
- **DRY** (`T-061`, `T-062`, `T-067`): shared `formatRelativeTime`, one
  `useNow` clock (three hand-rolled copies migrated), dead `formatCompactCount`
  removed.
- **Orphan removal** (`T-068`): deleted 7 zero-referenced UI components
  (session-picker, legacy settings modals, remote-access-overlay,
  message-list-header, theme-mode-toggle, code-block-inline).
- **SAIPEN bar** (unreleased UI): text shortcut buttons (icons rendered empty),
  `PLAN` button opens a compact popover with the agent's plan list.

### SAIPEN

- **Multi-session split panes** (`T-048`, E-312/E-313/E-325/E-326/E-329): the
  session area splits into draggable panes (5px col-resize handle, flex-grow
  weights 0.1–0.9), per-window, per-instance isolation via a pure `panes.ts`
  model plus a reactive `stores/panes.ts` bridge. Split is **choosable**: the
  bar Split button opens a session picker (this project's other sessions +
  other projects' active sessions, already-shown excluded) instead of
  auto-splitting; split panes outside the active family no longer show
  "Session not found".
- **Detach pane to a separate window** (`pane detach`): each pane has a Detach
  button; the routed window opens `local/session/<id>` with `?instance=&session=`
  routed through `window:open-session-pane`, waits for the session to hydrate
  before selecting.
- **SAIPENVIEW panel** (`saipen-view`): `GET /api/saipen/view` serves
  allowlisted STATE/BOARD/LOG (LOG capped 200 lines/64KB) plus
  `.saipen/kitchen/*.md` plans; five direct tab buttons
  Status/Board/Log/State/Plan; per-tab empty states; collapsible plan rows.
- **Interactive memory editing**: `PUT /api/saipen/file` (strict allowlist,
  traversal-proof, 256KB cap) with Edit/Save/Cancel textareas on every view
  panel tab and each plan; panel stays mounted (`display:none`) so toggling
  never re-fetches.
- **Sub-agent freshness table**: manifest rows expose lifecycle, OUTBOX package
  verdicts, freshness errors, and issues; fixed layout + word-wrap.
- **SAIPEN bar** (single-line): smart shrink (rare production commands
  `ccc/ee/eee/qq/qqq/pp` hide under 980px, core compress under 700px), golden
  accented actions, Ctrl/Cmd+Shift+K toggle, `xx` shortcut sheet from the live
  registry (`F1`).
- **Shortcut mode**: `saipenShortcutsImmediate` — idle shorts send now, busy
  ones queue; a busy-gap guard prevents two quick presses overlapping;
  tooltips.
- **Protocol auto-update** (default off): `SaipenSettings.autoUpdate` + server
  periodic git pull (6h, unref'd) + settings toggle.
- **Launch-state awareness**: `SaipenLaunchState`, `saipenRestartRequired`,
  effective + restartRequired in `/api/saipen/status`, bar reports effective
  and warns on drift.

### Goal Auto

- `saipenGoalAuto` preference split off `queueEnabled`; a **three-state control**
  in the bar (on / off / on-but-queue-off) with a text line naming the next
  action.
- **Per-project**: `saipenGoalAutoByFolder` map keyed by workspace folder; the
  resolver falls back to the global prefs; toggles only store departures from
  the global defaults.
- Stops the moment `todoCount` is 0 (even a stray DOING ticket no longer keeps
  it alive); dispatched-continue marker clears when the session goes busy or
  the pane unmounts; bounded retry (5s/1 retry, cancellable) on transient
  status failures.

### Prompt queue

- `Alt+Enter` queues; reorder/edit/delete; pause/resume
  (`Ctrl/Cmd+Shift+Q`); queues persist per session.
- **Send all / Separately** (`queueSendMode`): all-mode combines queued texts
  into one message/one answer, re-queues on error; failed send restores the
  draft into the input.
- **Collapse/expand**: header line toggles (click or Enter/Space), persisted
  `promptQueueExpanded` flag, header shows an inline comma-separated peek of
  queued texts (tooltip has the full list); empty state reserves fixed height.
- Queue button in the toolbar also expands the panel; pressed-in (sunken)
  states on queue controls.

### Sessions & window management

- Session open scrolls to the newest message after async hydration.
- Session close in a fixed safe order (abort running work → refresh under a
  15s deadline → drop selection) with explicit failure dialog.
- Successive ML message separation: user-message border softened to a
  desaturated slate blue (readable at a glance, palette untouched).
- **Window presets**: preset CRUD (add/edit/delete/use/make active),
  `resolvePresetBounds` snap math (center/clamp/min), `Ctrl+Q` snaps to the
  active preset via new `window:get-work-area` / `window:snap-to-bounds` IPC;
  Window settings section in settings.
- **Hide menu bar**: `hideMenuBar` preference + Advanced settings toggle, uses
  all Windows knobs (`setAutoHideMenuBar(true)` + `setMenuBarVisibility(false)`
  + `removeMenu()` + `setApplicationMenu(null)`); the toolbar Queue button
  expands the queue panel.
- Pinned left sidebar auto-hides when the instance has only one session
  (floating drawer stays); Model button opens the floating drawer regardless
  of pin state.

### Vintage Golden / UX polish

- Turquoise accents removed — accent-primary remaps to gold, message borders /
  timeline-active to bevel highlights; palette tokens untouched.
- State indicators brightened and distinguished (success/warning/error/
  working/compacting/idle), selection/highlight brightened; bevel edges
  unified on `bevelLight`; Queue/Goal Auto/expand toggles share sunken
  pressed-in states.
- Prompt bar compaction: action rails flattened into compact horizontal strips
  pinned to field corners, 56px field minimum kept.
- Tab strip overflow arrows, tab-scroll; timeline segments; hidden HMR sockets.

### Reliability & bug fixes (highlights)

- Full suite kept green across the build (513+ UI tests at the last count,
  `npm test exit 0` on every change): queue idempotent failed-head restore,
  Goal Auto dispatch guards, model-pin resolution (invalid pins inherit the
  session model, unavailable models disabled), raw-text rendering for user
  messages (backslashes, quotes, underscores, backticks survive Markdown),
  sub-agent lifecycle verdicts, supervised event streams with backoff,
  session-close timer cleanup, and Linux icon rebuilds.

## 0.0.1

First SAIWORK release. Fork of CodeNomad 0.18.0.

### SAIPEN

- SAIPEN Core is injected into every workspace through OpenCode's `instructions`
  field, so `BOOT.md` and `STYLE.md` are in context before the agent's first
  token. The protocol is read from the live install, never vendored.
- The install root resolves from the opened project's `.saipen/STATE.md`, then
  server config, then `SAIPEN_HOME`, then `~/saipen` and `~/.saipen`. Both
  `<home>/saipen/BOOT.md` and `<home>/BOOT.md` layouts are supported.
- `GET /api/saipen/status?folder=<path>` reports which files a session receives
  and the state of every sub-agent in the project.
- SAIPEN command bar with the 15 shortcuts from `CORE.md` §1.10, plus a table
  showing what each sub-agent last recorded in its own `STATE.md`.
  Toggle: `Ctrl/Cmd+Shift+K`.

### Prompt queue

- Queue prompts while the agent works; each is sent when the session goes idle.
- `Alt+Enter` queues instead of sending.
- Reorder, edit and delete entries; pause and resume with `Ctrl/Cmd+Shift+Q`.
- A failed send returns to the front of the queue instead of being lost.
- Queues persist across restarts, per session.
- Shell and slash commands are never queued.

### Vintage Golden

- The saipen `UI.md` palette applied as an override layer over the upstream
  token file: Verdana without antialiasing, 2px bevels, no rounded corners, no
  shadows, no animation, one palette in every theme mode.
- The 10/11/12/14/16 type scale is enforced by pinning Tailwind's `text-*`
  utilities, so an upstream merge cannot reintroduce an off-scale size.
- `F1` opens a keyboard reference built from the live shortcut registry.

### Behaviour changes from upstream

- Yolo mode defaults to ON. Every permission request auto-approves, including
  file writes, deletions and shell commands. Turning it off for a session still
  sticks across restarts. `SAIWORK_YOLO_DEFAULT=false` restores opt-in.
- The right panel starts closed and unpinned, and its contents mount only while
  open. Its git status and diff views were loading on every session start.
- DevTools no longer open automatically in development. Use the View menu or
  `SAIWORK_DEVTOOLS=1`.
- Removed the Discord link, the GitHub star pill and the star-history badge:
  this fork has none of them.

### Packaging

- `START_HIDDEN.vbs` starts Windows development mode without a console and logs
  to `dev.log`; `START.bat` remains the visible debug launcher. `START.sh`
  handles macOS and Linux.
- Windows `portable` target: a single executable with no installer and no
  registry writes.
- Portable data: a `saiwork-data` folder beside the executable holds all state.
  `SAIWORK_DATA_DIR` overrides the location.
- App id `ai.saipen.saiwork`, per-project data directory `.saiwork`.
