/**
 * Paged loading for the Files screen: the first page for the current
 * filters, then "Load more" appends the rows after the ones held (by
 * offset, so a delete shifting page boundaries never skips or repeats a
 * file).
 *
 * - Changing a filter keeps the previous rows on screen (`refreshing`)
 *   until the new first page lands — no skeleton flash on every keystroke.
 * - Responses for an older filter key are dropped, so a slow request can
 *   never overwrite a newer one.
 * - `reload()` re-fetches everything currently loaded in one request
 *   (after a delete, an SSE "files" event, or Refresh) without losing the
 *   scroll position.
 *
 * Loading flags are derived from which key the held result belongs to,
 * not set inside effects.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { listFiles, type FileCard, type FilesPage, type FilesQuery } from '@/lib/files-client'

export const FILES_PAGE_SIZE = 24
const MAX_PAGE = 200 // backend clamp

interface Held {
  key: string
  rows: FileCard[]
  meta: FilesPage
}

export function useFilesPages(query: Omit<FilesQuery, 'offset' | 'pageSize'>, scope: unknown, enabled: boolean) {
  const key = JSON.stringify([scope, query])
  const [held, setHeld] = useState<Held | null>(null)
  const [failed, setFailed] = useState<{ key: string; error: Error } | null>(null)
  const [more, setMore] = useState<{ key: string; state: 'loading' | 'error' } | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const [reloading, setReloading] = useState(false)

  // Latest values for async callbacks without re-subscribing effects.
  const latest = useRef({ key, query, held })
  useEffect(() => {
    latest.current = { key, query, held }
  })

  // First page whenever the filter key changes, or a reload is requested.
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const prev = latest.current.held
    // A reload keeps everything already loaded; a new filter starts over.
    const size = reloadToken && prev?.key === key ? Math.min(Math.max(prev.rows.length, FILES_PAGE_SIZE), MAX_PAGE) : FILES_PAGE_SIZE
    listFiles({ ...query, offset: 0, pageSize: size })
      .then((meta) => {
        if (cancelled) return
        setHeld({ key, rows: meta.rows, meta })
        setFailed(null)
      })
      .catch((error: Error) => {
        if (!cancelled) setFailed({ key, error })
      })
      .finally(() => {
        if (!cancelled) setReloading(false)
      })
    return () => {
      cancelled = true
    }
    // `query` is captured by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, reloadToken])

  const current = held?.key === key ? held : null
  const error = failed?.key === key && !current ? failed.error : null
  const hasMore = !!current && current.rows.length < current.meta.total
  const moreState = more?.key === key ? more.state : null

  const loadMore = useCallback(async () => {
    const { key: k, query: q, held: h } = latest.current
    if (!h || h.key !== k || h.rows.length >= h.meta.total) return
    setMore({ key: k, state: 'loading' })
    try {
      const page = await listFiles({ ...q, offset: h.rows.length, pageSize: FILES_PAGE_SIZE })
      if (latest.current.key !== k) return
      setHeld((cur) => {
        if (!cur || cur.key !== k) return cur
        const seen = new Set(cur.rows.map((r) => r.key))
        return { key: k, rows: [...cur.rows, ...page.rows.filter((r) => !seen.has(r.key))], meta: page }
      })
      setMore(null)
    } catch {
      if (latest.current.key === k) setMore({ key: k, state: 'error' })
    }
  }, [])

  const reload = useCallback(() => {
    setReloading(true)
    setReloadToken((n) => n + 1)
  }, [])

  /** Optimistically drop rows (after a delete) before the reload lands. */
  const removeRows = useCallback((keys: string[]) => {
    const drop = new Set(keys)
    setHeld((cur) => (cur ? { ...cur, rows: cur.rows.filter((r) => !drop.has(r.key)), meta: { ...cur.meta, total: Math.max(0, cur.meta.total - keys.length) } } : cur))
  }, [])

  return {
    rows: current?.rows ?? held?.rows ?? [],
    /** Meta for the current filters, or the last one while it loads. */
    meta: current?.meta ?? held?.meta ?? null,
    /** Nothing to show yet — first load of the page. */
    initialLoading: enabled && !held && !error,
    /** New filters are loading while the previous results stay visible. */
    refreshing: enabled && !!held && !current && !error,
    reloading,
    error,
    hasMore,
    loadingMore: moreState === 'loading',
    loadMoreFailed: moreState === 'error',
    loadMore,
    reload,
    removeRows,
  }
}
