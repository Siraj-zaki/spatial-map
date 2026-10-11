/**
 * Upper limits for typed values whose slider range is only the common
 * case (see `limitMax` on SliderRow / StretchSlider). The slider keeps
 * its comfortable drag range; these say how far a user may go past it.
 *
 * They are sanity bounds against typos (a 2000 m door), not design
 * rules: generous enough for hangars, high-bay racking and tall
 * buildings. Visual 0–1 / percentage / angle fields have no entry here —
 * their slider ends are real limits.
 */

/** Height above ground for shapes, labels and image planes (m). */
export const LIMIT_ELEVATION_M = 2000

/** Door opening width (m) — aircraft-hangar doors run past 100 m. */
export const LIMIT_DOOR_WIDTH_M = 200
/** Door height (m). */
export const LIMIT_DOOR_HEIGHT_M = 50
/** Door frame thickness / frame face width (m). */
export const LIMIT_DOOR_FRAME_M = 5
/** Door leaf thickness (m). */
export const LIMIT_DOOR_LEAF_M = 2

/** Stair steps per flight. */
export const LIMIT_STAIR_STEPS = 500
/** Rack / shelf levels. */
export const LIMIT_RACK_LEVELS = 50

/** Marker icon size (px) — map-marker-overlay renders up to this. */
export const LIMIT_MARKER_SIZE_PX = 96
/** Wall thickness for line walls (m). */
export const LIMIT_WALL_THICKNESS_M = 20
/** Text and label sizes (px). */
export const LIMIT_SYMBOL_SIZE_PX = 256
/** Line, route and border widths (px). */
export const LIMIT_STROKE_PX = 100
/** Text halo width / blur (px). */
export const LIMIT_HALO_PX = 20
