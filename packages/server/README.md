# SaiWork Server

> **Provenance:** Baseline server implementation and this documentation are
> adapted from CodeNomad's 0.18.0 development line. SAIWORK-specific changes
> are summarized in the [root README](../../README.md).

**SaiWork Server** manages OpenCode processes and serves workspace, API, and
event data to local or remote clients.

## Features & Capabilities

### 🌍 Deployment Freedom

- **Remote Access**: Host SaiWork on a powerful workstation and access it from your lightweight laptop.
- **Code Anywhere**: Tunnel in via VPN or SSH to code securely from coffee shops or while traveling.
- **Multi-Device**: The responsive web client works on tablets and iPads, turning any screen into a dev terminal.
- **Long-running host**: Keep the server process running for later connections.

### ⚡️ Workspace Power

- **Multi-Instance**: Juggle multiple OpenCode sessions side-by-side with per-instance tabs.
- **Session transcripts**: Browse and manage OpenCode session history.
- **Deep Task Awareness**: Monitor background tasks and child sessions without losing your flow.
- **Command Palette**: A single, global palette to jump tabs, launch tools, and fire shortcuts.

## Prerequisites

- **OpenCode**: `opencode` must be installed and configured on your system.
- Node.js 20.19+ (20.x) or 22.12+ and npm (for this monorepo build).
- A workspace folder on disk you want to serve.
- Optional: a Chromium-based browser if you want `--launch` to open the UI automatically.

## Usage

### Build from source

SAIWORK is not published to npm. Build and run the server from this repository:

```bash
npm install
npm run build --workspace @saiwork/saiwork
node packages/server/dist/bin.js --password <your-password> --launch
```

