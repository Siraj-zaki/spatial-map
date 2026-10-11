/**
 * DataLinkPanel — per-shape section that lists every DataLinkConfig
 * bound to the currently selected map shape, with edit / delete / add
 * controls. Rendered from `side-panel.tsx` at the bottom of each
 * shape-selected panel (polygon / circle / line / marker / model /
 * image) so users can wire live-data bindings to a specific shape
 * without leaving the sidebar.
 *
 * Data flow:
 *   - The host (create-grids.tsx) owns the DataLinkConfig catalog
 *     (`useSpatialDataLinks`), the editor-open state, and the
 *     currently-editing config id. It passes filtered + callbacks in.
 *   - This component is purely presentational — no store reads, no
 *     store writes; every mutation goes through the callbacks so
 *     the host can flush the spatial store consistently.
 */

import { Link2, Pencil, Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { DataLinkConfig } from '@/lib/db'

export interface DataLinkPanelProps {
  /**
   * Configs already filtered by the host to the currently-selected
   * shape (`config.targetKind === kind && config.targetShapeId ===
   * shapeId`). We don't re-filter — the host has the full catalog
   * and only knows the selection, so filtering there keeps this
   * component ignorant of catalog shape.
   */
  configs: ReadonlyArray<DataLinkConfig>
  /** Fires when the user clicks "+ Add data link". Host opens the
   *  editor dialog with a blank form (user picks the target manually
   *  from the shape kind + shape dropdown — a small UX friction we
   *  accept to keep the editor generic). */
  onNew: () => void
  /** Fires with the config id when the user clicks the row's edit
   *  affordance. Host opens the editor with that config preloaded. */
  onEdit: (configId: number) => void
  /** Fires with the config id when the user confirms delete. Host
   *  removes it from the spatial store; the overlay unmounts on the
   *  next tick. */
  onDelete: (configId: number) => void
}

export function DataLinkPanel({
  configs,
  onNew,
  onEdit,
  onDelete,
}: DataLinkPanelProps) {
  const { t } = useTranslation()

  return (
    <div className="border rounded-lg bg-background/50 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          <Link2 className="w-3 h-3" />
          {t('dataLink.panelTitle', { defaultValue: 'Data links' })}
          <span className="text-muted-foreground/70 font-normal normal-case tracking-normal">
            ({configs.length})
          </span>
        </div>
        <button
          type="button"
          onClick={onNew}
          className="flex items-center gap-1 h-6 px-1.5 text-[10px] font-medium rounded border bg-card hover:bg-accent transition-colors"
          title={t('dataLink.addToThisShape', {
            defaultValue: 'Add a data link',
          })}
        >
          <Plus className="w-3 h-3" />
          {t('dataLink.add', { defaultValue: 'Add' })}
        </button>
      </div>

      {configs.length === 0 ? (
        <p className="text-[10px] text-muted-foreground italic">
          {t('dataLink.emptyForShape', {
            defaultValue:
              'No data links yet. Click Add to bind a stream to this shape.',
          })}
        </p>
      ) : (
        <ul className="space-y-1">
          {configs.map((cfg) => (
            <li
              key={cfg.id}
              className="flex items-center justify-between gap-2 px-2 py-1.5 rounded border bg-card"
            >
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium truncate">{cfg.name}</div>
                <div className="text-[10px] text-muted-foreground flex items-center gap-1 flex-wrap">
                  <span
                    className="inline-block w-2 h-2 rounded"
                    style={{ backgroundColor: cfg.style.defaultColor ?? '#3b82f6' }}
                  />
                  <span>{cfg.renderMode}</span>
                  {!cfg.enabled && (
                    <span className="text-amber-600">
                      · {t('dataLink.disabled', { defaultValue: 'disabled' })}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  type="button"
                  onClick={() => cfg.id !== undefined && onEdit(cfg.id)}
                  className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
                  title={t('dataLink.edit', { defaultValue: 'Edit' })}
                  disabled={cfg.id === undefined}
                >
                  <Pencil className="w-3 h-3" />
                </button>
                <button
                  type="button"
                  onClick={() => cfg.id !== undefined && onDelete(cfg.id)}
                  className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
                  title={t('dataLink.delete', { defaultValue: 'Delete' })}
                  disabled={cfg.id === undefined}
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
