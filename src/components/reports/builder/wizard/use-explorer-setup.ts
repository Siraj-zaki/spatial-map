/**
 * Shared by the Widgets and Layout steps: what a "Facility map & list"
 * needs (sources, facilities, data links), adding one, and the one-click
 * suggestion for the report's own source.
 */
import { useEffect, useState } from 'react'
import { apiDb } from '@/lib/api-db'
import type { DataLinkConfig, Zone } from '@/lib/db'
import { listReportSources, type ReportSourceHint } from '@/lib/reports-client'
import {
  dataLinkTab,
  facilityFromFilters,
  facilityTab,
  isFacilityEntity,
  type ExplorerBindings,
  type ExplorerTabConfig,
} from '@/lib/reports/explorer-spec'
import { useWizard } from './wizard-state'
import { loadSourceSchema, useSourceSchema } from './use-source-schema'

export interface ExplorerSetupData {
  sourceHints: ReportSourceHint[]
  zones: Zone[]
  dataLinks: DataLinkConfig[]
}

/** The tenant's sources, facilities and data links — loaded once per step mount. */
export function useExplorerData(): ExplorerSetupData {
  const [sourceHints, setSourceHints] = useState<ReportSourceHint[]>([])
  const [zones, setZones] = useState<Zone[]>([])
  const [dataLinks, setDataLinks] = useState<DataLinkConfig[]>([])
  useEffect(() => {
    let cancelled = false
    listReportSources()
      .then((hints) => !cancelled && setSourceHints(hints))
      .catch(() => !cancelled && setSourceHints([]))
    apiDb.zones
      .toArray()
      .then((list) => !cancelled && setZones(list.filter((z) => z.id !== undefined)))
      .catch((err: unknown) => console.warn('[reports.wizard] zones load failed', err))
    apiDb.dataLinkConfigs
      .toArray()
      .then((list) => !cancelled && setDataLinks(list))
      .catch((err: unknown) => console.warn('[reports.wizard] data links load failed', err))
    return () => {
      cancelled = true
    }
  }, [])
  return { sourceHints, zones, dataLinks }
}

/** Fresh widget id (`w_` — see compileExplorer). Only called from handlers. */
export function newWidgetId(): string {
  return `w_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
}

export function useExplorerActions(zones: readonly Zone[]) {
  const { draft, update } = useWizard()

  // The facility a new map & list starts on: the report's, else the one
  // its filters pin, else the only one there is.
  const defaultZone = draft.zoneId ?? facilityFromFilters(draft.filters) ?? (zones.length === 1 ? zones[0].id : undefined) ?? undefined

  // A source a map & list starts reading joins the viewer filters whose
  // field it has (Floor narrows a new Racks tab too). Only sources new
  // to the report, so an author's unticking in "Narrows" sticks.
  const joinViewerFilters = (before: readonly ExplorerTabConfig[], after: readonly ExplorerTabConfig[]) => {
    const known = new Set(before.map((tab) => tab.sourceId))
    for (const vf of draft.viewerFilters) for (const id of vf.sourceIds) known.add(id)
    const added = [...new Set(after.map((tab) => tab.sourceId))].filter((id) => id && !known.has(id))
    for (const id of added) {
      loadSourceSchema(id)
        .then((schema) =>
          update((prev) => ({
            viewerFilters: prev.viewerFilters.map((vf) =>
              schema.fields.some((f) => f.key === vf.field) && !vf.sourceIds.includes(id)
                ? { ...vf, sourceIds: [...vf.sourceIds, id] }
                : vf,
            ),
          })),
        )
        .catch(() => {})
    }
  }

  /** Adds a map & list; returns its id. */
  const addExplorer = (bindings: ExplorerBindings, title?: string): string => {
    const nextOrder = 20 + draft.extraWidgets.length
    const id = newWidgetId()
    joinViewerFilters([], bindings.tabs)
    update({
      // A shared report with a facility map belongs to that facility.
      ...(draft.zoneId == null && bindings.zoneId ? { zoneId: bindings.zoneId } : {}),
      extraWidgets: [
        ...draft.extraWidgets,
        {
          id,
          kind: 'facilityExplorer',
          title,
          position: { x: 0, y: nextOrder, w: 12, h: 10 },
          order: nextOrder,
          bindings: { ...bindings },
        },
      ],
    })
    return id
  }

  return { defaultZone, joinViewerFilters, addExplorer }
}

/**
 * One-click "map & list" for the report's own source: a facility source
 * becomes a tab of that item type; a linked table becomes a tab placed
 * by its data link (the one on the report's facility, else the first).
 */
export function useExplorerSuggestion({
  sourceId,
  hasExplorer,
  sourceHints,
  dataLinks,
  defaultZone,
}: {
  sourceId: number | undefined
  hasExplorer: boolean
  sourceHints: readonly ReportSourceHint[]
  dataLinks: readonly DataLinkConfig[]
  defaultZone: number | undefined
}): { name: string; bindings: ExplorerBindings } | null {
  const hint = sourceHints.find((h) => h.id === sourceId)
  const links = hint && hint.kind !== 'facility' ? dataLinks.filter((l) => l.sourceId === hint.id && l.id !== undefined) : []
  const link = links.find((l) => l.zoneId === defaultZone) ?? links[0]
  const { schema } = useSourceSchema(link ? hint?.id : null)
  if (hasExplorer || !hint) return null
  if (hint.kind === 'facility') {
    const entity = hint.facilityEntity ?? ''
    if (!isFacilityEntity(entity)) return null
    const tab: ExplorerTabConfig = facilityTab(entity, hint.id)
    return { name: hint.name, bindings: { zoneId: defaultZone, tabs: [tab] } }
  }
  if (!link || !schema) return null
  return {
    name: hint.name,
    bindings: { zoneId: link.zoneId, tabs: [{ ...dataLinkTab(link, schema.fields), label: schema.name }] },
  }
}
