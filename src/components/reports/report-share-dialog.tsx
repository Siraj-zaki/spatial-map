/**
 * ReportShareDialog — share one report. Two ways:
 *
 *   • Workspace members: copy this page's link (it carries the filters set
 *     now; it opens for anyone who can already see the report).
 *   • Anyone with the link: public, read-only links (`/r/:token`) — the
 *     report's widgets, live map, layers and history player, no sign-in.
 *     Each link has an optional label, expiry and view cap, can open with
 *     the current filters and on the map or the page, and can be revoked
 *     (or, by owners and admins, deleted) at any time.
 *
 * Links are listed newest first, revoked ones too, so the author can audit
 * who has what. Server side: report_share_links.go.
 */

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy, ExternalLink, Globe2, Link2, Loader2, Trash2, Users } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { relativeTime } from '@/lib/relative-time'
import { createReportShareLink, listReportShareLinks, reportShareUrl, type ReportShareSettings } from '@/lib/reports/report-share'
import { deleteShareLink, EXPIRY_PRESETS, revokeShareLink, type ShareLink, type ShareLinkStatus } from '@/lib/share-link-client'
import { toast } from '@/lib/toast-store'
import { cn } from '@/lib/utils'
import type { Report } from '@/lib/reports-client'

const EXPIRY: Array<{ key: keyof typeof EXPIRY_PRESETS | 'NEVER'; labelKey: string; fallback: string }> = [
  { key: 'ONE_DAY', labelKey: 'shareLink.expiry.oneDay', fallback: '1 day' },
  { key: 'SEVEN_DAYS', labelKey: 'shareLink.expiry.sevenDays', fallback: '7 days' },
  { key: 'THIRTY_DAYS', labelKey: 'shareLink.expiry.thirtyDays', fallback: '30 days' },
  { key: 'NINETY_DAYS', labelKey: 'shareLink.expiry.ninetyDays', fallback: '90 days' },
  { key: 'ONE_YEAR', labelKey: 'shareLink.expiry.oneYear', fallback: '1 year' },
  { key: 'NEVER', labelKey: 'shareLink.expiry.never', fallback: 'Never expires' },
]

const STATUS_TONE: Record<ShareLinkStatus, string> = {
  active: 'bg-success/10 text-success',
  expired: 'bg-warning/10 text-warning',
  capped: 'bg-warning/10 text-warning',
  revoked: 'bg-danger/10 text-danger',
}

