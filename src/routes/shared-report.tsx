/**
 * /r/:token — a report opened from a public link. No account needed: the
 * page opens the link (the report + the facility its map draws on), puts
 * lib/reports/report-share into shared mode, fills the map stores from the
 * link, then renders the read-only viewer (page or full map, filters,
 * layers, history player, follow).
 *
 * A dead link — revoked, expired, over its view limit, or a wrong token —
 * gets one "not available" screen: the server never says which.
 */

import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Link2Off, Loader2 } from 'lucide-react'

import { EmptyState } from '@/components/empty-state'
import { QueryError } from '@/components/feedback/query-error'
import { Toaster } from '@/components/feedback/toaster'
import { SharedReportViewer } from '@/components/reports/report-viewer'
import { ApiError } from '@/lib/api-client'
import { useDoorStore } from '@/lib/door/store'
import { fetchReportShare, setReportShare, type PublicReportShare } from '@/lib/reports/report-share'
import { resetSpatialSession, useSpatialStore } from '@/lib/spatial-store'

type SpatialState = ReturnType<typeof useSpatialStore.getState>

/** One open per token per page load — StrictMode's second effect run must
 *  not count a second view (a one-view link would die on its own open). */
const opening = new Map<string, Promise<PublicReportShare>>()
function openShare(token: string): Promise<PublicReportShare> {
  let p = opening.get(token)
  if (!p) {
    p = fetchReportShare(token)
    // A failed open may be retried.
    p.catch(() => opening.delete(token))
    opening.set(token, p)
  }
  return p
}

/** Fill the map stores with the link's facility, as loadAll would. */
function hydrateFacility(facility: NonNullable<PublicReportShare['facility']>): void {
  const w = facility.warehouse
  const zoneId = w.zone.id
  useSpatialStore.setState((s) => ({
    activeZoneId: zoneId,
    zones: [w.zone],
    grids: w.grids,
    bins: w.bins,
    polygons: w.polygons,
    circles: w.circles,
    lines: w.lines,
    markers: w.markers,
    images: w.images,
    models: w.models,
    imagePlanes: w.imagePlanes ?? [],
    stairs: w.stairs,
    doors: w.doors ?? [],
    textLabels: w.textLabels,
    styleRules: (w.styleRules ?? []) as unknown as SpatialState['styleRules'],
    dataLinkConfigs: w.dataLinkConfigs ?? [],
    loadedFor: Object.fromEntries(Object.keys(s.loadedFor).map((k) => [k, zoneId])) as SpatialState['loadedFor'],
  }))
  useDoorStore.setState({ doors: w.doors ?? [] })
}

/** The link's saved filters / hidden layers, unless the visitor's URL has its own. */
function applySearch(search: string | undefined): void {
  if (!search || window.location.search) return
  window.history.replaceState(window.history.state, '', `${window.location.pathname}?${search}${window.location.hash}`)
}

export default function SharedReportPage() {
  const { token = '' } = useParams<{ token: string }>()
  const { t, i18n } = useTranslation()
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<{ key: string; share?: PublicReportShare; error?: unknown } | null>(null)
  const key = `${token}:${attempt}`

  useEffect(() => {
    let cancelled = false
    openShare(token)
      .then((share) => {
        if (cancelled) return
        setReportShare({ token, userModels: share.facility?.userModels ?? [] })
        if (share.facility) hydrateFacility(share.facility)
        applySearch(share.link.settings.search)
        setState({ key, share })
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ key, error })
      })
    return () => {
      cancelled = true
    }
  }, [token, key])

  // Leaving the page leaves shared mode and the borrowed map data behind.
  useEffect(
    () => () => {
      setReportShare(null)
      resetSpatialSession()
      useDoorStore.setState({ doors: [] })
    },
    [],
  )

  // This page lives outside the app shell, which keeps <html lang/dir> in sync.
  useEffect(() => {
    const apply = () => {
      document.documentElement.lang = i18n.language
      document.documentElement.dir = i18n.dir()
    }
    apply()
    i18n.on('languageChanged', apply)
    return () => {
      i18n.off('languageChanged', apply)
    }
  }, [i18n])

  const current = state?.key === key ? state : null
  const dead = current?.error instanceof ApiError && current.error.status === 404

  let body: React.ReactNode
  if (dead) {
    body = (
      <div className="flex min-h-full items-center justify-center p-6">
        <EmptyState
          icon={Link2Off}
          title={t('reports.shared.deadTitle', { defaultValue: 'This link isn’t available' })}
          description={t('reports.shared.deadBody', {
            defaultValue: 'It may have expired, been revoked, or reached its view limit. Ask the person who shared it for a new link.',
          })}
        />
      </div>
    )
  } else if (current?.error) {
    body = (
      <div className="flex min-h-full items-center justify-center p-6">
        <QueryError
          error={current.error}
          onRetry={() => setAttempt((n) => n + 1)}
          what={t('reports.viewer.what', { defaultValue: 'this report' })}
        />
      </div>
    )
  } else if (!current?.share) {
    body = (
      <div className="flex min-h-full items-center justify-center gap-2 p-6 text-sm text-muted-foreground" aria-busy>
        <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
        {t('reports.shared.opening', { defaultValue: 'Opening report…' })}
      </div>
    )
  } else {
    const { share } = current
    body = (
      <SharedReportViewer
        report={share.report}
        facility={share.facility?.warehouse.zone.name ?? null}
        view={share.link.settings.view}
      />
    )
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <main className="relative min-h-0 flex-1 overflow-y-auto">{body}</main>
      <Toaster />
    </div>
  )
}
