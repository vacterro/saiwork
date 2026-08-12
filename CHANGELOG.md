# Changelog

## [0.1.23] - 2026-08-12

References such as `T-083` and `E-557` below are internal `.saipen` work-log
identifiers, not Git commits or release history.

### Antigravity tool responses (T-716)

- Every `functionResponse` now echoes the tool-call `id` it answers: the
  Antigravity backend rejects id-less responses with
  `tool_result.tool_use_id: Field required`. The OpenAI `tool_call_id` is
  passed through unchanged (the same id already on the `functionCall` part);
  regression test + contract doc updated.

## [0.1.22] - 2026-08-12

References such as `T-083` and `E-557` below are internal `.saipen` work-log
identifiers, not Git commits or release history.

### Integrity & reliability hardening (T-715, T-079..T-082, T-081)

- **Settings persistence fails closed (T-081)**: an unreadable/malformed config
  or state file is a persistent load failure, never silently treated as empty;
  mutations are one transactional temp-write + fsync + rename, committing the
  cache only after the write is durable. Storage errors map to HTTP 500 on
  GET/PATCH; a corrupt source is never overwritten; the `as any` event escape
  was removed.
- **Atomic prompt fan-out**: one server transaction over all targets — any
  conflict/storage failure commits NONE, so a "failed" fan-out can never leave
  prompts queued behind a generic error (the old per-target loop compensated
  with removes whose results were ignored).
- **Workspace identity, not a case-folded path**: `saipen.changed` now carries
  the canonical `workspaceId`; panels filter by it, so two workspaces differing
  only by path case can never refresh/conflict each other.
- **Strict `extraInstructions` contract**: entries must be absolute paths
  (win32 or posix), canonicalized, regular readable files; relative/directory/
  missing entries are surfaced as rejected instead of resolved against the CWD.
- **D-03 live-core digests**: an in-flight OpenCode process never re-reads its
  instruction files, so same-path content drift of the protocol files is now
  detected via launch content digests and surfaced as `restartRequired`.
- **Background-process index fails closed (T-080)** and every spawn/stream/
  finalize failure path is covered by fault-injection tests (T-079); the
  binary `--version` probe is now async, bounded at 4s with a process-tree
  kill on timeout (T-082); a dead unbounded sync shell probe was removed.

## [0.1.21] - 2026-08-12

References such as `T-083` and `E-557` below are internal `.saipen` work-log
identifiers, not Git commits or release history.

### Streaming + dead-code hardening (T-714)

- **SSE parsers hardened against CRLF**: the `\n\n`-only frame splitter (the
  bug that truncated Antigravity answers) existed in three more consumers —
  the opencode-plugin `/event` stream, the server instance event stream, and
  the FreeBuff engine stream. Each now normalizes CRLF/CR line endings before
  splitting and flushes a trailing unterminated frame, so a transport/proxy
  that rewrites line endings can no longer collapse a stream to its first
  frame or grow the buffer without bound.
- **Dead code removed**: `frameHasFinishReason` (google/shim.ts) had zero
  importers and was deleted.

## [0.1.2] - 2026-08-12

References such as `T-083` and `E-557` below are internal `.saipen` work-log
identifiers, not Git commits or release history.

### Stability fixes

- **Antigravity answers were truncated to one word (T-712)**: the Antigravity
  backend (cloudcode-pa) streams CRLF-delimited SSE frames, but the shim split
  frames on `\n\n` only, so the whole stream collapsed and just the first
  `data:` line survived — tool-call turns still worked (the tool decision is
  the first frame), but a text answer came back as its first word. Frames are
  now line-ending-normalized before splitting; regression test covers CRLF.
- **Electron main-process crash dialog (T-713)**: a benign WebContents
  teardown race (`Object has been destroyed` from `WebContents.disconnectRenderer`
  during `render-process-gone`) raised an uncaught exception in the main
  process and popped Electron's native error dialog. A process-level guard now
  suppresses the dialog, logs teardown races as warnings and keeps the app
  running (window-recovery reopens what was lost); session-pane window destroy
  is deferred out of Electron's event dispatch.

## [0.1.1] - 2026-08-12

References such as `T-083` and `E-557` below are internal `.saipen` work-log
identifiers, not Git commits or release history.

### FreeBuff 0.0.55 integration + slot resilience (T-710)

