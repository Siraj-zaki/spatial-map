/**
 * Sidebar UI for managing style rules.
 *
 * Mounted at the bottom of the workspace side panel (idle mode). Layout:
 *
 *   ┌──────────────────────────────────────────┐
 *   │ Style rules                       [Add ▼]│
 *   ├──────────────────────────────────────────┤
 *   │ ▢ Empty bins        any  prio 10  ⓘ [×] │
 *   │ ▣ Low stock         grid prio 20  ⓘ [×] │
 *   │ ▣ Stale data        any  prio 30  ⓘ [×] │
 *   └──────────────────────────────────────────┘
 *
 * Clicking a row opens an inline editor (conditions + style). The editor
 * lives in a sibling component for symmetry with the other section
 * editors (PolygonEditor, ModelEditor, …).
 */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { Filter, Plus, Trash2, Pencil, Power, PowerOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Section,
  matchesWorkspaceQuery,
  useWorkspaceQuery,
} from '@/components/side-panel'
import { type StyleRuleRow } from '@/lib/db'
import { useSpatialStore } from '@/lib/spatial-store'
import { useSpatialStyleRules } from '@/hooks/useSpatialShapes'
// Note: the section's "Label" header import was dropped along with the
// inline header that used to live above the rules list — Section now
// owns the title and chevron / search affordances.
import { StyleRuleEditor } from './style-rule-editor'

export function StyleRulesSection() {
  const { t } = useTranslation()
  const { data: allRulesRaw = [] } = useSpatialStyleRules()
  const createLocal = useSpatialStore((s) => s.createLocal)
  const updateLocal = useSpatialStore((s) => s.updateLocal)
  const deleteLocal = useSpatialStore((s) => s.deleteLocal)

  // Read the active warehouse from the URL search param so this
  // section only shows rules scoped to the warehouse the user is
  // currently editing. Strict per-warehouse scoping: when a warehouse
  // is active, only rules with a matching zoneId appear — tenant-shared
  // rules (zoneId null/undefined) do NOT leak into a per-warehouse
  // view. When no warehouse is active (dashboard / list view), only
  // tenant-shared rules appear.
  const [searchParams] = useSearchParams()
  const activeWarehouseId = useMemo(() => {
    const raw = searchParams.get('warehouseId')
    if (raw === null || !/^\d+$/.test(raw)) return null
    return Number(raw)
  }, [searchParams])

  const allRules = useMemo(
    () =>
      [...allRulesRaw]
        .filter((r) => (r.zoneId ?? null) === activeWarehouseId)
        .sort((a, b) => a.priority - b.priority),
    [allRulesRaw, activeWarehouseId],
  )
  const query = useWorkspaceQuery()
  const rules = allRules.filter((r) => matchesWorkspaceQuery(r.name, query))
  const [editingId, setEditingId] = useState<number | 'new' | null>(null)
  // Mirror the saved-shape sections: drop the whole section while
  // searching if no rules match, but keep it rendered with the "Add
  // rule" CTA when no query is active even if the list is empty.
  if (query.trim().length > 0 && rules.length === 0) return null

  const handleAdd = async () => {
    const now = new Date()
    const rule = await createLocal(
      'style-rules',
      {
        name: 'New rule',
        scope: 'grid-cell',
        enabled: true,
        // Priority is computed off the *full* rule set, not the
        // search-filtered subset — otherwise the next-priority hint
        // would skip slots that exist outside the active query.
        priority: nextPriority(allRules),
        combine: 'and',
        conditions: [{ attribute: 'status', op: 'equals', value: 'empty' }],
        style: { fillColor: '#94a3b8' },
        // Scope new rules to the active warehouse so they don't bleed
        // into other warehouses via the tenant-shared fallback.
        zoneId: activeWarehouseId ?? undefined,
        createdAt: now,
        updatedAt: now,
      } as unknown as Omit<import('@/lib/style-rules/types').StyleRule, 'id'>,
    )
    setEditingId(rule.id!)
  }

  const handleToggle = (rule: StyleRuleRow) => {
    if (rule.id === undefined) return
    updateLocal('style-rules', rule.id, {
      enabled: !rule.enabled,
      updatedAt: new Date(),
    })
  }

  const handleDelete = (id: number) => {
    deleteLocal('style-rules', id)
    if (editingId === id) setEditingId(null)
  }

  return (
    <Section title="Style rules" icon={Filter}>
      {/* "Add rule" used to live on the title bar; in workspace mode
          the title is now a collapse toggle, so the add affordance
          moves into the body. Always-visible whether or not rules
          exist — clicking it both seeds a starter row and opens its
          inline editor. */}
      <div className="flex items-center justify-end">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-[11px]"
          onClick={() => void handleAdd()}
        >
          <Plus className="w-3 h-3 me-1" />
          Add rule
        </Button>
      </div>

      {rules.length === 0 && (
        <div className="px-3 py-4 text-[11px] text-muted-foreground border border-dashed rounded-md text-center">
          No rules yet. Add one to paint cells / shapes from your imported data.
        </div>
      )}

      <div className="space-y-1">
        {rules.map((rule) => (
          <div key={rule.id} className="border rounded-md overflow-hidden bg-background/40">
            <div className="flex items-center gap-1.5 px-2 py-1.5">
              <button
                type="button"
                onClick={() => void handleToggle(rule)}
                className="flex items-center justify-center w-6 h-6 rounded hover:bg-accent transition-colors"
                title={rule.enabled ? t('styleRules.disableRule', { defaultValue: 'Disable rule' }) : t('styleRules.enableRule', { defaultValue: 'Enable rule' })}
                aria-label={rule.enabled ? t('styleRules.disableRule', { defaultValue: 'Disable rule' }) : t('styleRules.enableRule', { defaultValue: 'Enable rule' })}
                aria-pressed={rule.enabled}
              >
                {rule.enabled ? (
                  <Power className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <PowerOff className="w-3 h-3 text-muted-foreground" />
                )}
              </button>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium truncate">{rule.name}</div>
                <div className="text-[10px] text-muted-foreground font-mono">
                  {rule.scope} · prio {rule.priority} ·{' '}
                  {rule.conditions.length} cond
                </div>
              </div>
              <button
                type="button"
                onClick={() =>
                  setEditingId(editingId === rule.id ? null : rule.id ?? null)
                }
                className="flex items-center justify-center w-6 h-6 rounded hover:bg-accent transition-colors"
                title={t('styleRules.editRule', { defaultValue: 'Edit rule' })}
                aria-label={t('styleRules.editRule', { defaultValue: 'Edit rule' })}
              >
                <Pencil className="w-3 h-3" />
              </button>
              <button
                type="button"
                onClick={() => rule.id !== undefined && void handleDelete(rule.id)}
                className="flex items-center justify-center w-6 h-6 rounded hover:bg-destructive/10 hover:text-destructive transition-colors"
                title={t('styleRules.deleteRule', { defaultValue: 'Delete rule' })}
                aria-label={t('styleRules.deleteRule', { defaultValue: 'Delete rule' })}
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
            {editingId === rule.id && rule.id !== undefined && (
              <StyleRuleEditor
                key={rule.id}
                rule={rule}
                onClose={() => setEditingId(null)}
              />
            )}
          </div>
        ))}
      </div>
    </Section>
  )
}

function nextPriority(rules: ReadonlyArray<{ priority: number }>): number {
  if (rules.length === 0) return 10
  const max = rules.reduce((m, r) => Math.max(m, r.priority), 0)
  return max + 10
}

// Re-export so callers can pull both components from one path.
export { StyleRuleEditor } from './style-rule-editor'
