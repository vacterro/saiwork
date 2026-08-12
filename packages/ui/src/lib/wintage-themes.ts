export interface WintageTheme {
  slug: string
  label: string
  isDark: boolean
}

export const wintageThemes: WintageTheme[] = [
  { slug: "golden", label: "Dark Golden (Win95)", isDark: true },
  { slug: "claudecode", label: "Claude Code", isDark: true },
  { slug: "antigravity", label: "Antigravity", isDark: true },
  { slug: "klite", label: "K-Lite (MPC-HC)", isDark: true },
  { slug: "freebuff", label: "FreeBuff", isDark: true },
  { slug: "codenomad", label: "CodeNomad", isDark: true },
  { slug: "fpdefault", label: "Default", isDark: true },
  { slug: "goldenvintage", label: "Golden Vintage", isDark: true },
  { slug: "goldendefault", label: "Golden Default", isDark: true },
  { slug: "vintagedark", label: "Vintage Dark", isDark: true },
  { slug: "vintageclassic", label: "Vintage Classic", isDark: false },
  { slug: "oled", label: "Dark 2 (OLED)", isDark: true },
  { slug: "dracula", label: "Dracula", isDark: true },
  { slug: "nord", label: "Nord", isDark: true },
  { slug: "solarized", label: "Solarized Dark", isDark: true },
  { slug: "custom", label: "Custom", isDark: true },
]
