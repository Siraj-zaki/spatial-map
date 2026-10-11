import { createContext, useContext, useEffect, useState } from 'react'

/**
 * Two orthogonal axes:
 *   - `mode`    — light vs dark surface (or `system` → follow OS).
 *   - `palette` — accent color identity (the primary/ring CSS vars).
 *
 * The provider applies BOTH classes to `<html>`:
 *   <html class="dark theme-blue">      → dark mode, blue accent
 *   <html class="theme-rose">           → light mode, rose accent
 *   <html>                              → light mode, default (Zinc) accent
 *
 * Palette overrides only `--primary`, `--primary-foreground`, `--ring` in
 * `src/index.css`. The neutral surface tokens (background/card/border/muted
 * /etc.) come from the mode block, so light/dark stay readable across every
 * palette without per-palette duplicate CSS.
 */

export type ThemeMode = 'light' | 'dark' | 'system'

export type ThemePalette =
  | 'default' // Zinc — ships with the project, no extra class
  | 'red'
  | 'crimson'
  | 'maroon'
  | 'scarlet'
  | 'orange'
  | 'tangerine'
  | 'coral'
  | 'salmon'
  | 'peach'
  | 'amber'
  | 'gold'
  | 'mustard'
  | 'yellow'
  | 'lime'
  | 'olive'
  | 'sage'
  | 'green'
  | 'forest'
  | 'emerald'
  | 'mint'
  | 'jade'
  | 'teal'
  | 'cyan'
  | 'ocean'
  | 'sky'
  | 'blue'
  | 'navy'
  | 'royal'
  | 'indigo'
  | 'periwinkle'
  | 'violet'
  | 'lavender'
  | 'purple'
  | 'plum'
  | 'fuchsia'
  | 'magenta'
  | 'mauve'
  | 'pink'
  | 'rose'
  | 'slate'
  | 'stone'
  | 'bronze'
  | 'copper'
  | 'mocha'
  | 'midnight'

/**
 * All palettes with the swatch the picker UI shows. Order matches the
 * spectrum (red → orange → yellow → … → pink) so the grid reads as a
 * color wheel and users can scan visually. `default` (Zinc neutral) leads
 * because it's the project's no-tint baseline.
 *
 * Swatch hex values match each palette's light-mode `--primary` so the
 * picker swatch previews the actual accent the user will get in light
 * mode. In dark mode the swatch is decorative only — the rendered
 * primary will be a brighter variant.
 */