- **Always-max reasoning**: FreeBuff 0.0.55 reasons per-thread
  (`reasoningEffort`); the gateway, the FreeBuff tab and the verify script now
  create threads with the model's maximum effort (`high` for the free-tier
  models, engine default was `medium`). Verified live on 0.0.55: DeepSeek V4
  Flash streams `reasoning` + `text` agent events, admission runs
  `admitting -> session-admitted -> request-sent`. Model catalog gains
  reasoning metadata (efforts, default effort, 1M context window).
- **Slot resilience**: the `/fb/v1` gateway now waits out a held slot
  (bounded retry ~35s with a `> waiting for the FreeBuff slot…` step) instead
  of failing the first message; failed admissions never consume quota. New
  `POST /api/freebuff/release-slot` closes every idle holder SAIWORK can reach
  and confirms against the codebuff.com session counter; the FreeBuff bar
  panel shows slot state and a **Release slot** button (i18n in all 9 locales).
- **Window icon**: titlebar/taskbar now use `SAIPEN_Orange1.png` as-is
  (aliased); Windows windows load a multi-size `.ico` (16-256, nearest-neighbor)
  so the OS picks native sizes instead of smoothing the PNG.

### SAIPEN write integrity (T-087..T-089)

- **Optimistic-concurrency `.saipen` saves**: every write carries the SHA-256
  revision the client last read; a mismatch returns a structured `409
  CONFLICT` and the newer on-disk state is never overwritten. Writes are
  serialized per project and land via an atomic same-directory temp-file
  replace. `LOG.md` stays read-only (it is the agent's append-only journal).
- **Workspace-bound SAIPEN API**: `/api/saipen/*` resolves the requested
  folder to a registered SAIWORK workspace, rejecting unknown folders,
  traversal, non-canonical paths and symlink escapes. The relative-file
  allowlist still gates every target.

### Live SAIPEN state (T-090)

- A server-side file watcher watches every registered workspace's
  `.saipen/` (STATE/BOARD/LOG and `kitchen/*.md`), debounces bursts and
  publishes a workspace-scoped `saipen.changed` event over the existing SSE
  stream. The embedded SAIPENVIEW refreshes automatically on a clean editor;
  a dirty draft is preserved and marked as conflicting until the user reloads
  or keeps it. No polling.

### One canonical SAIPEN interpretation boundary (T-091, T-098)

- BOARD ticket status is decided by the canonical section a ticket sits under
  (`- [ ]` under `## BLOCKED` is blocked), not its checkbox, in one shared
  parser on the server. The UI renders the structured `boardSections` payload
  and delegates STATE parsing to the canonical server parser; the duplicate
  UI parser was removed.

### Single-owner prompt queue (T-092)

- The prompt queue moved from per-renderer `localStorage` to a
  server-authoritative store with revisioned CAS mutations. The main window
  and every detached session window share ONE queue; a stale writer gets a
  `409` and re-syncs, and an atomic dequeue guarantees at most one dispatch
  per queued prompt. Queue state is persisted atomically and mirrored to all
  windows over `queue.changed` SSE events. The complete mutation and shared-file
  persist run under one global transaction; write, rename, or durability failure
  leaves authoritative memory unchanged and publishes no success event. Existing
  `saiwork.prompt-queue.v1` data migrates once under a browser-wide lock before
  renderer storage is removed.

### Detached-window recovery (T-083)

- Closing the main window while detached session windows survive no longer
  suppresses main-window recovery: activating the app recreates it whenever
  the main window is gone, while the detached panes stay open. A dedicated
  registry now owns each `host + paneId` child: duplicate detach focuses the
  existing child, failed loads roll back, and close/crash recovery restores the
  exact pane identity without losing surviving-child ownership (`T-099`).

### Integration and release hardening (T-100..T-103)

- SAIPEN Core instruction files must remain inside `protocolDir`; absolute,
  parent-traversal, symlink, and junction escapes are rejected. LOG and kitchen
  caps use byte-safe UTF-8 truncation for ASCII, Cyrillic, Estonian, Japanese,
  and emoji boundaries.
- Root typecheck now runs server, UI, then Electron. Release checks reject a
  missing workspace typecheck, version drift across SAIWORK manifests/locks,
  README/CHANGELOG drift, a non-exact Electron `38.0.0` pin, and mismatched
  Windows ZIP/portable artifact metadata. Version bumps resolve semver and update
  only known package, lock, Tauri, README, and CHANGELOG fields under an exclusive
  lock plus a durable recovery journal. Required markers and linked paths fail
  closed, and any failed update restores the metadata snapshot without spawning
  `npm.cmd` or lifecycle child processes.

### Hardening & isolation (T-061..T-068, E-386..E-401)

- **OpenCode storage isolation** (`T-065`): every spawned `opencode serve` gets
  `XDG_DATA_HOME` → `~/.config/saiwork/opencode-data`, so sessions/history/DB
  never mix with a packaged CodeNomad install or a bare opencode CLI; first
  launch seeds the private `auth.json` from the global one. `XDG_DATA_HOME`
  added to WSL path propagation.
- **Single-session shell** (`T-066`): with one session the sidebar is never
  pinned (it got stuck that way) — only a floating drawer via the always-visible
  hamburger.
- **Drawer cleanup crash** (`T-075`): floating sidebars no longer use SUID's
  temporary Drawer modal manager, which could lose its container during shell
  teardown and throw `Cannot read properties of undefined (reading 'modals')`.
- **Drawer interaction** (`T-077`): floating session drawers close on outside
  click and session/tab changes, preserve portaled controls and Escape behavior,
  and keep hidden shell state from reopening or mutating the active drawer.
- **Font-safe compact labels** (`T-078`): SAIPEN package controls, timeline tool
  labels, task statuses and message diagnostics use localized or ASCII text
  instead of ballot-box and emoji glyphs that could render as squares.
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
  session area splits into side-by-side panes with per-window, per-instance
  isolation via a pure `panes.ts` model plus a reactive `stores/panes.ts`
  bridge. Split is **choosable**: the
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
  traversal-proof, 256KB cap) with Edit/Save/Cancel controls for displayed
  allowlisted files; Status remains read-only, and the panel stays mounted
  (`display:none`) while toggled off.
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

