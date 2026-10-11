import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { facilityWritableColumns } from '@/lib/reports/facility-sources'
import { useWizard } from '../wizard-state'
import { useSourceSchema } from '../use-source-schema'

/** Editable-report configuration — which columns are editable + bulk
 *  toggle. Feeds into the editableTable widget's bindings on save. */
export function EditFormStep() {
  const { t } = useTranslation()
  const { draft, update } = useWizard()

  // A built-in facility source can only write back some columns (name,
  // visible, colour, …) — the rest are computed from the shape.
  const { schema } = useSourceSchema(draft.sourceRef?.id)
  const writable = schema?.kind === 'facility' && schema.apiKind ? new Set(facilityWritableColumns(schema.apiKind)) : null
  const editableSet = new Set(draft.editableColumns)
  const toggleEditable = (col: string) => {
    if (editableSet.has(col)) {
      update({ editableColumns: draft.editableColumns.filter((c) => c !== col) })
    } else {
      update({ editableColumns: [...draft.editableColumns, col] })
    }
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="space-y-2">
        <Label>{t('reports.wizard.editForm.editableColumns', { defaultValue: 'Editable columns' })}</Label>
        <p className="text-xs text-muted-foreground">
          {t('reports.wizard.editForm.editableColumnsHint', {
            defaultValue: 'Which columns viewers can change. Columns not listed here are read-only.',
          })}
        </p>
        {draft.columns.length === 0 && (
          <div className="italic text-muted-foreground text-sm py-4 text-center border-2 border-dashed border-border rounded-md">
            {t('reports.wizard.editForm.needColumns', {
              defaultValue: 'Pick columns in the Columns step first — only selected columns can be editable.',
            })}
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
          {draft.columns.map((col) => {
            const active = editableSet.has(col)
            const label = draft.columnConfig[col]?.label ?? col
            const locked = writable !== null && !writable.has(col)
            return (
              <label
                key={col}
                className={cn(
                  'flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors',
                  locked ? 'cursor-not-allowed text-muted-foreground' : 'cursor-pointer',
                  active && !locked ? 'bg-primary/10 text-primary' : !locked && 'hover:bg-accent',
                )}
                title={locked ? t('reports.facility.computedColumn', { defaultValue: 'Worked out from the map — change it in the editor.' }) : undefined}
              >
                <input
                  type="checkbox"
                  checked={active && !locked}
                  disabled={locked}
                  onChange={() => toggleEditable(col)}
                  className="w-3.5 h-3.5"
                />
                <span className="truncate flex-1">{label}</span>
              </label>
            )
          })}
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-border pt-4">
        <div>
          <Label>{t('reports.wizard.editForm.bulk', { defaultValue: 'Bulk edit' })}</Label>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t('reports.wizard.editForm.bulkHint', {
              defaultValue: 'When enabled, viewers can select multiple rows and edit them in one form.',
            })}
          </p>
        </div>
        <Switch
          checked={draft.bulkEditable}
          onCheckedChange={(v) => update({ bulkEditable: Boolean(v) })}
        />
      </div>
    </div>
  )
}
