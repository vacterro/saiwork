# LOG -- SAIWORK

- 08.08.26 [E-001] DEC: fork CodeNomad 0.18.0 as SAIWORK 0.0.1, rebrand in place on branch `saiwork`
- 08.08.26 [E-002] [T-001] RUN: create .saipen memory (STATE/BOARD/LOG) at repo root -> PASS
- 08.08.26 [E-003] [T-002] RUN: mechanical rebrand sweep, 233 files -> PASS; all JSON reparsed clean
- 08.08.26 [E-004] [T-002] RUN: version 0.0.1 across 6 package.json + tauri.conf + Cargo.toml -> PASS
- 08.08.26 [E-005] [T-002] FIX: nested-array flattening in a PowerShell helper corrupted 5 files
  (char-level Replace). Restored from HEAD, re-applied with the Edit tool. Lesson: no nested `@()`
  in a hashtable value, and verify the file after a scripted rewrite.
- 08.08.26 [E-006] [T-003] RUN: vintage-golden.css override layer + MUI overrides -> PASS
- 08.08.26 [E-007] [T-004] RUN: SAIPEN instructions injected via OPENCODE_CONFIG_CONTENT -> PASS
- 08.08.26 [E-008] [T-005] RUN: prompt queue store + panel + Alt+Enter -> PASS (typecheck clean)
- 08.08.26 [E-009] [T-008] RUN: SAIPEN command bar, 15 shortcuts read from CORE.md 1.10 -> PASS
- 08.08.26 [E-010] [T-007] RUN: npm run typecheck (ui, server, electron-app) -> PASS
- 08.08.26 [E-011] [T-007] RUN: server build + launch, opencode 1.17.15 workspace created -> PASS
- 08.08.26 [E-012] [T-007] RUN: browser check -> bg rgb(52,32,18), Verdana_m1, smoothing none,
  0 radius/shadow/transition violations across 130 elements -> PASS
- 08.08.26 [E-013] [T-008] RUN: /api/saipen/status on _SAIPEN -> 2 instruction files + 4 sub states
  (saihunt DONE, saipython PLAN, saitranslate DONE SAIT-009, saiwiki DONE W-030) -> PASS
- 08.08.26 [E-014] [T-009] DEC: remove Discord link, star pill and star-history badge -- the fork
  has none of them; repoint repo URLs to github.com/vacterro/saiwork
- 08.08.26 [E-015] [T-009] RUN: icon master tinted to Vintage Golden, icns/ico/png regenerated
  with --radius 0 -> PASS
- 08.08.26 [E-016] [T-008] FIX: SAIPEN bar rendered only in SessionView, so it was invisible until a
  session existed. Added to the draft prompt view in instance-shell2 as well -> PASS
- 08.08.26 [E-017] [T-003] DEC: palette is saipen UI.md's eighteen, not the older darker set in the
  vintage skill -- UI.md states it superseded those values, and CLAUDE.md points UI work at UI.md
- 08.08.26 [E-018] [T-003] FIX: tailwind text-* utilities and markdown `code` sized off the
  10/11/12/14/16 scale. Pinned in vintage-golden.css so upstream churn cannot reintroduce them
- 08.08.26 [E-019] [T-003] RUN: full UI audit -> 326 elements, 0 radius / 0 shadow / 0 animation /
  0 translucent background, sizes on-scale, Verdana_m1 + Consolas only, 640x480 no h-scroll -> PASS
- 08.08.26 [E-020] [T-015] DEC: right panel starts closed and unpinned, and its contents mount only
  while open -- the git status/diff views were the reported lag on session load
- 08.08.26 [E-021] [T-016] DEC: yolo mode defaults ON, decided at the wiring layer
  (`defaultEnabled`), so the upstream opt-in test suite still describes real behaviour.
  `SAIWORK_YOLO_DEFAULT=false` restores opt-in. Every permission request auto-approves.
- 08.08.26 [E-022] [T-016] FIX: hydration restored only `true`, so an explicit off did not survive a
  restart once the default flipped. Restores both, emits only on departure from the default
- 08.08.26 [E-023] [T-016] RUN: node --test permissions suites -> 55 pass / 0 fail; +4 new store tests
- 08.08.26 [E-024] [T-017] RUN: START.bat / START.sh launcher + electron-builder portable target +
  portable data dir (`saiwork-data` beside the exe, `SAIWORK_DATA_DIR` override) -> typecheck PASS
- 08.08.26 [E-025] [T-018] DEC: DevTools no longer auto-open in dev; menu toggle and
  `SAIWORK_DEVTOOLS=1` still open them. A detached window on every start stole focus
- 08.08.26 [E-026] [T-019] RUN: ship preflight steps 0-4 -> README/CHANGELOG/version agree at 0.0.1,
  .gitignore covers node_modules/dist/release/.saiwork, typecheck ui+electron+server PASS
- 08.08.26 [E-027] [T-019] RUN: node --test full server suite -> 266 tests, 261 pass, 1 fail
  "uses the selected workspace folder for the root worktree directory"
- 08.08.26 [E-028] [T-019] DEC: that failure is pre-existing upstream, not this ship. `runGit` calls
  `spawn("git", ...)` without `shell: true` (git-worktrees.ts:19), and Node refuses to spawn the
  test's `git.cmd` shim on Windows, so listWorktrees takes its fallback branch and returns no
  branch name. My diff on both files is the codenomad->saiwork string rename and nothing else.
- 08.08.26 [E-029] [T-019] RUN: ship step 5 remote classification -> `git ls-remote --heads --tags
  origin` empty, origin exists but never received a commit or tag -> FIRST PUBLISH, gate holds
