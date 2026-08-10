import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import solid from "vite-plugin-solid"
import { resolve } from "path"
import { copyMonacoPublicAssets } from "../ui/scripts/monaco-public-assets.js"

// A leaked ELECTRON_RUN_AS_NODE makes electron-vite spawn electron in plain
// Node mode: electron.app is undefined and the main process dies immediately.
// The CLI server child re-enables it itself (process-manager.ts), so clearing
// it here only affects the dev launcher and never the server.
delete process.env.ELECTRON_RUN_AS_NODE

const uiRoot = resolve(__dirname, "../ui")
const uiSrc = resolve(uiRoot, "src")
const uiRendererRoot = resolve(uiRoot, "src/renderer")
const uiRendererEntry = resolve(uiRendererRoot, "index.html")
const uiRendererLoadingEntry = resolve(uiRendererRoot, "loading.html")

function prepareMonacoPublicAssets() {
  return {
    name: "prepare-monaco-public-assets",
    configureServer(server: any) {
      copyMonacoPublicAssets({
        uiRendererRoot: uiRendererRoot,
        warn: (msg: string) => server.config.logger.warn(msg),
        sourceRoots: [
          resolve(__dirname, "../../node_modules/monaco-editor/min/vs"),
          resolve(uiRoot, "node_modules/monaco-editor/min/vs"),
        ],
      })
    },
    buildStart(this: any) {
      copyMonacoPublicAssets({
        uiRendererRoot: uiRendererRoot,
        warn: (msg: string) => this.warn(msg),
        sourceRoots: [
          resolve(__dirname, "../../node_modules/monaco-editor/min/vs"),
          resolve(uiRoot, "node_modules/monaco-editor/min/vs"),
        ],
      })
    },
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "dist/main",
      lib: {
        entry: resolve(__dirname, "electron/main/main.ts"),
        formats: ["cjs"],
        fileName: () => "main.cjs",
      },
      rollupOptions: {
        external: ["electron"],
        output: {
          entryFileNames: "main.cjs",
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "dist/preload",
      lib: {
        entry: resolve(__dirname, "electron/preload/index.cjs"),
        formats: ["cjs"],
        fileName: () => "index.js",
      },
      rollupOptions: {
        external: ["electron"],
        output: {
          entryFileNames: "index.js",
        },
      },
    },
  },
  renderer: {
    root: uiRendererRoot,
    plugins: [solid(), prepareMonacoPublicAssets()],
    css: {
      postcss: resolve(uiRoot, "postcss.config.js"),
    },
    resolve: {
      alias: {
        "@": uiSrc,
      },
    },
    server: {
      port: 3000,
    },
    build: {
      minify: true,
      cssMinify: true,
      sourcemap: false,
      outDir: resolve(__dirname, "dist/renderer"),
      rollupOptions: {
        input: {
          main: uiRendererEntry,
          loading: uiRendererLoadingEntry,
        },
        output: {
          compact: false,
          minifyInternalExports: false,
        },
      },
    },
  },
})
