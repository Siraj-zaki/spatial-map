/**
 * Conditional-formatting looks for report table cells. A rule saves its
 * look as a class string on the spec (`WidgetCondition.className`), so
 * the presets here are what the builder offers and `themeClass` is what
 * the viewer applies.
 *
 * Presets use the theme's status/chart tokens so they follow light/dark
 * and every palette. Specs saved before 2026-10 (and `cmd/seed-reports`
 * output from then) carry raw Tailwind palette classes
 * (`text-emerald-600 dark:text-emerald-400`); `themeClass` maps those
 * onto the same tokens, so old reports keep their colours.
 */

export interface ConditionStyle {
  /** Also the i18n key suffix: `reports.wizard.conditions.preset.<id>`. */
  id: string
  fallback: string
  className: string
}

export const CONDITION_STYLES: ConditionStyle[] = [
  { id: 'success', fallback: 'Green', className: 'text-success font-medium' },
  { id: 'warn', fallback: 'Amber', className: 'text-warning font-medium' },
  { id: 'danger', fallback: 'Red', className: 'text-danger font-medium' },
  { id: 'info', fallback: 'Blue', className: 'text-info font-medium' },
  { id: 'purple', fallback: 'Purple', className: 'text-chart-3 font-medium' },
  { id: 'muted', fallback: 'Muted', className: 'text-muted-foreground' },
  { id: 'bold', fallback: 'Bold', className: 'font-bold' },
  { id: 'strike', fallback: 'Strikethrough', className: 'line-through text-muted-foreground' },
]

const HUE_TOKEN: Record<string, string> = {
  emerald: 'success',
  green: 'success',
  teal: 'success',
  lime: 'success',
  amber: 'warning',
  yellow: 'warning',
  orange: 'warning',
  red: 'danger',
  rose: 'danger',
  blue: 'info',
  sky: 'info',
  indigo: 'info',
  cyan: 'info',
  purple: 'chart-3',
  violet: 'chart-3',
  fuchsia: 'chart-5',
  pink: 'chart-5',
}

const PALETTE_CLASS = /^(dark:)?(text|bg|border|ring)-([a-z]+)-(\d{2,3})(\/\d+)?$/

/** A saved condition class with raw palette colours swapped for tokens. */
export function themeClass(cls: string): string {
  const out: string[] = []
  for (const tok of cls.split(/\s+/).filter(Boolean)) {
    const m = PALETTE_CLASS.exec(tok)
    const token = m ? HUE_TOKEN[m[3]] : undefined
    if (!m || !token) {
      out.push(tok)
      continue
    }
    // `dark:` twins collapse into the one token, which already adapts.
    if (m[1]) continue
    out.push(`${m[2]}-${token}${m[5] ?? ''}`)
  }
  return [...new Set(out)].join(' ')
}

export function conditionStyleFor(cls: string): ConditionStyle | undefined {
  const themed = themeClass(cls)
  return CONDITION_STYLES.find((s) => s.className === themed)
}
