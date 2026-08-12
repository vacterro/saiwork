# Antigravity + FreeBuff external integration knowledge

Reverse-engineered contract for the two Google/CodeBuff integrations. Update
this file whenever a probe or live test changes what we know about these
services. The point of this document is that when either vendor ships a change,
a developer/agent can re-verify in minutes instead of re-deriving everything.

---

## Antigravity (Google AI Pro subscription)

SAIWORK uses the user's Antigravity login to reach **production** Gemini/Claude
models through the subscription, without the Antigravity app running.

### How a session is obtained

1. Signing into Antigravity once writes an OAuth session into
   `%APPDATA%\Antigravity\User\globalStorage\state.vscdb` (SQLite, table
   `ItemTable`, key `jetskiStateSync.agentManagerInitState`). The value is a
   base64 protobuf blob containing a refresh token (`1//...`) and a (stale)
   access token (`ya29...`).
2. The OAuth client SAIWORK refreshes with is discovered at runtime from the
   Antigravity language server binary:
   `%LOCALAPPDATA%\Programs\Antigravity\resources\bin\language_server.exe`
   (client id `.apps.googleusercontent.com`, client secrets `GOCSPX-...`, cached
   per process). Nothing is hardcoded in the repo; override both via
   `ANTIGRAVITY_OAUTH_CLIENT_ID` / `ANTIGRAVITY_OAUTH_CLIENT_SECRET`.
3. SAIWORK mints a fresh access token at `https://oauth2.googleapis.com/token`
   (`grant_type=refresh_token`), caches it ~1h, and refreshes before expiry.
   This works with Antigravity closed. Tokens never cross into child processes.

### Inference endpoint

- Base: `https://daily-cloudcode-pa.googleapis.com/v1internal`
  (NOT `cloudcode-pa.googleapis.com` and NOT `generativelanguage.googleapis.com`
  — the OAuth token is scoped to the daily-cloudcode-pa audience).
- Models/quota: `POST /v1internal:fetchAvailableModels` with
  `{ "project": "rising-fact-p41fc" }`.
- Generate: `POST /v1internal:streamGenerateContent?alt=sse` with body
  `{ "model": "<id>", "request": { "contents": [...], "systemInstruction"?, "tools"?, "generationConfig"? } }`.
   SSE frames: `data: {"response":{"candidates":[...],"usageMetadata":...}}`,
   no `[DONE]` marker (EOF ends the stream). **Frames are CRLF-delimited**
   (`\r\n\r\n`); the parser normalizes line endings before splitting, because a
   `\n\n`-only splitter collapses the stream to its first frame (a text answer
   truncated to its first word). Skip parts without `text`
   (a `thoughtSignature`-only part is not content).
- Headers: `Authorization: Bearer <token>`, `User-Agent: antigravity/1.11.5
  windows/amd64`, `X-Goog-Api-Client: google-cloud-sdk vscode_cloudshelleditor/0.1`.

### Model id quirks

- The catalog id is the EXACT id the backend accepts. `gemini-3.1-pro-high`
  is listed by `fetchAvailableModels` but returns HTTP 400 on generate; the
  working twin for "Gemini 3.1 Pro (High)" is **`gemini-pro-agent`**.
