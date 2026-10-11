import { useTranslation } from 'react-i18next'
import { Check, Palette } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { PALETTES, useTheme, type ThemePalette } from '@/components/theme-provider'

/**
 * Palette picker. 18 palettes don't fit nicely in a vertical list, so we
 * render a 6-column grid of color swatches with the palette name shown as
 * a tooltip (the `title` attribute) and a check overlay on the active one.
 *
 * Lives next to `<ModeToggle />` in the header and on the auth screens —
 * palette and mode are independent axes, so two separate controls.
 */
export function ThemePicker() {
  const { t } = useTranslation()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          // Outline + h-9 like its neighbours (LanguageSwitcher, ModeToggle)
          // so the three header controls read as one group.
          variant="outline"
          size="icon"
          className="h-9 w-9"
          aria-label={t('theme.pickerLabel', { defaultValue: 'Theme palette' })}
          title={t('theme.pickerLabel', { defaultValue: 'Theme palette' })}
        >
          <Palette className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60 p-2">
        <DropdownMenuLabel className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium px-1">
          {t('theme.pickerHeading', { defaultValue: 'Palette' })}
        </DropdownMenuLabel>
        <DropdownMenuSeparator className="mb-2" />
        <PaletteGrid />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The 46-swatch palette grid + active-palette label. Shared by the
 * standalone picker above and the account menu's "Palette" submenu.
 */
export function PaletteGrid() {
  const { t } = useTranslation()
  const { palette, setPalette } = useTheme()
  const active = PALETTES.find((p) => p.id === palette)
  return (
    <>
      <div className="grid grid-cols-6 gap-1.5">
        {PALETTES.map((p) => (
          <PaletteSwatch
            key={p.id}
            id={p.id}
            swatch={p.swatch}
            label={t(p.labelKey, { defaultValue: p.fallback })}
            active={p.id === palette}
            onSelect={() => setPalette(p.id)}
          />
        ))}
      </div>
      {/* Active palette label — saves hovering each swatch to find it. */}
      <p className="text-[11px] text-muted-foreground mt-2.5 px-1 text-center">
        {t(active?.labelKey ?? 'theme.paletteDefault', { defaultValue: active?.fallback ?? 'Default' })}
      </p>
    </>
  )
}

function PaletteSwatch({
  id,
  swatch,
  label,
  active,
  onSelect,
}: {
  id: ThemePalette
  swatch: string
  label: string
  active: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      title={label}
      aria-label={label}
      aria-pressed={active}
      data-palette={id}
      className={`relative w-7 h-7 rounded-md border-2 transition-all hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover ${
        active ? 'border-foreground' : 'border-border hover:border-foreground/40'
      }`}
      style={{ backgroundColor: swatch }}
    >
      {active && (
        <Check
          className="absolute inset-0 m-auto w-3.5 h-3.5 text-white drop-shadow-sm"
          aria-hidden
        />
      )}
    </button>
  )
}