export const PALETTES: ReadonlyArray<{
  id: ThemePalette
  labelKey: string
  fallback: string
  swatch: string
}> = [
  { id: 'default',    labelKey: 'theme.paletteDefault',    fallback: 'Default',    swatch: '#18181b' },
  // Reds
  { id: 'red',        labelKey: 'theme.paletteRed',        fallback: 'Red',        swatch: '#dc2626' },
  { id: 'crimson',    labelKey: 'theme.paletteCrimson',    fallback: 'Crimson',    swatch: '#b8104a' },
  { id: 'maroon',     labelKey: 'theme.paletteMaroon',     fallback: 'Maroon',     swatch: '#691818' },
  { id: 'scarlet',    labelKey: 'theme.paletteScarlet',    fallback: 'Scarlet',    swatch: '#ef3a1d' },
  // Oranges
  { id: 'orange',     labelKey: 'theme.paletteOrange',     fallback: 'Orange',     swatch: '#ea580c' },
  { id: 'tangerine',  labelKey: 'theme.paletteTangerine',  fallback: 'Tangerine',  swatch: '#f24a1c' },
  { id: 'coral',      labelKey: 'theme.paletteCoral',      fallback: 'Coral',      swatch: '#ed5731' },
  { id: 'salmon',     labelKey: 'theme.paletteSalmon',     fallback: 'Salmon',     swatch: '#e4665b' },
  { id: 'peach',      labelKey: 'theme.palettePeach',      fallback: 'Peach',      swatch: '#fcae72' },
  // Yellows / Golds
  { id: 'amber',      labelKey: 'theme.paletteAmber',      fallback: 'Amber',      swatch: '#d97706' },
  { id: 'gold',       labelKey: 'theme.paletteGold',       fallback: 'Gold',       swatch: '#d99511' },
  { id: 'mustard',    labelKey: 'theme.paletteMustard',    fallback: 'Mustard',    swatch: '#aa8910' },
  { id: 'yellow',     labelKey: 'theme.paletteYellow',     fallback: 'Yellow',     swatch: '#eab308' },
  // Greens
  { id: 'lime',       labelKey: 'theme.paletteLime',       fallback: 'Lime',       swatch: '#65a30d' },
  { id: 'olive',      labelKey: 'theme.paletteOlive',      fallback: 'Olive',      swatch: '#6d7e36' },
  { id: 'sage',       labelKey: 'theme.paletteSage',       fallback: 'Sage',       swatch: '#4f7050' },
  { id: 'green',      labelKey: 'theme.paletteGreen',      fallback: 'Green',      swatch: '#16a34a' },
  { id: 'forest',     labelKey: 'theme.paletteForest',     fallback: 'Forest',     swatch: '#16591e' },
  { id: 'emerald',    labelKey: 'theme.paletteEmerald',    fallback: 'Emerald',    swatch: '#059669' },
  { id: 'mint',       labelKey: 'theme.paletteMint',       fallback: 'Mint',       swatch: '#1cb898' },
  { id: 'jade',       labelKey: 'theme.paletteJade',       fallback: 'Jade',       swatch: '#14a16b' },
  { id: 'teal',       labelKey: 'theme.paletteTeal',       fallback: 'Teal',       swatch: '#0d9488' },
  // Blues
  { id: 'cyan',       labelKey: 'theme.paletteCyan',       fallback: 'Cyan',       swatch: '#0891b2' },
  { id: 'ocean',      labelKey: 'theme.paletteOcean',      fallback: 'Ocean',      swatch: '#0e7eb0' },
  { id: 'sky',        labelKey: 'theme.paletteSky',        fallback: 'Sky',        swatch: '#0284c7' },
  { id: 'blue',       labelKey: 'theme.paletteBlue',       fallback: 'Blue',       swatch: '#2563eb' },
  { id: 'navy',       labelKey: 'theme.paletteNavy',       fallback: 'Navy',       swatch: '#1e3a8a' },
  { id: 'royal',      labelKey: 'theme.paletteRoyal',      fallback: 'Royal',      swatch: '#2e3edf' },
  { id: 'indigo',     labelKey: 'theme.paletteIndigo',     fallback: 'Indigo',     swatch: '#4f46e5' },
  { id: 'periwinkle', labelKey: 'theme.palettePeriwinkle', fallback: 'Periwinkle', swatch: '#7c79ed' },
  // Purples / Pinks
  { id: 'violet',     labelKey: 'theme.paletteViolet',     fallback: 'Violet',     swatch: '#7c3aed' },
  { id: 'lavender',   labelKey: 'theme.paletteLavender',   fallback: 'Lavender',   swatch: '#855fdf' },
  { id: 'purple',     labelKey: 'theme.palettePurple',     fallback: 'Purple',     swatch: '#9333ea' },
  { id: 'plum',       labelKey: 'theme.palettePlum',       fallback: 'Plum',       swatch: '#7c2d8c' },
  { id: 'fuchsia',    labelKey: 'theme.paletteFuchsia',    fallback: 'Fuchsia',    swatch: '#c026d3' },
  { id: 'magenta',    labelKey: 'theme.paletteMagenta',    fallback: 'Magenta',    swatch: '#ed1e9c' },
  { id: 'mauve',      labelKey: 'theme.paletteMauve',      fallback: 'Mauve',      swatch: '#9f5e93' },
  { id: 'pink',       labelKey: 'theme.palettePink',       fallback: 'Pink',       swatch: '#db2777' },
  { id: 'rose',       labelKey: 'theme.paletteRose',       fallback: 'Rose',       swatch: '#e11d48' },
  // Neutrals & earth tones
  { id: 'slate',      labelKey: 'theme.paletteSlate',      fallback: 'Slate',      swatch: '#334155' },
  { id: 'stone',      labelKey: 'theme.paletteStone',      fallback: 'Stone',      swatch: '#57534e' },
  { id: 'bronze',     labelKey: 'theme.paletteBronze',     fallback: 'Bronze',     swatch: '#856230' },
  { id: 'copper',     labelKey: 'theme.paletteCopper',     fallback: 'Copper',     swatch: '#a85b25' },
  { id: 'mocha',      labelKey: 'theme.paletteMocha',      fallback: 'Mocha',      swatch: '#67503e' },
  { id: 'midnight',   labelKey: 'theme.paletteMidnight',   fallback: 'Midnight',   swatch: '#1e2967' },
]

