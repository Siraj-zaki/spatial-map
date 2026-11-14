/**
 * Focus mode — leaving it with Esc or a click on empty map.
 *
 * Both listeners exist only while focus is active, so focus-off costs
 * nothing. Neither steals input from anything that handles it first:
 *
 *  - Esc is read on `window` in the bubble phase and ignored once someone
 *    called `preventDefault` (Radix dismissable layers do when they close
 *    — closing the drawer is its own exit path), while typing, and inside
 *    dialogs, menus, listboxes and popovers.
 *  - A map `click` waits one microtask so every other click handler (the
 *    overlays' delegated layer handlers run in the same dispatch) has had
 *    its turn, then exits only when nothing claimed the click: not
 *    `preventDefault`ed, and no overlay / data-link feature, marker or
 *    popup under the pointer.
 */

import type { Map as MapboxMapInstance, MapMouseEvent } from 'mapbox-gl'
import { useEffect, useRef } from 'react'

import { overlayKindOfLayer } from '@/lib/overlay-hit-priority'

const HIT_BUFFER_PX = 4

/** Inside one of these, Esc belongs to that widget. */
const ESC_OWNER_SELECTOR =
  '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[data-radix-popper-content-wrapper]'

/** DOM on the map that is "something", not empty map. */
const MAP_ITEM_SELECTOR = '.shape-marker,.mapboxgl-popup'

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/**
 * True when a map click landed on nothing focusable: no feature of an
 * overlay layer (`overlayKindOfLayer`) or a data-link layer (`dl-…`)
 * within 4 px, and not on a marker / popup element.
 */
export function isEmptyMapClick(map: MapboxMapInstance, e: MapMouseEvent): boolean {
  const target = (e.originalEvent as Event | undefined)?.target
  if (target instanceof Element && target.closest(MAP_ITEM_SELECTOR)) return false
  const { x, y } = e.point
  let features: ReadonlyArray<{ layer?: { id?: string } | null }>
  try {
    features = map.queryRenderedFeatures([
      [x - HIT_BUFFER_PX, y - HIT_BUFFER_PX],
      [x + HIT_BUFFER_PX, y + HIT_BUFFER_PX],
    ])
  } catch {
    // Can't tell — keep focus rather than drop it on a guess.
    return false
  }
  for (const f of features) {
    const id = f.layer?.id ?? ''
    if (id.startsWith('dl-') || overlayKindOfLayer(id) !== null) return false
  }
  return true
}

/**
 * Esc (window keydown, bubble; ignored when defaultPrevented, typing
 * target, or inside [role=dialog]/[role=menu]/[role=listbox]/[data-radix-popper-content-wrapper])
 * and empty map click (map 'click' → queueMicrotask → unclaimed +
 * isEmptyMapClick). Listeners only while active. opts default
 * {escape:true, emptyClick:true}.
 */
export function useFocusExit(
  map: MapboxMapInstance | null,
  active: boolean,
  onExit: () => void,
  opts?: { escape?: boolean; emptyClick?: boolean },
): void {
  // Latest callback without re-subscribing the listeners.
  const onExitRef = useRef(onExit)
  useEffect(() => {
    onExitRef.current = onExit
  }, [onExit])

  const escape = opts?.escape ?? true
  const emptyClick = opts?.emptyClick ?? true

  useEffect(() => {
    if (!active || !escape || typeof window === 'undefined') return
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape' || ev.defaultPrevented || ev.isComposing) return
      if (isTypingTarget(ev.target)) return
      if (ev.target instanceof Element && ev.target.closest(ESC_OWNER_SELECTOR)) return
      onExitRef.current()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [active, escape])

  useEffect(() => {
    if (!map || !active || !emptyClick) return
    let live = true
    const onClick = (e: MapMouseEvent) => {
      queueMicrotask(() => {
        if (!live || e.defaultPrevented) return
        if (!isEmptyMapClick(map, e)) return
        onExitRef.current()
      })
    }
    map.on('click', onClick)
    return () => {
      live = false
      map.off('click', onClick)
    }
  }, [map, active, emptyClick])
}
