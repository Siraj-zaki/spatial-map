/**
 * The ⋯ menu on a report widget: one-click CSV / Excel / JSON / PNG /
 * copy for that widget (with the remembered options), or "More options…"
 * to open the export dialog preset to it. The viewer provides the actions
 * through `ReportExportContext`.
 */

import { createContext, useContext } from 'react'
import { useTranslation } from 'react-i18next'
import { Braces, ClipboardCopy, FileSpreadsheet, FileText, Image as ImageIcon, MoreHorizontal, SlidersHorizontal } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import type { ReportWidgetV2 } from '@/lib/reports/v2-types'
import { CHART_KINDS } from './model'

export type QuickExport = 'csv' | 'xlsx' | 'json' | 'png' | 'copy'

export interface ReportExportActions {
  quick: (widgetId: string, kind: QuickExport) => void
  openDialog: (widgetId?: string) => void
}

export const ReportExportContext = createContext<ReportExportActions | null>(null)

const TABLE_KINDS = new Set(['table', 'dataTable', 'editableTable'])
const KPI_KINDS = new Set(['kpi', 'bigValue'])
const TEXT_KINDS = new Set(['markdown', 'note', 'alert'])

export function exportableKinds(kind: string): QuickExport[] {
  if (TABLE_KINDS.has(kind) || kind === 'heatmap') return ['csv', 'xlsx', 'json', 'copy']
  if (CHART_KINDS.has(kind)) return ['png', 'csv', 'xlsx', 'json', 'copy']
  if (KPI_KINDS.has(kind)) return ['png', 'json', 'copy']
  if (TEXT_KINDS.has(kind)) return ['copy']
  return []
}

export function WidgetExportMenu({ widget, className }: { widget: ReportWidgetV2; className?: string }) {
  const { t } = useTranslation()
  const actions = useContext(ReportExportContext)
  const kinds = exportableKinds(widget.kind)
  if (!actions || kinds.length === 0) return null
  const label = t('reports.export.widgetMenu', { defaultValue: 'Widget menu' })
  const items: Record<QuickExport, { icon: typeof FileText; text: string }> = {
    png: { icon: ImageIcon, text: t('reports.export.png', { defaultValue: 'Export PNG' }) },
    csv: { icon: FileText, text: t('reports.export.csv', { defaultValue: 'Export CSV' }) },
    xlsx: { icon: FileSpreadsheet, text: t('reports.export.xlsx', { defaultValue: 'Export Excel' }) },
    json: { icon: Braces, text: t('reports.export.json', { defaultValue: 'Export JSON' }) },
    copy: {
      icon: ClipboardCopy,
      text: TABLE_KINDS.has(widget.kind) || CHART_KINDS.has(widget.kind) || widget.kind === 'heatmap'
        ? t('reports.export.copyTable', { defaultValue: 'Copy for a spreadsheet' })
        : KPI_KINDS.has(widget.kind)
          ? t('reports.export.copyValue', { defaultValue: 'Copy value' })
          : t('reports.export.copyText', { defaultValue: 'Copy text' }),
    },
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={label}
          title={label}
          className={cn(
            'flex h-7 w-7 items-center justify-center rounded-md border bg-card/90 text-muted-foreground shadow-sm backdrop-blur transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:opacity-100',
            className,
          )}
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {widget.title && <DropdownMenuLabel className="truncate text-xs font-normal text-muted-foreground">{widget.title}</DropdownMenuLabel>}
        {kinds.map((k) => {
          const it = items[k]
          return (
            <DropdownMenuItem key={k} onSelect={() => actions.quick(widget.id, k)}>
              <it.icon className="me-2 h-4 w-4" aria-hidden />
              {it.text}
            </DropdownMenuItem>
          )
        })}
        {kinds.some((k) => k !== 'copy') && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => actions.openDialog(widget.id)}>
              <SlidersHorizontal className="me-2 h-4 w-4" aria-hidden />
              {t('reports.export.moreOptions', { defaultValue: 'More export options…' })}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
