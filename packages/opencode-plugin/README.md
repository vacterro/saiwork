# SaiWork OpenCode Plugin

> **Provenance:** Baseline plugin implementation and this documentation are
> adapted from CodeNomad's 0.18.0 development line. SAIWORK-specific changes
> are summarized in the [root README](../../README.md).

## TLDR
Packaged OpenCode plugin injected into every OpenCode instance that SaiWork launches. It provides the SaiWork bridge for local event exchange between the CLI server and OpenCode.

## What it is
An npm-packable plugin package. Production builds ship a local `.tgz` and inject it through `OPENCODE_CONFIG_CONTENT`; dev runs reference the TypeScript plugin entry directly with a `file://` URL.

## How it works
- SaiWork sets `OPENCODE_CONFIG_CONTENT` when spawning each OpenCode instance (`packages/server/src/workspaces/manager.ts`).
- The server packs this package during build (`packages/server/scripts/package-opencode-plugin.mjs`).
- OpenCode loads the plugin from `plugin` entries injected into the config content.
- The `SaiWorkPlugin` reads `SAIWORK_INSTANCE_ID` + `SAIWORK_BASE_URL`, connects to `GET /workspaces/:id/plugin/events`, and posts to `POST /workspaces/:id/plugin/event` (`packages/opencode-plugin/plugin/lib/client.ts`).
- The server exposes the plugin routes and maps events into the UI SSE pipeline (`packages/server/src/server/routes/plugin.ts`, `packages/server/src/plugins/handlers.ts`).

## Expectations
- Local-only bridge (no auth/token yet).
- Plugin must fail startup if it cannot connect after 3 retries.
- Keep plugin entrypoints thin; put shared logic under `plugin/lib/` to avoid autoloaded helpers.
- Keep event shapes small and explicit; use `type` + `properties` only.

## Ideas
- Add feature modules under `plugin/lib/features/` (tool lifecycle, permission prompts, custom commands).
- Expand `/workspaces/:id/plugin/*` with dedicated endpoints as needed.
- Promote stable event shapes and version tags once the protocol settles.

## Pointers
- Plugin entry: `packages/opencode-plugin/plugin/saiwork.ts`
- Plugin client: `packages/opencode-plugin/plugin/lib/client.ts`
- Plugin server routes: `packages/server/src/server/routes/plugin.ts`
- Plugin event handling: `packages/server/src/plugins/handlers.ts`
- Workspace env injection: `packages/server/src/workspaces/manager.ts`
