/**
 * Cross-tree bridge for header-level map controls.
 *
 * The app's `<header>` lives in `App.tsx`, above the route content. The
 * map controls those buttons drive (zoom, fullscreen) live deep inside
 * `CreateGrids` because they need the map instance. There's no clean
 * way for the route to pass props UP to the header, so this tiny
 * zustand store acts as a one-way mailbox: routes that own a map
 * register their handlers on mount and clear them on unmount; the
 * header subscribes and renders the buttons disabled when no route is
 * publishing.
 *
 * Kept intentionally small and standalone — no other tool needs to
 * touch it, and the surface is narrow enough that two routes won't
 * fight over it (only one is mounted at a time).
 */

import { create } from 'zustand'

export interface HeaderControlsState {
  onZoomIn: (() => void) | null
  onZoomOut: (() => void) | null
  /** Toggles browser fullscreen on `document.documentElement`. */
  onToggleFullscreen: (() => void) | null
  /** Live fullscreen state — drives the icon swap (Maximize / Minimize). */
  isFullscreen: boolean
  /** Bulk setter so the registering route can publish in one shot. */
  setControls: (patch: Partial<Omit<HeaderControlsState, 'setControls'>>) => void
}

export const useHeaderControls = create<HeaderControlsState>((set) => ({
  onZoomIn: null,
  onZoomOut: null,
  onToggleFullscreen: null,
  isFullscreen: false,
  setControls: (patch) => set(patch),
}))
