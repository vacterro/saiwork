import { createContext, createEffect, createMemo, createSignal, onMount, useContext, type JSX } from "solid-js"
import { createTheme, ThemeProvider as MuiThemeProvider } from "@suid/material/styles"
import CssBaseline from "@suid/material/CssBaseline"
import { useConfig } from "../stores/preferences"
import { wintageThemes } from "./wintage-themes"

export type ThemeMode = string

interface ThemeContextValue {
  isDark: () => boolean
  themeMode: () => ThemeMode
  setThemeMode: (mode: ThemeMode) => void
  cycleThemeMode: () => void
}

const ThemeContext = createContext<ThemeContextValue>()

function applyThemeMode(mode: ThemeMode) {
  if (typeof document === "undefined") return
  if (mode === "system") {
    document.documentElement.removeAttribute("data-theme")
    return
  }
  document.documentElement.setAttribute("data-theme", mode)
}

interface ResolvedPaletteColors {
  backgroundDefault: string
  backgroundPaper: string
  primary: string
  primaryContrast: string
  textPrimary: string
  textSecondary: string
  divider: string
}

// Both fallback sets are Vintage Golden. SAIWORK has one palette, so a missing
// CSS variable must not be able to drag half the UI back to a blue-on-white
// theme -- it degrades to the same colours the stylesheet would have supplied.
const vintageGoldenFallbacks: ResolvedPaletteColors = {
  backgroundDefault: "#342012",
  backgroundPaper: "#4a341b",
  primary: "#008080",
  primaryContrast: "#e2ca95",
  textPrimary: "#e2ca95",
  textSecondary: "#c5ab6e",
  divider: "#665033",
}

const lightPaletteFallbacks: ResolvedPaletteColors = vintageGoldenFallbacks

const darkPaletteFallbacks: ResolvedPaletteColors = vintageGoldenFallbacks

const readCssVar = (token: string, fallback: string, rootStyle: CSSStyleDeclaration | null) => {
  if (!rootStyle) return fallback
  const value = rootStyle.getPropertyValue(token)
  if (!value) return fallback
  const trimmed = value.trim()
  return trimmed || fallback
}

const resolvePaletteColors = (dark: boolean): ResolvedPaletteColors => {
  const fallbackSet = dark ? darkPaletteFallbacks : lightPaletteFallbacks
  const rootStyle = typeof window !== "undefined" ? getComputedStyle(document.documentElement) : null

  return {
    backgroundDefault: readCssVar("--surface-base", fallbackSet.backgroundDefault, rootStyle),
    backgroundPaper: readCssVar("--surface-secondary", fallbackSet.backgroundPaper, rootStyle),
    primary: readCssVar("--accent-primary", fallbackSet.primary, rootStyle),
    primaryContrast: readCssVar("--text-inverted", fallbackSet.primaryContrast, rootStyle),
    textPrimary: readCssVar("--text-primary", fallbackSet.textPrimary, rootStyle),
    textSecondary: readCssVar("--text-secondary", fallbackSet.textSecondary, rootStyle),
    divider: readCssVar("--border-base", fallbackSet.divider, rootStyle),
  }
}

export function ThemeProvider(props: { children: JSX.Element }) {
  const mediaQuery = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null
  const { themePreference, setThemePreference } = useConfig()
  const [isDark, setIsDarkSignal] = createSignal(true)
  const [themeRevision, setThemeRevision] = createSignal(0)

  const themeMode = () => themePreference() as ThemeMode

  const resolveDarkTheme = () => {
    const mode = themeMode()
    if (mode === "dark") return true
    if (mode === "light") return false
    return mediaQuery?.matches ?? false
  }

  const applyResolvedTheme = () => {
    const mode = themeMode()
    const dark = resolveDarkTheme()
    if (mode === "system") {
      applyThemeMode("system")
    } else {
      applyThemeMode(mode)
    }
    setIsDarkSignal(dark)
    if (typeof window !== "undefined") {
      requestAnimationFrame(() => setThemeRevision((v) => v + 1))
    } else {
      setThemeRevision((v) => v + 1)
    }
  }

  createEffect(() => {
    applyResolvedTheme()
  })

  onMount(() => {
    if (!mediaQuery) return
    const handleSystemThemeChange = () => {
      applyResolvedTheme()
    }

    mediaQuery.addEventListener("change", handleSystemThemeChange)

    return () => {
      mediaQuery.removeEventListener("change", handleSystemThemeChange)
    }
  })

  const setThemeMode = (mode: ThemeMode) => {
    setThemePreference(mode)
  }

  const cycleThemeMode = () => {
    const current = themeMode()
    if (current === "system") {
      setThemeMode(wintageThemes[0]?.slug ?? "goldendefault")
      return
    }
    const currentIndex = wintageThemes.findIndex(t => t.slug === current)
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % wintageThemes.length
    setThemeMode(wintageThemes[nextIndex]?.slug ?? "goldendefault")
  }

  const muiTheme = createMemo(() => {
    themeRevision()
    const paletteColors = resolvePaletteColors(isDark())
    return createTheme({
      palette: {
        mode: isDark() ? "dark" : "light",
        primary: {
          main: paletteColors.primary,
          contrastText: paletteColors.primaryContrast,
        },
        secondary: {
          main: paletteColors.primary,
        },
        background: {
          default: paletteColors.backgroundDefault,
          paper: paletteColors.backgroundPaper,
        },
        text: {
          primary: paletteColors.textPrimary,
          secondary: paletteColors.textSecondary,
        },
        divider: paletteColors.divider,
      },
      typography: {
        fontFamily: "var(--font-family-sans)",
      },
      shape: {
        // Vintage Golden iron law 2: zero rounded corners.
        borderRadius: 0,
      },
      components: {
        MuiIconButton: {
          styleOverrides: {
            root: {
              color: "inherit",
              "&.Mui-disabled": {
                // A disabled control keeps its border and its place; only the
                // label colour drops. Opacity would fade it out of screenshots.
                color: "var(--text-muted)",
                opacity: 1,
              },
            },
          },
        },
        MuiDrawer: {
          styleOverrides: {
            paper: {
              backgroundColor: "var(--surface-secondary)",
              color: "var(--text-primary)",
            },
          },
        },
        MuiAppBar: {
          styleOverrides: {
            root: {
              backgroundColor: "var(--surface-secondary)",
              color: "var(--text-primary)",
              boxShadow: "none",
              borderBottom: "1px solid var(--border-base)",
              zIndex: 10,
            },
          },
        },
        MuiToolbar: {
          styleOverrides: {
            root: {
              // Compact by default: 56px of chrome is a whole row of tabs.
              minHeight: "28px",
            },
          },
        },
      } as any,
    })
  })

  return (
    <ThemeContext.Provider value={{ isDark, themeMode, setThemeMode, cycleThemeMode }}>
      <MuiThemeProvider theme={muiTheme()}>
        <CssBaseline />
        {props.children}
      </MuiThemeProvider>
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider")
  }
  return context
}