- Probed-working ids (2026-08): `gemini-pro-agent`, `gemini-3.1-pro-low`,
  `gemini-3.6-flash-{low,medium,high}`, `gemini-3.5-flash-{low,extra-low}`,
  `gemini-3-flash{,-agent}`, `gemini-2.5-flash{,-thinking}`,
  `gemini-3.1-flash-lite`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`,
  `gpt-oss-120b-medium`. These are PRODUCTION models, not preview ids.

### Tools

- Function-call parts carry a `thoughtSignature`; resuming a conversation with
  a tool call REQUIRES echoing it back (the part is
  `{"thoughtSignature":"...","functionCall":{...}}`). SAIWORK's
  `ToolCallRegistry` remembers `id -> signature` across stateless replays.
- Every function RESPONSE must reference the call it answers: the
  `functionResponse` part carries `id` equal to the echoed `functionCall.id`
  (the backend validates it as `tool_use_id`; an id-less response is rejected
  with `messages.N.content.0.tool_result.tool_use_id: Field required`).
- Tool `parameters` only accept an OpenAPI 3.0 subset. The backend rejects
  `$schema`, `$defs`, `$ref`, `definitions`, `exclusiveMinimum/Maximum`,
  `multipleOf`, `const`, `examples`, `uniqueItems`, object-form
  `additionalProperties`, `if/then/else`, `contains`, `propertyNames`,
  `patternProperties`, `unevaluated*`, `dependent*`, `deprecated/readOnly/...`.
  Keep-list lives in `sanitizeGeminiSchema` (`packages/server/src/google/shim.ts`).
  Re-derive it with a probe (fake model id -> 404 only after schema parse, so
  no quota burned) whenever the backend's schema behavior seems to change.

### Re-verify after an Antigravity update

1. `readStoredTokens()` still finds the refresh token in `state.vscdb`.
2. OAuth refresh still works (client id hardcoded, client secrets discovered from
   `language_server.exe` at runtime; env overrides win).
3. `listModels()` returns the catalog; check `gemini-3.1-pro-high` vs
   `gemini-pro-agent` behaviour (the high-tier alias may start working, or move).
4. A real generate returns frames (test with `gemini-3.6-flash-medium`).
5. Tool schema probe: the keep-list above still matches backend errors.

### Quota surface

- `GET /api/google/antigravity/quota` returns per-model
  `{ remainingPercent, resetAt }` (from `listModels()` quota, cached 60s in the
  UI). The model picker marks a model exhausted at 0% and shows the local reset
  time; the send guard reminds before burning the last of it; Goal Auto stands
  down until the quota resets.

---

## FreeBuff (CodeBuff desktop agent engine)

SAIWORK embeds the official FreeBuff desktop orchestrator headlessly and exposes
it both as a first-class model provider (OpenAI-compatible gateway) and the
FreeBuff right-panel tab.

### Engine

- Install: `%LOCALAPPDATA%\Programs\@codebufffreebuff-desktop\resources\
  {bun\bun.exe, orchestrator\orchestrator.js}`. Override with `SAIWORK_FREEBUFF_HOME`.
- Account: `~/.config/freebuff-desktop/state.json` (already logged in).
- Spawned on a free loopback port; HTTP + SSE API:
  - `POST /api/threads` (create; needs `harnessId: "codebuff"` for hosted models)
  - `POST /api/thread/:id/message` (dispatch; reopens closed threads)
  - `POST /api/thread/:id/stop`, `/resume`, `/close`
  - `GET /api/thread/:id`, `GET /api/threads` (list via events mirror),
  - `GET /api/events` (SSE: `thread`, `agent`, `state`, `prompt` events)
- Model IDs on the limited tier: `deepseek/deepseek-v4-flash` (V4 Flash 07/31,
  1M context, free, new), `mimo/mimo-v2.5`, `z-ai/glm-5.2`. Verified live on
  0.0.55: `deepseek/deepseek-v4-flash` accepts `reasoningEffort: "high"` and
  streams both `reasoning` and `text` agent events (`admitting ->
  session-admitted -> request-sent` admission stages; a transient
  `capacity-wait` stage can appear). `createThread` returns "invalid model"
  for ids the engine rejects.
- Reasoning: FreeBuff 0.0.55 reasons per-thread. `createThread` accepts a
  `reasoningEffort` string; the orchestrator caps each model's range
  (`EFFORTS_THROUGH_HIGH` = low/medium/high for the free-tier models,
  `EFFORTS_THROUGH_XHIGH` = +xhigh for others; the full accepted set also
  includes `max`/`ultra`). Engine default is `medium`; SAIWORK always requests
  the model's maximum (`freebuffMaxReasoningEffort`, currently `high`) via the
  gateway and the FreeBuff tab, so turns run at full reasoning instead of the
  default. The orchestrator emits reasoning as `reasoning`/`reasoning_delta`
  agent events; the opencode gateway intentionally drops them (text is what
  streams back), the FreeBuff tab renders them.

### Session slot model (critical)

- FreeBuff allows **one hosted-model session/tab per network at a time**
  (limited tier: "Freebuff is limited to one tab at a time on your network").
- A thread holds a slot from admission until the thread is **closed** or the
  session expires. `stop` does NOT release it.
- The only HTTP way to free a slot is `POST /api/thread/:id/close`; sending a
  message later reopens the thread without losing history.
- SAIWORK's `FreebuffController` tracks slot holders from engine `state` events
  (`snapshot.sessions.activeSessionsByThread`) and `freeSlotFor(target)` closes
  every OTHER holder before a turn. The gateway also closes its own thread
  ~750ms after each turn so idle conversations never block the next one.
  `freeSlotFor` NEVER closes a holder whose turn is running: long FreeBuff turns
  (hours) must not be destroyed by another conversation asking for the slot --
  that caller gets the honest "another tab is using the slot" error instead.
- Turns are bounded at 6h by default (`runFreebuffTurn.timeoutMs`); the 10-minute
  default was removed because multi-hour agent turns are normal.
- An idle sweep closes open threads with no engine activity for 6 minutes
  (controller `idleCloseMs`, interval 60s, running threads never touched) so an
  abandoned tab does not hold the slot; the thread reopens on its next message.
- When an admission is rejected because the slot is held elsewhere (a FreeBuff
  Desktop tab the user opened manually, or a SAIWORK thread on another
  conversation), the gateway (`runTurnWithSlotRetry`) re-frees the slot and
  retries for a bounded window (~35s, `SLOT_RETRY_ATTEMPTS`/`SLOT_RETRY_WAIT_MS`)
  instead of failing the first message; it streams a `> waiting for the FreeBuff
  slot…` step so the user sees progress. An admission that never landed consumed
  no quota. If the window expires, the error says so and points at the release
  button.
- `POST /api/freebuff/release-slot` closes every idle holder SAIWORK can reach
  and confirms against the codebuff.com session counter
  (`desktopSessionCounts`); the FreeBuff status panel shows slot state and the
  release button. The counter (`premium`+`unlimited`) reports an external
  session that SAIWORK's own engine mirror cannot see, which is why
  `freeSlotFor` alone could not recover the manual-Desktop case.
- Quota counts are fractional floats; format them with `formatQuotaCount`
  (integer when whole, else 2 decimals) — never print the raw FP value.

### Re-verify after a FreeBuff update

Run `node --import tsx packages/server/scripts/verify-freebuff.ts`
(FREEBUFF_RUN_TURN=1 for one real turn). It checks install location (tolerant
of a renamed app directory), engine spawn, auth, which catalog models the
engine currently accepts, and that `closeThread` releases the slot. Then, by
hand:

1. Engine still spawns and `/api/auth/status` answers.
2. `createThread` accepts the current model ids (drop stale ids from the catalog).
3. `closeThread` still releases the slot (admission for another thread succeeds
   right after); if the release becomes automatic, `freeSlotFor` can be simplified.
4. Session-slot error message unchanged (`one tab at a time`) — if it changes,
   update `isFreebuffSessionLimitError` in `packages/server/src/freebuff/gateway.ts`.

---

## Process hygiene

- SAIWORK records every spawned opencode pid (+ start-time identity) in
  `~/.config/saiwork/workspace-pids.json` and forgets it on clean stop. On
  server start, remaining entries are terminated (identity-guarded, never a
  recycled pid). See `packages/server/src/workspaces/orphan-cleanup.ts`.