- `Alt+Enter` queues; reorder/edit/delete; explicit pause/resume controls;
  queues persist per session.
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
- Sessions sidebar has an always-visible collapse button. Registered shortcuts
  and direct letter/number shortcuts use physical key codes, so bindings such
  as `Alt+D` work across keyboard layouts; new custom bindings do the same.

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

### Packaging

- Electron is pinned to `38.0.0`, and Windows packaging defaults to 7z level 5
  so the bundled server/runtime fits in memory during portable archive creation.

### Reliability & bug fixes (highlights)

- Local validation recorded passing test runs during development; this is not a
  per-commit CI guarantee. Covered behavior includes queue idempotent failed-head restore,
  Goal Auto dispatch guards, model-pin resolution (invalid pins inherit the
  session model, unavailable models disabled), raw-text rendering for user
  messages (backslashes, quotes, underscores, backticks survive Markdown),
  sub-agent lifecycle verdicts, supervised event streams with backoff,
  session-close timer cleanup, and Linux icon rebuilds.

## 0.0.1

First tagged SAIWORK version, based on CodeNomad's 0.18.0 development commit
`67cb394e`.

### SAIPEN

- When SAIPEN integration is enabled and the files resolve, SAIWORK adds the
  live `BOOT.md` and `STYLE.md` paths to OpenCode's `instructions` before a new
  OpenCode process launches. The protocol is not vendored.
- The install root resolves from the opened project's `.saipen/STATE.md`, then
  server config, then `SAIPEN_HOME`, then `~/saipen` and `~/.saipen`. Both
  `<home>/saipen/BOOT.md` and `<home>/BOOT.md` layouts are supported.
- `GET /api/saipen/status?folder=<path>` reports configured and effective
  instruction paths plus discovered subSaipen state.
- SAIPEN command bar with the 15 shortcuts from `CORE.md` §1.10, plus a table
  showing what each sub-agent last recorded in its own `STATE.md`.
  Toggle: `Ctrl/Cmd+Shift+K`.

### Prompt queue

- Queue prompts while the agent works; each is sent when the session goes idle.
- `Alt+Enter` queues instead of sending.
- Reorder, edit and delete entries; pause and resume with `Ctrl/Cmd+Shift+Q`.
- A failed send returns to the front of the queue instead of being lost.
- Queues persist across restarts, per session.
- Shell commands and recognized slash commands bypass the queue.

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
- Windows `portable` target: a single executable with no installer.
- Portable Electron data: a `saiwork-data` folder beside the executable redirects
  Electron `userData`; `SAIWORK_DATA_DIR` overrides that location. Server,
  OpenCode, and some client/window state retain separate home-directory paths.
- App id `ai.saipen.saiwork.client`, per-project data directory `.saiwork`.
