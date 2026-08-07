# Changelog

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

- `START.bat` and `START.sh` check the toolchain, install dependencies on first
  run, and start the app.
- Windows `portable` target: a single executable with no installer and no
  registry writes.
- Portable data: a `saiwork-data` folder beside the executable holds all state.
  `SAIWORK_DATA_DIR` overrides the location.
- App id `ai.saipen.saiwork`, per-project data directory `.saiwork`.
