import { useMemo } from 'react'

import type { TFunction } from 'i18next'

import type { MeasureHud, MeasureItem } from '@/components/map-measure-overlay'
import { type Tool } from '@/lib/keyboard-shortcuts'
import {
  combinedFactor,
  imageUVToLngLat,
  lngLatToImageUV,
  sampleErrorAfter,
  sampleMeasured,
  sampleOutline,
  type CalibrationSample,
  type ImageFrame,
} from '@/lib/measure/calibration'
import {
  distanceM,
  pathLengthM,
  planRelativeAngle,
  polygonAreaM2,
  type LngLat,
} from '@/lib/measure/geometry'
import {
  areaUnitFor,
  formatMeasureArea,
  formatMeasureLength,
  parseLengthInput,
} from '@/lib/measure/units'
import type { CalibrationSession, Guide, MeasureSettings } from '../state/useMeasureEditorState'

/** Per-segment labels for a chain (closing segment last when `closed`). */
function segmentLabels(vertices: ReadonlyArray<LngLat>, closed: boolean, fmt: (m: number) => string): string[] {
  const out: string[] = []
  for (let i = 1; i < vertices.length; i++) out.push(fmt(distanceM(vertices[i - 1], vertices[i])))
  if (closed && vertices.length > 2) out.push(fmt(distanceM(vertices[vertices.length - 1], vertices[0])))
  return out
}

function formatPct(err: number): string {
  const pct = err * 100
  const sign = pct > 0.05 ? '+' : pct < -0.05 ? '−' : '±'
  return `${sign}${Math.abs(pct).toFixed(1)}%`
}

/**
 * Builds what `MapMeasureOverlay` paints: labelled items for the wall /
 * polygon / Measure drafts, kept guides and calibration marks, plus the
 * cursor readout. Pure derivation — all strings are formatted and
 * translated here so the overlay stays generic.
 */
