import { useEffect, useRef, useState } from 'react'

import { fetchSharedWarehouse, type PublicSharedWarehouse } from '@/lib/share-link-client'

/**
 * useShareLink — resolves a share token via the rich `/api/v1/share/{token}`
 * endpoint, which returns `{ link: { settings, ... }, warehouse: WarehouseView }`
 * in one round-trip.
 *
 * Return states:
 *
 *   * loading = true                 — request in flight
 *   * error   = truthy               — network / server error (unexpected)
 *   * notFound = true                — endpoint returned 404; the caller
 *                                      should fall back to the legacy
 *                                      /public/warehouses/by-token path
 *   * data    = PublicSharedWarehouse — success; the viewer applies the
 *                                      `link.settings` blob and renders
 *                                      `data.warehouse` as the read-only
 *                                      envelope
 *
 * The hook memoises per-token in a ref-backed cache so React StrictMode's
 * double-mount doesn't fire two requests. `fetcher` swaps the endpoint —
 * the viewer passes one that also opens the link's table rows.
 */
export function useShareLink(
  token: string | undefined,
  fetcher: (token: string) => Promise<PublicSharedWarehouse | null> = fetchSharedWarehouse,
) {
  const [data, setData] = useState<PublicSharedWarehouse | null>(null)
  const [loading, setLoading] = useState<boolean>(token !== undefined)
  const [error, setError] = useState<Error | null>(null)
  const [notFound, setNotFound] = useState(false)
  const cache = useRef<Map<string, PublicSharedWarehouse | null>>(new Map())
  const generation = useRef(0)

  useEffect(() => {
    if (!token) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setData(null)
      setError(null)
      setLoading(false)
      setNotFound(false)
      return
    }
    if (cache.current.has(token)) {
      const cached = cache.current.get(token)!
      if (cached === null) {
        setNotFound(true)
        setLoading(false)
      } else {
        setData(cached)
        setNotFound(false)
        setLoading(false)
      }
      return
    }
    const gen = ++generation.current
    setLoading(true)
    setError(null)
    setNotFound(false)
    fetcher(token)
      .then((res) => {
        if (gen !== generation.current) return
        cache.current.set(token, res)
        if (res === null) {
          setNotFound(true)
        } else {
          setData(res)
        }
      })
      .catch((err: Error) => {
        if (gen !== generation.current) return
        setError(err)
      })
      .finally(() => {
        if (gen !== generation.current) return
        setLoading(false)
      })
  }, [token, fetcher])

  return { data, loading, error, notFound }
}
