<img width="960" height="1080" alt="2026-08-11_005637" src="https://github.com/user-attachments/assets/52a3c014-f2f6-418a-b00e-01f9ed9b8b41" />
<img width="256" height="256" alt="SAIPEN_Orange1" src="https://github.com/user-attachments/assets/d71315d6-1c39-444e-8623-0c87a15fb420" />

# SAIWORK

**Version 0.1.30** - a downstream fork based on [CodeNomad](https://github.com/NeuralNomadsAI/CodeNomad)'s 0.18.0 development commit [`67cb394e`](https://github.com/NeuralNomadsAI/CodeNomad/commit/67cb394e8f38854383bd57a0794274a024ef3d93). Release history lives in [CHANGELOG.md](CHANGELOG.md); package versions are the single source of truth for a build.

**Fork provenance:** SAIWORK preserves the upstream CodeNomad Git history on the
[`backup/pre-squash-history`](https://github.com/vacterro/saiwork/tree/backup/pre-squash-history)
branch. The default `saiwork` branch was squash-imported on August 10, 2026 and
does not contain CodeNomad's commits or contributor history. GitHub commit counts
for the backup branch therefore include upstream work and must not be interpreted
as SAIWORK-specific development. Fork-specific changes are documented below.

**Connect agents. Work on projects.**

SAIWORK extends CodeNomad with SAIPEN integration, a persistent prompt queue,
and fork-specific desktop and UI workflows.

---

## Upstream / inherited

CodeNomad provides the desktop workspace foundation: multi-instance workspaces,
remote access, session management, voice input, Git worktrees, SideCars, command
palette, file browser, authentication, notifications, theming, and i18n. Those
capabilities originate upstream. SAIWORK modifies some integrations but does not
claim their baseline implementation.

## What I changed

I maintain SAIWORK as a focused downstream fork of CodeNomad for long-running
AI-assisted development.

My work in this fork focuses on:

- integrating configurable live-path SAIPEN `BOOT.md` and `STYLE.md`
  instructions before new OpenCode process launches, with project, config,
  environment, and fallback resolution plus launch-state reporting;
- adding a persistent per-session prompt queue with edit, reorder, delete,
  pause/resume, idle or manual dispatch, and rejected-send restoration to the
  queue front before pausing;
- exposing SAIPEN shortcut controls, allowlisted project-state views and edits,
  discovered subSaipen state, and Goal Auto queueing controls in the UI;
- adding a console-free Windows launcher, portable Electron `userData` routing,
  single-window geometry presets, snap controls, and menu visibility settings;
- applying a Vintage structural UI layer with a Golden default and selectable
  palettes while leaving CodeNomad's token definitions unchanged;
- adding split session panes and detached session windows; and
- placing major fork feature cores in dedicated files while keeping substantial
  integration changes explicit in shared CodeNomad files.

---

## Requirements

- **[OpenCode CLI](https://opencode.ai)** in your `PATH`
- **Node.js 20.19+ (20.x) or 22.12+**
- A SAIPEN install, if you want the protocol injection (clone
  `github.com/vacterro/saipen`)

## Running it

**Double-click `START_HIDDEN.vbs`** on Windows for console-free startup, or run
`./START.sh` on macOS and Linux. Windows startup logs go to `dev.log`; use
`START.bat` only when you want a visible debug console.

It checks Node, warns if `opencode` is missing, installs dependencies on the
first run, and starts the desktop app.

Same thing by hand, if you prefer:

```bash
npm install
npm run dev
```

Electron is the primary shell. The Tauri shell remains experimental.

### Portable target

```bash
npm run build:win --workspace @saiwork/electron-app
```

Produces `SAIWORK-x64-0.1.30.zip` and the one-file
`SAIWORK-portable-x64-0.1.30.exe` in `packages/electron-app/release/`. The build
is locally verified; no SAIWORK binary release has been published.

An empty `saiwork-data` folder beside an Electron executable redirects
Electron's `userData` there; `SAIWORK_DATA_DIR` overrides that location. Server
configuration, OpenCode data, and some client/window state retain separate
home-directory paths, so this is not a fully self-contained USB profile.

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

Runs all four suites -- UI, server, OpenCode plugin, and Electron -- and fails on
the first one that fails. The UI suite needs `--conditions=browser`: several
tests import `solid-toast`, which calls a client-only API while the module loads,
so under Node's default resolution solid hands back its server build and the file throws
before a single test runs. The script already passes the flag.

---

## Layout

| Package | Description |
|---------|-------------|
| `packages/server` | Core logic and CLI: workspaces, OpenCode proxy, API, auth, speech, SAIPEN resolution |
| `packages/ui` | SolidJS frontend |
| `packages/electron-app` | Desktop shell |
| `packages/tauri-app` | Tauri shell (experimental) |

## Upstream reference

The `upstream` remote points at CodeNomad. Because the default `saiwork` branch
was squash-imported and has no merge base with CodeNomad, upstream updates must
be reviewed and ported explicitly rather than applied with a plain `git merge`.

```bash
git fetch upstream
git diff 67cb394e..upstream/dev
```

---

[MIT License](LICENSE) · upstream CodeNomad by [Neural Nomads](https://github.com/NeuralNomadsAI)