export function useMeasureScene({
  t,
  activeTool,
  settings,
  angleBaseDeg,
  angleLocked,
  lineDraftVertices,
  lineDraftCursor,
  lineSnapped,
  lineElevation,
  polygonDraftVertices,
  polygonDraftCursor,
  polygonElevation,
  measureDraftVertices,
  measureDraftCursor,
  measureSnapped,
  floorElevation,
  guides,
  guidesVisible,
  typedLength,
  calibration,
  calibrationFrame,
  calibrationElevation,
  calibrationSamples,
  calibrationCursor,
}: {
  t: TFunction
  activeTool: Tool
  settings: MeasureSettings
  angleBaseDeg: number
  /** Angle lock in force right now (setting XOR Shift). */
  angleLocked: boolean
  lineDraftVertices: LngLat[]
  lineDraftCursor: LngLat | null
  lineSnapped: boolean
  lineElevation: number
  polygonDraftVertices: LngLat[]
  polygonDraftCursor: LngLat | null
  polygonElevation: number
  measureDraftVertices: LngLat[]
  measureDraftCursor: LngLat | null
  measureSnapped: boolean
  floorElevation: number
  guides: Guide[]
  guidesVisible: boolean
  typedLength: string
  calibration: CalibrationSession | null
  calibrationFrame: ImageFrame | null
  calibrationElevation: number
  calibrationSamples: CalibrationSample[]
  calibrationCursor: LngLat | null
}): { items: MeasureItem[]; hud: MeasureHud | null } {
  return useMemo(() => {
    const unit = settings.unit
    const areaUnit = areaUnitFor(unit)
    const fmtLen = (m: number) => formatMeasureLength(m, unit)
    const fmtArea = (a: number) => formatMeasureArea(a, areaUnit)
    const labels = settings.showLabels
    const items: MeasureItem[] = []
    let hud: MeasureHud | null = null

    // ---- Guides ----------------------------------------------------------
    if (guidesVisible) {
      for (const g of guides) {
        const total = pathLengthM(g.vertices, g.closed)
        let centerLabel: string | undefined
        let centerAt: LngLat | undefined
        if (g.closed) {
          centerLabel = labels ? fmtArea(polygonAreaM2(g.vertices)) : undefined
        } else if (g.vertices.length > 2 && labels) {
          centerLabel = `Σ ${fmtLen(total)}`
          centerAt = g.vertices[g.vertices.length - 1]
        }
        items.push({
          id: `guide:${g.id}`,
          vertices: g.vertices,
          closed: g.closed,
          elevation: g.elevation,
          tone: 'guide',
          segmentLabels: labels ? segmentLabels(g.vertices, g.closed, fmtLen) : undefined,
          centerLabel,
          centerAt,
        })
      }
    }

    // ---- Vertex-tool drafts + cursor readout -----------------------------
    const draft =
      activeTool === 'create-line'
        ? { verts: lineDraftVertices, cursor: lineDraftCursor, z: lineElevation, snapped: lineSnapped, polygon: false, labelsOnly: true }
        : activeTool === 'create-polygon'
          ? { verts: polygonDraftVertices, cursor: polygonDraftCursor, z: polygonElevation, snapped: false, polygon: true, labelsOnly: true }
          : activeTool === 'measure'
            ? { verts: measureDraftVertices, cursor: measureDraftCursor, z: floorElevation, snapped: measureSnapped, polygon: false, labelsOnly: false }
            : null
    if (draft && draft.verts.length > 0) {
      const chain = draft.cursor ? [...draft.verts, draft.cursor] : draft.verts
      const closed = draft.polygon && chain.length >= 3
      items.push({
        id: 'draft',
        vertices: chain,
        closed,
        elevation: draft.z,
        tone: 'draft',
        labelsOnly: draft.labelsOnly,
        segmentLabels: labels ? segmentLabels(chain, closed, fmtLen) : undefined,
        centerLabel: labels && closed ? fmtArea(polygonAreaM2(chain)) : undefined,
      })
      if (draft.cursor) {
        const last = draft.verts[draft.verts.length - 1]
        const rows: MeasureHud['rows'] = [
          { label: t('measure.hud.segment'), value: fmtLen(distanceM(last, draft.cursor)) },
          { label: t('measure.hud.total'), value: fmtLen(pathLengthM(chain)) },
          { label: t('measure.hud.angle'), value: `${planRelativeAngle(last, draft.cursor, angleBaseDeg).toFixed(1)}°` },
        ]
        if (chain.length >= 3 && (draft.polygon || activeTool === 'measure')) {
          rows.push({ label: t('measure.hud.area'), value: fmtArea(polygonAreaM2(chain)) })
        }
        const typedBad = typedLength !== '' && parseLengthInput(typedLength, unit) === null
        hud = {
          cursor: draft.cursor,
          rows,
          typed: typedLength,
          emphasis: draft.snapped || angleLocked,
          footer: typedBad
            ? t('measure.hud.typedInvalid')
            : typedLength
              ? t('measure.hud.typedEnter')
              : draft.snapped
                ? t('measure.hud.snapped')
                : angleLocked
                  ? t('measure.hud.locked', { step: settings.angleStep })
                  : undefined,
        }
      }
    } else if (draft && draft.cursor && activeTool === 'measure') {
      hud = { cursor: draft.cursor, rows: [], footer: t('measure.hud.startMeasure') }
    }

    // ---- Calibration marks -----------------------------------------------
    if (activeTool === 'calibrate-image' && calibration && calibrationFrame) {
      const f = calibrationFrame
      const factor = combinedFactor(f, calibrationSamples)
      const fmtVal = (kind: 'length' | 'area', v: number) => (kind === 'area' ? fmtArea(v) : fmtLen(v))
      for (const s of calibrationSamples) {
        const err = factor === null ? null : sampleErrorAfter(f, s, factor)
        items.push({
          id: `cal:${s.id}`,
          vertices: sampleOutline(f, s),
          closed: s.kind === 'area',
          elevation: calibrationElevation,
          tone: s.enabled ? 'calibration' : 'calibration-off',
          centerLabel: `${fmtVal(s.kind, s.real)}${s.enabled && err !== null ? ` · ${formatPct(err)}` : ''}`,
        })
      }
      if (calibration.pending) {
        const p = calibration.pending
        items.push({
          id: 'cal:pending',
          vertices: sampleOutline(f, p),
          closed: p.kind === 'area',
          elevation: calibrationElevation,
          tone: 'pending',
          centerLabel: fmtVal(p.kind, sampleMeasured(f, p)),
        })
      }
      if (calibration.firstPick && calibrationCursor) {
        const kind = calibration.mode === 'area' ? 'area' : 'length'
        const mark = { kind, a: calibration.firstPick, b: lngLatToImageUV(f, calibrationCursor) } as const
        const measured = sampleMeasured(f, mark)
        items.push({
          id: 'cal:live',
          vertices: sampleOutline(f, mark),
          closed: kind === 'area',
          elevation: calibrationElevation,
          tone: 'pending',
          centerLabel: fmtVal(kind, measured),
        })
        const rows: MeasureHud['rows'] = [{ label: t('measure.hud.onImage'), value: fmtVal(kind, measured) }]
        if (calibration.mode === 'straighten') {
          const a = imageUVToLngLat(f, calibration.firstPick)
          rows.push({ label: t('measure.hud.angle'), value: `${planRelativeAngle(a, calibrationCursor, 0).toFixed(1)}°` })
        }
        hud = { cursor: calibrationCursor, rows, emphasis: angleLocked && kind === 'length' }
      }
    }

    return { items, hud }
  }, [
    t,
    activeTool,
    settings,
    angleBaseDeg,
    angleLocked,
    lineDraftVertices,
    lineDraftCursor,
    lineSnapped,
    lineElevation,
    polygonDraftVertices,
    polygonDraftCursor,
    polygonElevation,
    measureDraftVertices,
    measureDraftCursor,
    measureSnapped,
    floorElevation,
    guides,
    guidesVisible,
    typedLength,
    calibration,
    calibrationFrame,
    calibrationElevation,
    calibrationSamples,
    calibrationCursor,
  ])
}
