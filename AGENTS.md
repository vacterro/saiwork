# AGENT NOTES

## Tooling hygiene (hang prevention)

- `playwright cli` commands are LONG-LIVED: `open`, `attach`, `goto` keep a
  daemon/browser process alive and do not exit on their own. NEVER run them
  from the agent shell tool — neither piping, nor a hard timeout, nor a
  detached launch (`Start-Process -RedirectStandardOutput`) reliably prevents
  the session from freezing. This was reproduced THREE times in one day.
  (The tool "returns" the snapshot text, then the session hangs ~1 hour
  because the browser daemon keeps the pipe handle / the tool loop blocks.)
- Verify UI work WITHOUT a live browser: API probes (`Invoke-WebRequest`),
  the package's typecheck + unit tests + production build, and non-interactive
  HTTP state inspection. If a real browser check is needed, it must run
  OUTSIDE the agent session (separate terminal / CI); the agent only reads the
  artifacts (screenshots, snapshot files).
- If a browser call ever printed output but the session is stuck, the daemon
  is alive: `playwright-cli kill-all` in a separate bounded call, then resume
  with non-browser verification.
- To inspect the real Electron renderer, enable `SAIWORK_DEBUG_PORT` (user
  env) BEFORE launching, then poll `http://127.0.0.1:<port>/json`. If the port
  is unresponsive, the renderer main thread is blocked — stop poking CDP and
  diagnose the renderer instead.
- Prefer code reading + tests over live-browser interaction for verification;
  the dev loop (vite + esbuild HMR) is fragile on Windows and can SIGABRT
  mid-session, which looks like a UI hang.

## External integrations knowledge

- The full reverse-engineered contract for Antigravity (OAuth session in
  `state.vscdb`, daily-cloudcode-pa endpoint, model-id quirks, tool-schema
  keep-list, thoughtSignature) and FreeBuff (engine API, session-slot model,
  close-to-release) lives in `docs/features/antigravity-and-freebuff.md`.
  When either vendor ships an update, re-verify against that checklist
  (no-quota probes with a fake model id; `closeThread` slot release; catalog
  model availability) instead of re-deriving it.

## FreeBuff session-slot constraint (MANDATORY)

- FreeBuff allows **one hosted-model session/tab per network at a time**
  (limited tier: "Freebuff is limited to one tab at a time on your network").
  A thread holds a slot from admission until the thread is closed or the
  session expires; `stop` does NOT release it.
- The only HTTP way to release a slot is `closeThread` (POST
  `/api/thread/:id/close`); sending a message later reopens a closed thread
  without losing history.
- SAIWORK's FreebuffController tracks slot holders from engine `state` events
  (`snapshot.sessions.activeSessionsByThread`) and exposes `freeSlotFor()`,
  which closes every OTHER holder before a turn is dispatched. Both the
  gateway (`/fb/v1`) and the UI tab message route call it; the gateway closes
  its own thread after each turn so an idle conversation never blocks another.
- Keep this contract when touching FreeBuff: never rely on `stop` to free a
  slot, and always call `freeSlotFor` before dispatching a hosted-model turn.

## Generated OpenCode config validation (MANDATORY)
- Any provider config written into `OPENCODE_CONFIG_CONTENT` must satisfy
  OpenCode's config schema or workspace launch fails hard (reproduced
  2026-08-12: model `limit` with only `context` and no `output` produced
  "provider.google_antigravity.models.*.limit.output: Missing key" and the
  Electron app could not start the workspace). Rules:
  - `limit` must carry BOTH `context` and `output` numbers when present.
  - After changing `buildGoogleProviderConfig` / `buildFreebuffProviderConfig`
    or the model catalogs, assert the generated config structurally: every
    provider model with a `limit` has both keys, baseURL/apiKey are present,
    and the opencode-plugin test suite passes.
  - Prefer validating generated config against the real OpenCode binary when
    possible (it validates at `opencode serve` launch); otherwise rely on the
    structural regression test in `opencode-plugin.test.ts`.

## Plugin hygiene (MANDATORY)

- NEVER add named exports to `packages/opencode-plugin/plugin/saiwork.ts`
  beyond the plugin factory and the existing sanitize helper. OpenCode's plugin
  loader calls named function exports during plugin load with its own
  arguments; an extra export such as `redactSecrets` got invoked with a
  non-string and threw `output.replace is not a function`, which failed plugin
  loading and cascaded into a 500 on the workspace `/provider` endpoint
  (reproduced 2026-08-11). Keep helper logic in separate modules under
  `plugin/lib/` and import it; export nothing extra from the plugin entry.
