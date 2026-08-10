# Building SaiWork Binaries

This guide explains how to build distributable binaries for SaiWork.

> **Provenance:** Baseline packaging and this guide are adapted from CodeNomad's
> 0.18.0 development line. SAIWORK-specific packaging changes are summarized in
> the [root README](README.md).

> **Packaging status:** Target configuration exists, but the current `^38.0.0`
> Electron version range is rejected by `electron-builder` version resolution.
> No binary was produced during this pass; an exact dependency pin is required
> before these packaging commands can complete.

## Prerequisites

- **Node.js 20.19+ (20.x) or 22.12+ and npm**
- **Electron Builder** - Installed via devDependencies

## Quick Start

All commands now run inside the workspace packages. From the repo root you can target the Electron app package directly:

```bash
npm run build --workspace @saiwork/electron-app
```

### Default macOS build

```bash
npm run build:binaries --workspace @saiwork/electron-app
```

This builds separate macOS artifacts for Intel and Apple Silicon by default.

## Platform-Specific Builds

### macOS

```bash
# Intel and Apple Silicon
npm run build:mac --workspace @saiwork/electron-app

# Intel only (x64)
npm run build:mac-x64 --workspace @saiwork/electron-app

# Apple Silicon only (ARM64)
npm run build:mac-arm64 --workspace @saiwork/electron-app
```

**Output format:** `.zip`

### Windows

```bash
# x64 (64-bit Intel/AMD)
npm run build:win --workspace @saiwork/electron-app

# ARM64 (Windows on ARM)
npm run build:win-arm64 --workspace @saiwork/electron-app
```

**Output formats:** portable `.exe`, `.zip`

### Linux

```bash
# Portable Electron archive (x64)
npm run build:linux --workspace @saiwork/electron-app

# Tauri Debian package (x64)
npm run sync:version --workspace @saiwork/tauri-app
npm run build --workspace @saiwork/tauri-app -- --bundles deb
```

**Release formats:** Electron `.tar.gz` portable archive and Tauri `.deb` installer.

### Build All Platforms

```bash
npm run build:all --workspace @saiwork/electron-app
```

⚠️ **Note:** Cross-platform builds may have limitations. Build on the target platform for best results.

## Build Process

The build script performs these steps:

1. **Build @saiwork/saiwork** → Produces the CLI `dist/` bundle (also rebuilds the UI assets it serves)
2. **Compile TypeScript + bundle with Vite** → Electron main, preload, and renderer output in `dist/`
3. **Package with electron-builder** → Platform-specific binaries

## Output

Build artifacts are generated in package-specific output directories:

```
packages/electron-app/release/
└── SaiWork-Electron-linux-x64-{version}.tar.gz

packages/tauri-app/target/release/bundle/deb/
└── SaiWork_{version}_amd64.deb
```

## File Naming Convention

```
SaiWork-Electron-macos-{arch}-{version}.zip
SAIWORK-{arch}-{version}.zip
SAIWORK-portable-{arch}-{version}.exe
SaiWork-Electron-linux-{arch}-{version}.tar.gz
SaiWork-Tauri-{os}-{arch}-{version}.{ext}
```

- **version**: From package.json (e.g., `0.0.2`)
- **os**: `macos`, `windows`, `linux`
- **arch**: `x64`, `arm64`, `universal`
- **ext**: Tauri release extension, such as `zip` or `deb`

The Tauri build directory uses Tauri's native Debian filename. CI renames the package to the convention above when preparing release assets.

## Platform Requirements

### macOS

- **Build on:** A macOS/Xcode version supported by Electron 38
- **Run on:** macOS 12+
- **Code signing:** Optional (recommended for distribution)

### Windows

- **Build on:** Windows 10+, macOS, or Linux
- **Run on:** Windows 10+
- **Code signing:** Optional (recommended for distribution)

### Linux

- **Build on:** Linux x64
- **Electron portable:** extract the tar.gz and run the `SaiWork` executable
- **Tauri deb:** built and installation-tested on Ubuntu 24.04; older distributions are not yet guaranteed

## Troubleshooting

### Build fails on macOS

```bash
# Install Xcode Command Line Tools
xcode-select --install
```

### Build fails on Linux

Install the Electron and Tauri build dependencies documented by their upstream projects. Release builds currently target Linux x64 and produce an Electron portable archive plus a Tauri Debian package.

### "electron-builder not found"

```bash
# Install dependencies
npm install
```

### Build is slow

- Use platform-specific builds instead of `build:all`
- Close other applications to free up resources
- Use SSD for faster I/O

## Development vs Production

**Development:**

```bash
npm run dev           # Hot reload, no packaging
```

**Production:**

```bash
npm run build:binaries --workspace @saiwork/electron-app # Full build + packaging
```

## CI/CD Integration

Example GitHub Actions workflow:

```yaml
name: Build Binaries

on:
  push:
    tags:
      - "v*"

jobs:
  build-mac:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v4
        with:
          node-version: 20.19
          cache: npm
      - run: npm ci
      - run: npm run build:mac --workspace @saiwork/electron-app

  build-win:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v4
        with:
          node-version: 20.19
          cache: npm
      - run: npm ci
      - run: npm run build:win --workspace @saiwork/electron-app

  build-linux:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v4
        with:
          node-version: 20.19
          cache: npm
      - run: npm ci
      - run: npm run build:linux --workspace @saiwork/electron-app
```

## Advanced Configuration

Edit `package.json` → `build` section to customize:

- App icon
- Code signing
- Installer options
- File associations
- Auto-update settings

See [electron-builder docs](https://www.electron.build/) for details.

## Brand Assets

- `images/SaiWork-Icon.png` — primary asset for in-app logo placements and the 1024×1024 master icon used to generate packaged app icons

To update the binaries:

1. Run `node packages/electron-app/scripts/generate-icons.js images/SaiWork-Icon.png packages/electron-app/electron/resources --radius 0` to emit fresh square `icon.icns`, `icon.ico`, and `icon.png` files.
2. Pass a different `--radius` only if the product's square-corner rule changes.
3. If you prefer manual control, export `images/SaiWork-Icon.png` with your tool of choice and place the generated files in `electron/resources/`.

## Clean Build

Remove previous builds:

```bash
rm -rf packages/electron-app/release/ packages/electron-app/dist/
npm run build:binaries --workspace @saiwork/electron-app
```

## FAQ

**Q: Can I build for Windows on macOS?**  
A: Yes, but native binaries (e.g., DMG) require the target OS.

**Q: How large are the binaries?**  
A: Size depends on platform, architecture, and bundled runtime; inspect the generated artifact.

**Q: Do I need code signing?**  
A: Not required, but recommended for public distribution to avoid security warnings.

**Q: How do I update the version?**  
A: Run `npm run bumpVersion -- <version>`, then rebuild.

## Support

For issues or questions:

- Check [electron-builder documentation](https://www.electron.build/)
- Open an issue in the repository
- Review existing build logs in `release/`