const PALETTE_CLASS_PREFIX = 'theme-'
const ALL_PALETTE_CLASSES = PALETTES
  .filter((p) => p.id !== 'default')
  .map((p) => `${PALETTE_CLASS_PREFIX}${p.id}`)

interface ThemeProviderProps {
  children: React.ReactNode
  defaultTheme?: ThemeMode
  defaultPalette?: ThemePalette
  /** Key prefix; we store `${storageKey}` (mode) and `${storageKey}:palette`. */
  storageKey?: string
}

interface ThemeProviderState {
  theme: ThemeMode
  setTheme: (mode: ThemeMode) => void
  palette: ThemePalette
  setPalette: (palette: ThemePalette) => void
}

const initialState: ThemeProviderState = {
  theme: 'system',
  setTheme: () => null,
  palette: 'default',
  setPalette: () => null,
}

const ThemeProviderContext = createContext<ThemeProviderState>(initialState)

function readStored<T extends string>(key: string, allowed: ReadonlyArray<T>, fallback: T): T {
  const v = localStorage.getItem(key)
  return v && (allowed as ReadonlyArray<string>).includes(v) ? (v as T) : fallback
}

export function ThemeProvider({
  children,
  defaultTheme = 'system',
  defaultPalette = 'default',
  storageKey = 'vite-ui-theme',
  ...props
}: ThemeProviderProps) {
  const [theme, setTheme] = useState<ThemeMode>(() =>
    readStored<ThemeMode>(storageKey, ['light', 'dark', 'system'], defaultTheme),
  )
  const [palette, setPalette] = useState<ThemePalette>(() =>
    readStored<ThemePalette>(
      `${storageKey}:palette`,
      PALETTES.map((p) => p.id),
      defaultPalette,
    ),
  )

  // Mode → `light` / `dark` class on <html>. `system` resolves to whichever
  // the OS prefers at this moment; we don't subscribe to changes (a refresh
  // re-resolves) to match the original behavior + keep the effect simple.
  useEffect(() => {
    const root = window.document.documentElement
    root.classList.remove('light', 'dark')
    if (theme === 'system') {
      const sys = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      root.classList.add(sys)
      return
    }
    root.classList.add(theme)
  }, [theme])

  // Palette → `theme-<id>` class on <html>. `default` removes all palette
  // classes — the `:root` + `.dark` blocks then supply the Zinc defaults.
  useEffect(() => {
    const root = window.document.documentElement
    for (const cls of ALL_PALETTE_CLASSES) root.classList.remove(cls)
    if (palette !== 'default') {
      root.classList.add(`${PALETTE_CLASS_PREFIX}${palette}`)
    }
  }, [palette])

  const value: ThemeProviderState = {
    theme,
    setTheme: (next) => {
      localStorage.setItem(storageKey, next)
      setTheme(next)
    },
    palette,
    setPalette: (next) => {
      localStorage.setItem(`${storageKey}:palette`, next)
      setPalette(next)
    },
  }

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  )
}

export const useTheme = () => {
  const context = useContext(ThemeProviderContext)
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider')
  }
  return context
}