export function ReportShareDialog({
  open,
  onOpenChange,
  report,
  hasMap,
  currentView,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  report: Report
  /** The report has a full-map view (a facility explorer). */
  hasMap: boolean
  currentView: 'map' | 'page'
}) {
  const { t, i18n } = useTranslation()
  const [links, setLinks] = useState<ShareLink[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)

  const [label, setLabel] = useState('')
  const [expiry, setExpiry] = useState<(typeof EXPIRY)[number]['key']>('SEVEN_DAYS')
  const [maxViews, setMaxViews] = useState('')
  // The page's query string = its filter values and hidden map layers.
  const [search] = useState(() => window.location.search.replace(/^\?/, ''))
  const [withFilters, setWithFilters] = useState(true)
  const [openAs, setOpenAs] = useState<'map' | 'page'>(currentView)

  // Mounted only while open, so this loads once per opening.
  const load = useCallback(
    () =>
      listReportShareLinks(report.id)
        .then((rows) => {
          setLinks(rows)
          setLoadError(false)
        })
        .catch(() => setLoadError(true)),
    [report.id],
  )
  useEffect(() => {
    void load()
  }, [load])

  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(key)
      window.setTimeout(() => setCopied((k) => (k === key ? null : k)), 1800)
      return true
    } catch {
      toast.error(t('reports.viewer.copyFailed', { defaultValue: 'Couldn’t copy the link' }))
      return false
    }
  }

  const create = async () => {
    const cap = maxViews.trim() === '' ? null : Math.floor(Number(maxViews))
    if (cap !== null && (!Number.isFinite(cap) || cap < 1)) {
      toast.error(t('reports.share.badCap', { defaultValue: 'Maximum views must be a whole number of 1 or more.' }))
      return
    }
    const settings: ReportShareSettings = {}
    if (withFilters && search) settings.search = search
    if (hasMap) settings.view = openAs
    setBusy(true)
    try {
      const link = await createReportShareLink(report.id, {
        label: label.trim(),
        expirySeconds: expiry === 'NEVER' ? null : EXPIRY_PRESETS[expiry],
        maxViews: cap,
        settings,
      })
      setLinks((prev) => [link, ...(prev ?? [])])
      setLabel('')
      setMaxViews('')
      const ok = await copy(reportShareUrl(link.token), `link:${link.id}`)
      toast.success(
        ok
          ? t('reports.share.createdCopied', { defaultValue: 'Link created and copied' })
          : t('reports.share.created', { defaultValue: 'Link created' }),
      )
    } catch {
      toast.error(t('reports.share.createFailed', { defaultValue: 'Couldn’t create the link.' }))
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (link: ShareLink) => {
    setBusy(true)
    try {
      const next = await revokeShareLink(link.id)
      setLinks((prev) => (prev ?? []).map((l) => (l.id === link.id ? next : l)))
      toast.success(t('reports.share.revoked', { defaultValue: 'Link revoked — it no longer opens.' }))
    } catch {
      toast.error(t('reports.share.revokeFailed', { defaultValue: 'Couldn’t revoke the link.' }))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (link: ShareLink) => {
    setBusy(true)
    try {
      await deleteShareLink(link.id)
      setLinks((prev) => (prev ?? []).filter((l) => l.id !== link.id))
    } catch {
      toast.error(t('reports.share.deleteFailed', { defaultValue: 'Only workspace owners and admins can delete a link.' }))
    } finally {
      setBusy(false)
    }
  }

  const statusLabel: Record<ShareLinkStatus, string> = {
    active: t('reports.share.status.active', { defaultValue: 'Active' }),
    expired: t('reports.share.status.expired', { defaultValue: 'Expired' }),
    capped: t('reports.share.status.capped', { defaultValue: 'View limit reached' }),
    revoked: t('reports.share.status.revoked', { defaultValue: 'Revoked' }),
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90dvh] max-w-xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b px-5 pb-4 pt-5">
          <DialogTitle className="flex items-center gap-2 text-lg">
            <Link2 className="h-5 w-5" aria-hidden />
            {t('reports.share.title', { defaultValue: 'Share report' })}
          </DialogTitle>
          <DialogDescription className="line-clamp-1">{report.name}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-5 py-4">
          <section className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3">
            <Users className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{t('reports.share.membersTitle', { defaultValue: 'Workspace members' })}</p>
              <p className="text-xs text-muted-foreground">
                {t('reports.share.membersBody', { defaultValue: 'Opens for people who can already see this report, with the filters set now.' })}
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => void copy(window.location.href, 'members')}>
              {copied === 'members' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {t('reports.mapView.copyLink', { defaultValue: 'Copy link' })}
            </Button>
          </section>

          <section className="space-y-3">
            <div className="flex items-start gap-2">
              <Globe2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <div>
                <p className="text-sm font-medium">{t('reports.share.publicTitle', { defaultValue: 'Anyone with the link' })}</p>
                <p className="text-xs text-muted-foreground">
                  {t('reports.share.publicBody', {
                    defaultValue: 'A read-only page with this report’s widgets, live map, layers and history player — no sign-in. Nothing else in the workspace is shared.',
                  })}
                </p>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 sm:col-span-2">
                <span className="text-xs font-medium">{t('shareLink.field.label', { defaultValue: 'Label' })}</span>
                <Input
                  value={label}
                  maxLength={120}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder={t('reports.share.labelPlaceholder', { defaultValue: 'e.g. Weekly review, Customer demo' })}
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs font-medium">{t('shareLink.section.expiry', { defaultValue: 'Expiry' })}</span>
                <select
                  value={expiry}
                  onChange={(e) => setExpiry(e.target.value as typeof expiry)}
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                >
                  {EXPIRY.map((o) => (
                    <option key={o.key} value={o.key}>
                      {t(o.labelKey, { defaultValue: o.fallback })}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-xs font-medium">{t('shareLink.field.maxViews', { defaultValue: 'Maximum views' })}</span>
                <Input
                  type="number"
                  min={1}
                  inputMode="numeric"
                  value={maxViews}
                  onChange={(e) => setMaxViews(e.target.value)}
                  placeholder={t('shareLink.field.maxViewsPlaceholder', { defaultValue: 'Unlimited' })}
                />
              </label>
            </div>

            {search && (
              <label className="flex items-center justify-between gap-3 text-sm">
                <span>
                  {t('reports.share.withFilters', { defaultValue: 'Open with the filters set now' })}
                  <span className="block text-xs text-muted-foreground">
                    {t('reports.share.withFiltersHint', { defaultValue: 'Visitors can still change them.' })}
                  </span>
                </span>
                <Switch checked={withFilters} onCheckedChange={setWithFilters} />
              </label>
            )}
            {hasMap && (
              <div className="flex items-center justify-between gap-3 text-sm">
                <span>{t('reports.share.openAs', { defaultValue: 'Opens on' })}</span>
                <div className="inline-flex rounded-md border p-0.5" role="group">
                  {(['map', 'page'] as const).map((v) => (
                    <button
                      key={v}
                      type="button"
                      aria-pressed={openAs === v}
                      onClick={() => setOpenAs(v)}
                      className={cn(
                        'h-7 rounded px-3 text-xs font-medium transition-colors',
                        openAs === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {v === 'map'
                        ? t('reports.mapView.mapView', { defaultValue: 'Map view' })
                        : t('reports.mapView.pageView', { defaultValue: 'Page view' })}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <Button className="w-full" onClick={() => void create()} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
              {t('reports.share.create', { defaultValue: 'Create link' })}
            </Button>
          </section>

          <section className="space-y-2 border-t pt-4" aria-live="polite">
            <p className="text-xs font-medium text-muted-foreground">{t('reports.share.linksTitle', { defaultValue: 'Links to this report' })}</p>
            {loadError ? (
              <div className="flex items-center justify-between gap-2 rounded-lg border p-3 text-sm">
                <span className="text-danger">{t('reports.share.loadFailed', { defaultValue: 'Couldn’t load the links.' })}</span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setLoadError(false)
                    setLinks(null)
                    void load()
                  }}
                >
                  {t('common.retry', { defaultValue: 'Retry' })}
                </Button>
              </div>
            ) : links === null ? (
              <div className="h-16 animate-pulse rounded-lg bg-muted" aria-busy />
            ) : links.length === 0 ? (
              <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                {t('reports.share.none', { defaultValue: 'No public links yet.' })}
              </p>
            ) : (
              <ul className="space-y-2">
                {links.map((link) => {
                  const url = reportShareUrl(link.token)
                  const live = link.status === 'active'
                  return (
                    <li key={link.id} className={cn('space-y-2 rounded-lg border p-3', !live && 'opacity-70')}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-sm font-medium">
                              {link.label || t('shareLink.manage.untitled', { defaultValue: 'Untitled link' })}
                            </span>
                            <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-medium', STATUS_TONE[link.status])}>
                              {statusLabel[link.status]}
                            </span>
                          </div>
                          <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                            <span>
                              {link.maxViews != null
                                ? t('reports.share.viewsOfCap', { count: link.viewCount, cap: link.maxViews, defaultValue: '{{count}} of {{cap}} views' })
                                : t('shareLink.manage.viewCount', { count: link.viewCount, defaultValue: '{{count}} views' })}
                            </span>
                            <span>
                              {link.expiresAt
                                ? t('shareLink.manage.expiresAt', { when: relativeTime(link.expiresAt, i18n.language), defaultValue: 'Expires {{when}}' })
                                : t('shareLink.expiry.never', { defaultValue: 'Never expires' })}
                            </span>
                            {link.settings && Object.keys(link.settings).length > 0 && 'search' in link.settings && (
                              <span>{t('reports.share.hasFilters', { defaultValue: 'With filters' })}</span>
                            )}
                          </p>
                        </div>
                        {live ? (
                          <Button size="sm" variant="ghost" className="h-7 shrink-0 text-xs" onClick={() => void revoke(link)} disabled={busy}>
                            {t('shareLink.manage.revoke', { defaultValue: 'Revoke' })}
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 shrink-0 p-0 text-danger hover:bg-danger/10 hover:text-danger"
                            onClick={() => void remove(link)}
                            disabled={busy}
                            aria-label={t('reports.share.delete', { defaultValue: 'Delete link' })}
                            title={t('reports.share.delete', { defaultValue: 'Delete link' })}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                      {live && (
                        <div className="flex items-center gap-1.5">
                          <Input readOnly value={url} className="h-8 font-mono text-xs" onFocus={(e) => e.currentTarget.select()} aria-label={t('reports.share.url', { defaultValue: 'Link address' })} />
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 w-8 shrink-0 p-0"
                            onClick={() => void copy(url, `link:${link.id}`)}
                            aria-label={t('shareLink.manage.copy', { defaultValue: 'Copy URL' })}
                            title={t('shareLink.manage.copy', { defaultValue: 'Copy URL' })}
                          >
                            {copied === `link:${link.id}` ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 w-8 shrink-0 p-0"
                            onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}
                            aria-label={t('shareLink.manage.open', { defaultValue: 'Open in new tab' })}
                            title={t('shareLink.manage.open', { defaultValue: 'Open in new tab' })}
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}
