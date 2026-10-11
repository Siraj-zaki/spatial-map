import { useTranslation } from 'react-i18next'
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useWizard } from '../wizard-state'

export function SortStep() {
  const { t } = useTranslation()
  const { draft, update } = useWizard()

  const addSort = () => {
    if (draft.columns.length === 0) return
    update({
      sort: [...draft.sort, { field: draft.columns[0], dir: 'asc' }],
    })
  }

  const patch = (idx: number, patch: Partial<{ field: string; dir: 'asc' | 'desc' }>) => {
    const next = [...draft.sort]
    next[idx] = { ...next[idx], ...patch }
    update({ sort: next })
  }

  const remove = (idx: number) => {
    update({ sort: draft.sort.filter((_, i) => i !== idx) })
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="space-y-2">
        <Label>{t('reports.wizard.sort.title', { defaultValue: 'Default sort order' })}</Label>
        <p className="text-xs text-muted-foreground">
          {t('reports.wizard.sort.hint', {
            defaultValue: 'Rows are sorted top-down by these keys. Viewers can override by clicking table headers.',
          })}
        </p>
        {draft.columns.length === 0 && (
          <div className="italic text-muted-foreground text-sm py-4 text-center border-2 border-dashed border-border rounded-md">
            {t('reports.wizard.sort.needColumns', {
              defaultValue: 'Pick columns in the previous step to enable sorting.',
            })}
          </div>
        )}
        {draft.sort.length === 0 && draft.columns.length > 0 && (
          <div className="italic text-muted-foreground text-sm py-2">
            {t('reports.wizard.sort.empty', { defaultValue: 'No sort — rows appear in source order.' })}
          </div>
        )}
        <div className="space-y-2">
          {draft.sort.map((s, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <select
                value={s.field}
                onChange={(e) => patch(idx, { field: e.target.value })}
                className="h-8 rounded-md border border-input bg-background px-2 text-xs flex-1 min-w-0"
              >
                {draft.columns.map((c) => (
                  <option key={c} value={c}>
                    {draft.columnConfig[c]?.label || c}
                  </option>
                ))}
              </select>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1 text-xs"
                onClick={() => patch(idx, { dir: s.dir === 'asc' ? 'desc' : 'asc' })}
              >
                {s.dir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />}
                {s.dir === 'asc'
                  ? t('reports.wizard.sort.asc', { defaultValue: 'Ascending' })
                  : t('reports.wizard.sort.desc', { defaultValue: 'Descending' })}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0"
                onClick={() => remove(idx)}
                aria-label={t('reports.wizard.sort.remove', { defaultValue: 'Remove' })}
              >
                <X className="w-3.5 h-3.5" />
              </Button>
            </div>
          ))}
        </div>
        <Button variant="outline" size="sm" onClick={addSort} disabled={draft.columns.length === 0}>
          <Plus className="w-3.5 h-3.5 me-1.5" />
          {t('reports.wizard.sort.add', { defaultValue: 'Add sort key' })}
        </Button>
      </div>

      <div className="space-y-2 border-t border-border pt-4">
        <Label htmlFor="wiz-limit">
          {t('reports.wizard.sort.limit', { defaultValue: 'Row limit' })}
        </Label>
        <p className="text-xs text-muted-foreground">
          {t('reports.wizard.sort.limitHint', {
            defaultValue: 'Maximum rows fetched per run. Server caps at 10,000.',
          })}
        </p>
        <Input
          id="wiz-limit"
          type="number"
          min={1}
          max={10000}
          value={draft.limit}
          onChange={(e) => update({ limit: Math.max(1, Math.min(10000, Number(e.target.value) || 500)) })}
          className="h-8 w-32 text-sm"
        />
      </div>
    </div>
  )
}
