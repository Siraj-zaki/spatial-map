import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

/**
 * Global graphics-quality toggles for the 3D map. Each flag maps to a
 * measurable GPU cost:
 *
 * - `shadows` — toggles the directional light's `cast-shadows` at the
 *   scene level (single lever that kills the shadow-map pass on every
 *   fill-extrusion and model layer at once). Also toggles per-layer
 *   `model-cast-shadows` / `model-receive-shadows`.
 *
 * - `ambientOcclusion` — toggles `fill-extrusion-ambient-occlusion-intensity`
 *   on every extrusion layer. AO is a screen-space pass; disabling it
 *   removes an entire GPU stage.
 *
 * Both default to `false` (performance-first). Users can flip them on
 * from the SidePanel graphics section — persisted to localStorage so
 * the preference survives across sessions.
 *
 * - `markerOcclusion` — hides HTML markers standing behind a floor-plan
 *   plate (see `src/lib/marker-occlusion.ts`). Unlike the two above this
 *   is a correctness knob rather than a GPU one, so it defaults to
 *   `true`: on a multi-floor stack a top-down camera should show the top
 *   floor's markers, not every floor's at once. Turning it off restores
 *   the flat behaviour where markers always draw over everything.
 */
export interface GraphicsSettings {
  shadows: boolean
  ambientOcclusion: boolean
  markerOcclusion: boolean
  /**
   * Wayfinding icons (and their labels) over escalator ends and elevator
   * doors. On by default; off gives a clean 3D scene. Display-only — the
   * lifts themselves are unaffected.
   */
  liftIcons: boolean
  /**
   * Building base under a raised floor shown on its own (floors below
   * hidden): 'solid' block, see-through 'ghost' with the hidden floors'
   * walls outlined, or 'off'. See src/lib/floor-base.ts.
   */
  floorBase: FloorBaseStyle
  setShadows: (v: boolean) => void
  setAmbientOcclusion: (v: boolean) => void
  setMarkerOcclusion: (v: boolean) => void
  setLiftIcons: (v: boolean) => void
  setFloorBase: (v: FloorBaseStyle) => void
}

export type FloorBaseStyle = 'solid' | 'ghost' | 'off'

export const useGraphicsSettings = create<GraphicsSettings>()(
  persist(
    (set) => ({
      shadows: false,
      ambientOcclusion: false,
      markerOcclusion: true,
      liftIcons: true,
      floorBase: 'solid',
      setShadows: (v) => set({ shadows: v }),
      setAmbientOcclusion: (v) => set({ ambientOcclusion: v }),
      setMarkerOcclusion: (v) => set({ markerOcclusion: v }),
      setLiftIcons: (v) => set({ liftIcons: v }),
      setFloorBase: (v) => set({ floorBase: v }),
    }),
    {
      name: 'sgv-graphics-settings',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        shadows: s.shadows,
        ambientOcclusion: s.ambientOcclusion,
        markerOcclusion: s.markerOcclusion,
        liftIcons: s.liftIcons,
        floorBase: s.floorBase,
      }),
    },
  ),
)
