# SAIWORK

**Version 0.0.1** — a SAIPEN-native fork of [CodeNomad](https://github.com/NeuralNomadsAI/CodeNomad) 0.18.0.

CodeNomad turns OpenCode from a terminal tool into a desktop workspace. SAIWORK
keeps that and adds the three things a saipen operator needs: the protocol
loaded before the first token, a prompt queue that survives a long run, and an
interface that obeys `saipen/UI.md`.

---

## What this fork changes

### SAIPEN Core is loaded before the session starts

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

### SAIPEN command bar

The `CORE.md` §1.10 shortcut table as buttons, above the prompt:

`gg` `hh` `cc` `ccc` `ss` `sss` `dd` `aa` `qq` `qqq` `ee` `eee` `pp` `tt` `sc`

Argument-less shortcuts send on click. `gg` and `dd` need text, so they land in
the prompt for you to finish instead of firing bare. Expanding the bar shows the
phase, ticket and timestamp each sub-agent last wrote to its own `STATE.md` —
so "is the wiki fresh, are the docs translated" is answered from the record
rather than from memory.

Toggle with `Ctrl/Cmd+Shift+K`.

### Prompt queue

Stack prompts while the agent works; each one is sent when the session goes
idle.

- `Alt+Enter` queues instead of sending
- reorder, edit, and delete entries in place
- pause and resume (`Ctrl/Cmd+Shift+Q`) — a paused queue sends nothing
- send the head immediately without waiting for idle
- a failed send goes back to the front of the queue instead of vanishing
- queues persist across restarts, per session

Shell commands and slash commands are never queued: both resolve against state
that may have moved by the time the queue drains.

### Vintage Golden

The whole interface follows `saipen/UI.md`: Verdana without antialiasing, 2px
bevels, zero rounded corners, zero shadows, zero animation, one palette in every
theme mode. The upstream token file is left untouched and overridden by
`packages/ui/src/styles/vintage-golden.css`, so merges from upstream stay
reviewable.

`F1` opens the keyboard reference, which reads the live shortcut registry rather
than a hand-written list.

---

## Everything upstream does, SAIWORK still does

Multi-instance workspaces, remote access, session management, voice input, git
worktrees, SideCars, command palette, file browser, auth, notifications, and
i18n all work as they do in CodeNomad.

---

## Requirements

- **[OpenCode CLI](https://opencode.ai)** in your `PATH`
- **Node.js 18+**
- A saipen install, if you want the protocol injection (clone
  `github.com/vacterro/saipen`)

## Running it

**Double-click `START.bat`** (Windows) or run `./START.sh` (macOS, Linux).

It checks Node, warns if `opencode` is missing, installs dependencies on the
first run, and starts the desktop app. Nothing else to configure.

Same thing by hand, if you prefer:

```bash
npm install
npm run dev
```

Electron is the primary shell for 0.0.1. The Tauri shell still compiles but is
not polished.

### Portable build

```bash
npm run build:win --workspace @saiwork/electron-app
```

Produces `SAIWORK-portable-x64-0.0.1.exe` in `packages/electron-app/release/` —
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

---

## Layout

| Package | Description |
|---------|-------------|
| `packages/server` | Core logic and CLI: workspaces, OpenCode proxy, API, auth, speech, SAIPEN resolution |
| `packages/ui` | SolidJS frontend |
| `packages/electron-app` | Desktop shell |
| `packages/tauri-app` | Tauri shell (experimental) |

## Staying current with upstream

The `upstream` remote points at CodeNomad. Fork-specific code is kept in its own
files (`saipen/core.ts`, `prompt-queue.ts`, `saipen-bar.tsx`,
`vintage-golden.css`, `shortcuts/saiwork.ts`) so a merge touches as little
shared code as possible.

```bash
git fetch upstream
git merge upstream/main
```

---

[MIT License](LICENSE) · upstream CodeNomad by [Neural Nomads](https://github.com/NeuralNomadsAI)
