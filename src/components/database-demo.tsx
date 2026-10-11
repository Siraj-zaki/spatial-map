import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Database, Plus, Trash2 } from 'lucide-react'

import { apiDb } from '@/lib/api-db'
import { useCurrentTenantId } from '@/lib/data-link/tenant-service'
import { queryCache, useApiQuery } from '@/lib/useApiQuery'
import { SIDE_PANEL_DEFAULT_CONFIG } from '@/components/side-panel'
import { Button } from '@/components/ui/button'

export function DatabaseDemo() {
  const { t } = useTranslation()
  const tenantId = useCurrentTenantId()
  const [gridName, setGridName] = useState('New Grid')

  const gridsQuery = useApiQuery(() => apiDb.grids.toArray(), ['grids', tenantId], { intervalMs: 10000 })
  const grids = gridsQuery.data

  async function addGrid() {
    try {
      const now = new Date()
      await apiDb.grids.add({
        name: gridName,
        start: [55.2963, 25.276],
        current: [55.3063, 25.286],
        config: { ...SIDE_PANEL_DEFAULT_CONFIG },
        createdAt: now,
        updatedAt: now,
      })
      queryCache.invalidate('grids')
      setGridName(`New Grid ${Math.floor(Math.random() * 1000)}`)
    } catch (error) {
      console.error(`Failed to add grid: ${error}`)
    }
  }

  async function deleteGrid(id: number) {
    await apiDb.grids.delete(id)
    queryCache.invalidate('grids')
  }

  async function clearAll() {
    await apiDb.grids.clear()
    queryCache.invalidate('grids')
  }

  return (
    <div className="w-full max-w-md p-6 border rounded-xl bg-card text-card-foreground shadow-sm">
      <div className="flex items-center gap-2 mb-4">
        <Database className="w-5 h-5 text-primary" />
        <h2 className="text-xl font-semibold">{t('db.title')}</h2>
      </div>

      <p className="text-sm text-muted-foreground mb-4">
        {t('db.description')}
      </p>

      <div className="flex gap-2 mb-4">
        <Button onClick={addGrid} className="w-full" variant="default">
          <Plus className="w-4 h-4 me-2" />
          {t('db.saveMockGrid')}
        </Button>
        <Button
          onClick={clearAll}
          variant="destructive"
          size="icon"
          title={t('db.saveMockGrid')}
          aria-label={t('db.saveMockGrid')}
        >
          <Trash2 className="w-4 h-4" />
        </Button>
      </div>

      <div className="space-y-2">
        {grids?.length === 0 ? (
          <p className="text-sm text-muted-foreground italic text-center py-4">
            {t('db.noGrids')}
          </p>
        ) : (
          grids?.map((grid) => (
            <div key={grid.id} className="flex items-center justify-between p-3 rounded-lg bg-muted/50 border">
              <div>
                <p className="font-medium text-sm">{grid.name}</p>
                <p className="text-xs text-muted-foreground">{t('db.id')}: {grid.id}</p>
              </div>
              <Button
                onClick={() => grid.id && deleteGrid(grid.id)}
                variant="ghost"
                size="icon"
                className="text-destructive hover:bg-destructive/10"
                aria-label={t('db.saveMockGrid')}
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