> **Authentication required:** The server requires a password. Pass it via `--password`, the `SAIWORK_SERVER_PASSWORD` environment variable, or create an `auth.json` file (see [Authentication](#authentication) below).

To list all CLI options:

```sh
node packages/server/dist/bin.js --help
```

On startup, SaiWork prints local and remote connection URLs.

### Common Flags

You can configure the server using flags or environment variables:

| Flag | Env Variable | Description |
|------|--------------|-------------|
| `--https <enabled>` | `CLI_HTTPS` | Enable HTTPS listener (default `true`) |
| `--http <enabled>` | `CLI_HTTP` | Enable HTTP listener (default `false`) |
| `--https-port <number>` | `CLI_HTTPS_PORT` | HTTPS port (default `9898`, use `0` for auto) |
| `--http-port <number>` | `CLI_HTTP_PORT` | HTTP port (default `9899`, use `0` for auto) |
| `--tls-key <path>` | `CLI_TLS_KEY` | TLS private key (PEM). Requires `--tls-cert`. |
| `--tls-cert <path>` | `CLI_TLS_CERT` | TLS certificate (PEM). Requires `--tls-key`. |
| `--tls-ca <path>` | `CLI_TLS_CA` | Optional CA chain/bundle (PEM) |
| `--tlsSANs <list>` | `CLI_TLS_SANS` | Additional TLS SANs (comma-separated) |
| `--host <addr>` | `CLI_HOST` | Interface to bind (default 127.0.0.1) |
| `--workspace-root <path>` | `CLI_WORKSPACE_ROOT` | Restricts the root path where new workspaces can be opened. Git worktrees are created in `.saiwork/worktrees` inside the project folder. |
| `--unrestricted-root` | `CLI_UNRESTRICTED_ROOT` | Allow full-filesystem browsing |
| `--config <path>` | `CLI_CONFIG` | Config file location |
| `--launch` | `CLI_LAUNCH` | Open the UI in a Chromium-based browser |
| `--log-level <level>` | `CLI_LOG_LEVEL` | Logging level (trace, debug, info, warn, error) |
| `--log-destination <path>` | `CLI_LOG_DESTINATION` | Log destination file (defaults to stdout) |
| `--username <username>` | `SAIWORK_SERVER_USERNAME` | Username for SaiWork's internal auth (default `saiwork`) |
| `--password <password>` | `SAIWORK_SERVER_PASSWORD` | Password for SaiWork's internal auth |
| `--generate-token` | `SAIWORK_GENERATE_TOKEN` | Emit a one-time local bootstrap token for desktop flows |
| `--dangerously-skip-auth` | `SAIWORK_SKIP_AUTH` | Disable SaiWork's internal auth (use only behind a trusted perimeter) |
| `--ui-dir <path>` | `CLI_UI_DIR` | Directory containing the built UI bundle |
| `--ui-dev-server <url>` | `CLI_UI_DEV_SERVER` | Proxy UI requests to a running dev server (requires `--https=false --http=true`) |
| `--ui-no-update` | `CLI_UI_NO_UPDATE` | Disable remote UI updates |
| `--ui-auto-update <enabled>` | `CLI_UI_AUTO_UPDATE` | Enable remote UI updates (`true`) |
| `--ui-manifest-url <url>` | `CLI_UI_MANIFEST_URL` | Remote UI manifest URL |

### HTTP vs HTTPS

- Default: `--https=true --http=false` (HTTPS only).
- To run plain HTTP only (useful for development):

```sh
node packages/server/dist/bin.js --https=false --http=true
```

- To run both HTTPS (for remote) and HTTP loopback (for desktop):

```sh
node packages/server/dist/bin.js --https=true --http=true
```

### Remote Access Binding Rules

- When remote access is enabled (bind host is non-loopback, e.g. `--host 0.0.0.0`):
  - HTTP listens on `127.0.0.1` only.
  - HTTPS listens on `--host` (LAN/all interfaces).
- When remote access is disabled (bind host is loopback, e.g. `--host 127.0.0.1`):
  - Both HTTP and HTTPS listen on `127.0.0.1`.

### Self-Signed Certificates

If `--https=true` and you do not provide `--tls-key/--tls-cert`, SaiWork generates a local certificate automatically under your config directory:

- `~/.config/saiwork/tls/ca-cert.pem`
- `~/.config/saiwork/tls/server-cert.pem`

Certificates are valid for about 30 days and rotate automatically on startup when needed. You can add extra SANs via:

```sh
node packages/server/dist/bin.js --tlsSANs "localhost,127.0.0.1,my-hostname,192.168.1.10"
```

> **Browser warning:** Self-signed certificates trigger a "Your connection is not private" warning in browsers on first visit. This is expected and safe for local development (127.0.0.1 / localhost):
> 
> 1. **Chrome/Brave/Edge:** Click **Advanced** → **Proceed to 127.0.0.1 (unsafe)**
> 2. **Firefox:** Click **Advanced** → **Accept the Risk and Continue**
> 3. **Alternative:** For local-only development without the warning, run with `--https=false --http=true`
> 
> **Note:** Only accept self-signed certificates for localhost/127.0.0.1 that you control. For remote hosts, use proper TLS certificates.

### Authentication

- Default behavior: SaiWork requires a login (username/password) and stores a session cookie in the browser.
- `--dangerously-skip-auth` / `SAIWORK_SKIP_AUTH=true` disables the login prompt and treats all requests as authenticated.
  Use this only when access is already protected by another layer (SSO proxy, VPN, Coder workspace auth, etc.).
  If you bind to `0.0.0.0` while skipping auth, anyone who can reach the port can access the API.

#### Setting a password

**Practical setup options:**

1. **Runtime password (every start):** Use `--password <your-password>` or set `SAIWORK_SERVER_PASSWORD=<your-password>` environment variable
2. **Persistent password (UI setup):** Launch with `--generate-token`, complete the local bootstrap flow in your browser, then set a password through the UI settings

The `--password` flag and `SAIWORK_SERVER_PASSWORD` env var are **runtime credentials** — they must be provided on every server start and are not persisted to disk.

**Advanced: `auth.json` internals**

The `auth.json` file (`~/.config/saiwork/auth.json`) is automatically created and managed by SaiWork when you set a password through the UI. You generally don't need to edit this file manually. For reference, it uses the following scrypt-based schema:

```json
{
  "version": 1,
  "username": "saiwork",
  "password": {
    "algorithm": "scrypt",
    "saltBase64": "<base64-salt>",
    "hashBase64": "<base64-hash>",
    "keyLength": 64,
    "params": {
      "N": 16384,
      "r": 8,
      "p": 1,
      "maxmem": 33554432
    }
  },
  "userProvided": true,
  "updatedAt": "2026-05-18T12:00:00.000Z"
}
```

Manual creation of this file is not recommended unless you have a helper to generate a valid scrypt `PasswordHashRecord`.

### Progressive Web App (PWA)

When running as a server SaiWork can also be installed as a PWA from any supported browser, giving you a native app experience just like the Electron installation but executing on the remote server instead.

1. Open the SaiWork UI in a Chromium-based browser (Chrome, Edge, Brave, etc.).
2. Click the install icon in the address bar, or use the browser menu → "Install SaiWork".
3. The app will open in a standalone window and appear in your OS app list.

> **TLS requirement**
> Browsers require a secure (`https://`) connection for PWA installation.
> If you host SaiWork on a remote machine, use HTTPS. Self-signed certificates generally won't work unless they are explicitly trusted by the device/browser (e.g., via a custom CA).

### Data Storage

- **Config**: `~/.config/saiwork/config.json`
- **Instance Data**: `~/.config/saiwork/instances` (chat history, etc.)

### Provider Plan Usage

The Status panel automatically displays quota information for the provider used by the active session. SaiWork reads existing OpenCode credentials and never returns provider secrets through its API.

Some optional usage integrations require credentials that OpenCode does not expose. They can be enabled without UI configuration through these environment variables:

- Google token refresh: `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`
- Antigravity token refresh: `ANTIGRAVITY_OAUTH_CLIENT_ID` and `ANTIGRAVITY_OAUTH_CLIENT_SECRET`
- Cursor: `CURSOR_ACCESS_TOKEN` or `CURSOR_TOKEN`, with optional `CURSOR_REFRESH_TOKEN`
- Ollama Cloud: `OLLAMA_CLOUD_COOKIE`
- OpenCode Go: `OPENCODE_GO_WORKSPACE_ID` and `OPENCODE_GO_AUTH_COOKIE`
