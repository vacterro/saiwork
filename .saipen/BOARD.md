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

## DONE

| id | title |
|----|-------|
| T-001 | Branch + upstream remote + .saipen memory |
| T-002 | Rebrand CodeNomad -> SAIWORK 0.0.1 (233 files, versions, appId, data dir) |
| T-003 | Vintage Golden UI theme |
| T-004 | SAIPEN core protocol injection + `/api/saipen/status` |
| T-005 | FreeBuff-style prompt queue |
| T-006 | Hotkeys (Ctrl+Shift+K / Ctrl+Shift+Q / F1) + shortcuts overlay |
| T-007 | Build + smoke test (server, opencode launch, browser checks) |
| T-008 | SAIPEN command bar + sub-agent freshness table |
| T-009 | Icon and brand assets, dead-link removal, repo repoint |
| T-015 | Right panel closed by default and mounted only while open (lag fix) |
| T-016 | Yolo mode ON by default, per-session off still sticks |
| T-017 | START.bat / START.sh launcher + portable build and portable data dir |

## TODO

- T-010 Settings screen section for SAIPEN (enable toggle, home path, file list).
  Server side reads `serverConfig.saipen` already; no UI to edit it yet.
- T-011 Queue: multi-instance fan-out (deferred from D-04's scope choice).
- T-012 Theme-mode toggle still visible in settings but does nothing now that there
  is one palette. Either remove the control or give it a real second palette.
- T-013 Translate the new UI strings (`promptQueue.*`, `saipen.*`, `shortcuts.*`)
  into the other locale trees. English currently backstops them via fallback.
- T-014 Icons for the Tauri linux bundle still reference the old png names under
  `src-tauri/icons/linux/`; regenerate from the new master.
