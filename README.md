# SAIWORK

**Version 0.0.2** — a SAIPEN-native fork of [CodeNomad](https://github.com/NeuralNomadsAI/CodeNomad) 0.18.0.

**Fork provenance:** SAIWORK preserves the upstream CodeNomad Git history. GitHub's
total commit count therefore includes upstream work and must not be interpreted as
SAIWORK-specific development. Fork-specific changes are documented below.

**Connect agents. Work on projects seamlessly.**

SAIWORK turns OpenCode into a desktop workspace where agents join projects
without breaking flow. It adds the three things a saipen operator needs: the
protocol loaded before the first token, a prompt queue that survives a long run,
and an interface that obeys `saipen/UI.md`.

---

## Upstream / inherited

CodeNomad provides the desktop workspace foundation: multi-instance workspaces,
remote access, session management, voice input, git worktrees, SideCars, command
palette, file browser, auth, notifications, and i18n. Those features remain
credited to CodeNomad and behave as they do upstream.

## What I changed (SAIWORK delta)

Every item below is verified SAIWORK-specific code in this repository — it does
not exist in upstream CodeNomad.

### SAIPEN protocol injection before agent work

Every workspace SAIWORK opens gets `BOOT.md` and `STYLE.md` injected into
OpenCode's `instructions`, so the cold-start kernel and the voice contract are
in context before the agent's first token.

The protocol is read from the live install, never vendored. The install root is
resolved in this order, first hit wins:

1. `saipen_home:` in the opened project's `.saipen/STATE.md`
2. the `saipen.home` setting in the SAIWORK server config
3. the `SAIPEN_HOME` environment variable
4. `~/saipen`, then `~/.saipen`

Both protocol layouts are supported: `<home>/saipen/BOOT.md` and
`<home>/BOOT.md`. If neither exists, SAIWORK logs why and starts the session
without injection rather than guessing.

`GET /api/saipen/status?folder=<path>` reports exactly which files a session
will receive, plus the state of every sub-agent in the project.

### Persistent prompt / task queue

Stack prompts while the agent works; each one is sent when the session goes
idle. Queues persist across restarts, per session.

- `Alt+Enter` queues instead of sending
- reorder, edit, and delete entries in place
- pause and resume (`Ctrl/Cmd+Shift+Q`) — a paused queue sends nothing
- send the head immediately without waiting for idle
- a failed send goes back to the front of the queue instead of vanishing

Shell commands and slash commands are never queued: both resolve against state
that may have moved by the time the queue drains.

### SAIPEN command / sub-agent state visibility

The `CORE.md` §1.10 shortcut table as buttons, above the prompt:

`gg` `hh` `cc` `ccc` `ss` `sss` `dd` `aa` `qq` `qqq` `ee` `eee` `pp` `tt` `sc`

Argument-less shortcuts send on click. `gg` and `dd` need text, so they land in
the prompt for you to finish instead of firing bare. Expanding the bar shows the
phase, ticket and timestamp each sub-agent last wrote to its own `STATE.md` —
so "is the wiki fresh, are the docs translated" is answered from the record
rather than from memory. Toggle with `Ctrl/Cmd+Shift+K`.

The SAIPENVIEW tab buttons open Status, Board, Log, State and Plan views
straight from `.saipen/` — every file editable in place, with the panel staying
mounted so toggling never re-fetches.

SAIPEN Goal Auto is a three-state control (on / off / on-but-queue-off) that
keeps enqueueing `saipen continue` while `BOARD.md` has TODO work, per-project
overrides included; it stops the moment the board is empty and never re-arms a
duplicate continue.

### Portable / local Windows workflow

`START_HIDDEN.vbs` starts the app console-free. Portable builds keep settings,
sessions and window state in a `saiwork-data` folder beside the executable; an
empty `saiwork-data` folder or `SAIWORK_DATA_DIR` redirects storage there.
Window presets (Settings > Window) save and restore layouts and snap the active
window with `Ctrl/Cmd+Q`; the menu bar can be hidden.

### Vintage Golden UI layer

The whole interface follows `saipen/UI.md`: Verdana without antialiasing, 2px
bevels, zero rounded corners, zero shadows, zero animation, one palette in every
theme mode. The upstream token file is left untouched and overridden by
`packages/ui/src/styles/vintage-golden.css`, so merges from upstream stay
reviewable.

### Isolation of fork-specific code

Fork-specific code lives in its own files (`saipen/core.ts`, `prompt-queue.ts`,
`saipen-bar.tsx`, `vintage-golden.css`, `shortcuts/saiwork.ts`) so upstream
merges stay reviewable.

### Split panes and detached windows

Run two sessions side by side: the SAIPEN bar's Split button opens a picker of
your other sessions (this project's and other projects' active ones, already
shown excluded), and each pane gets its own OS window via its Detach button.
The divider between panes is draggable; detached panes re-attach back into the
shell. Pane state is per-window and per-instance.

---

## Requirements

- **[OpenCode CLI](https://opencode.ai)** in your `PATH`
- **Node.js 18+**
- A saipen install, if you want the protocol injection (clone
  `github.com/vacterro/saipen`)

## Running it

**Double-click `START_HIDDEN.vbs`** on Windows for console-free startup, or run
`./START.sh` on macOS and Linux. Windows startup logs go to `dev.log`; use
`START.bat` only when you want a visible debug console.

It checks Node, warns if `opencode` is missing, installs dependencies on the
first run, and starts the desktop app. Nothing else to configure.

Same thing by hand, if you prefer:

```bash
npm install
npm run dev
```

Electron is the primary shell for 0.0.2. The Tauri shell still compiles but is
not polished.

### Portable build

```bash
npm run build:win --workspace @saiwork/electron-app
```

Produces `SAIWORK-portable-x64-0.0.2.exe` in `packages/electron-app/release/` —
one file, no installer, no registry writes. It keeps its settings, sessions and
window state in a `saiwork-data` folder beside itself, so the whole thing moves
with a USB stick.

The same applies to any build: drop an empty `saiwork-data` folder next to the
executable and SAIWORK stores everything there instead of in your profile.
`SAIWORK_DATA_DIR` overrides the location outright.

### Server mode

For browser or remote access:

```bash
npm run build --workspace @saiwork/saiwork
node packages/server/dist/bin.js --password <your-password>
```

There are no published npm packages yet — build from source.

### Tests

```bash
npm test
```

Runs all three suites -- UI, server, Electron -- and fails on the first one that
fails. The UI suite needs `--conditions=browser`: several tests import
`solid-toast`, which calls a client-only API while the module loads, so under
Node's default resolution solid hands back its server build and the file throws
before a single test runs. The script already passes the flag.

---

## Layout

| Package | Description |
|---------|-------------|
| `packages/server` | Core logic and CLI: workspaces, OpenCode proxy, API, auth, speech, SAIPEN resolution |
| `packages/ui` | SolidJS frontend |
| `packages/electron-app` | Desktop shell |
| `packages/tauri-app` | Tauri shell (experimental) |

## Staying current with upstream

The `upstream` remote points at CodeNomad. SAIWORK preserves the upstream Git
history, so repository commit totals on GitHub include CodeNomad's work —
they are not SAIWORK-specific development. Fork-specific code is kept in its
own files (`saipen/core.ts`, `prompt-queue.ts`, `saipen-bar.tsx`,
`vintage-golden.css`, `shortcuts/saiwork.ts`) so a merge touches as little
shared code as possible.

```bash
git fetch upstream
git merge upstream/main
```

---

[MIT License](LICENSE) · upstream CodeNomad by [Neural Nomads](https://github.com/NeuralNomadsAI)