- NEVER `Stop-Process` on `opencode.exe` / `node.exe` by name to "clean up" a
  workspace — it kills the user's running OpenCode/agent mid-session. The
  SAIWORK server and its workspaces are managed through the app; the agent only
  starts/stops the SAIWORK server via its own lifecycle. If a workspace process
  must be stopped, do it through the SAIWORK API, never by process name.

## Styling Guidelines
- Reuse the existing token & utility layers before introducing new CSS variables or custom properties. Extend `src/styles/tokens.css` / `src/styles/utilities.css` if a shared pattern is needed.
- Keep aggregate entry files (e.g., `src/styles/controls.css`, `messaging.css`, `panels.css`) lean—they should only `@import` feature-specific subfiles located inside `src/styles/{components|messaging|panels}`.
- When adding new component styles, place them beside their peers in the scoped subdirectory (e.g., `src/styles/messaging/new-part.css`) and import them from the corresponding aggregator file.
- Prefer smaller, focused style files (≈150 lines or less) over large monoliths. Split by component or feature area if a file grows beyond that size.
- Co-locate reusable UI patterns (buttons, selectors, dropdowns, etc.) under `src/styles/components/` and avoid redefining the same utility classes elsewhere.
- Never use rounded corners in UI styling; keep corners square unless the user explicitly requests otherwise for a specific change.
- Document any new styling conventions or directory additions in this file so future changes remain consistent.

## Coding Principles
- Favor KISS by keeping modules narrowly scoped and limiting public APIs to what callers actually need.
- Uphold DRY: share helpers via dedicated modules before copy/pasting logic across stores, components, or scripts.
- Enforce single responsibility; split large files when concerns diverge (state, actions, API, events, etc.).
- Prefer composable primitives (signals, hooks, utilities) over deep inheritance or implicit global state.
- When adding platform integrations (SSE, IPC, SDK), isolate them in thin adapters that surface typed events/actions.

## Multi-Language Support (i18n)

The UI uses a small custom i18n layer (no ICU/messageformat). When building features, never hardcode user-visible strings.

- **Runtime API:** use `useI18n()` in components (`const { t } = useI18n();`) and `tGlobal(...)` in stores/non-component code.
  - Implementation: `packages/ui/src/lib/i18n/index.tsx`
- **Where messages live:** `packages/ui/src/lib/i18n/messages/<locale>/` as TypeScript objects (`"flat.dot.keys": "string"`).
  - Each locale has an `index.ts` that merges message parts; duplicate keys throw at build time.
  - Merge helper: `packages/ui/src/lib/i18n/messages/merge.ts`
- **Adding a new string:** add it to the appropriate `.../messages/en/*.ts` part file, then add the same key to each other locale’s corresponding file.
  - Missing translations fall back to English (and finally to the key), so gaps can be easy to miss.
- **Interpolation:** placeholders are simple `{name}` replacements (word characters only). Avoid placeholders like `{file-name}`.
- **Pluralization:** handle manually via separate keys like `something.one` / `something.other` and choose in code.
- **Adding a new language:** add a new `messages/<locale>/` folder + `index.ts`, register it in `packages/ui/src/lib/i18n/index.tsx`, and add it to the language picker in `packages/ui/src/components/folder-selection-view.tsx`.
- **Locale persistence:** the selected locale is stored in app preferences (`locale`) and persisted via the server config (default `~/.config/saiwork/config.json`).
- **Avoid English-only paths:** do not import `enMessages` directly in feature code; always go through `t(...)` so locale changes apply.

## File Length Guidelines (Highlight Only)

We track file size as a refactoring signal. When you touch or create files, highlight oversized files so the team can plan refactors when time permits.

- Source files: warn after ~500 lines; target limit ~800 lines
- Test files: highlight after ~1000 lines

Behavior for agents:
- Do not refactor solely to satisfy these thresholds.
- When a change touches a file that exceeds the warning/limit, mention it in your final response and include the file path and approximate line count.
- When creating new files, aim to stay under the thresholds unless there's a clear reason.

## Tooling Preferences
- Use the `edit` tool for modifying existing files; prefer it over other editing methods.
- Use the `write` tool only when creating new files from scratch.

## Commit Message Guidelines
- When creating commits, use detailed commit messages: a concise conventional-style subject followed by body paragraphs that explain the user-visible behavior change, the implementation approach, important edge cases or platform considerations, and the validation or test coverage added.
- Prefer messages that explain why the change exists and how regressions are prevented, not just a list of touched files.
