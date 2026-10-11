/**
 * Doors as triangle meshes — what the door tool draws instead of a stack
 * of extruded boxes.
 *
 * fill-extrusion can only raise a footprint straight up, so the old
 * panel mouldings, knob and hinges came out as bumps on the TOP edge of
 * the leaf. Here every part sits where it belongs:
 *   - frame: jambs + head, an architrave (casing) proud of both wall
 *     faces, and a threshold plate;
 *   - hinged leaves: a slab with raised, moulded panels on both faces,
 *     a lever handle on a rose on each face at lock height, and hinge
 *     knuckles on the hinge edge;
 *   - sliding: slab with a tall panel, flush pull bars and a top track;
 *   - revolving: centre post, four glass wings in metal frames, curved
 *     glass side walls, canopy and floor plate.
 *
 * Positions are (east, north, up) metres from `vertices[0]`; leaf
 * positions come from `buildLeaves`, so open angle, hinge side and swing
 * match the extruded click targets exactly. Drawn by the overlay with
 * the shared mesh layers (lift-mesh-layer.ts).
 */

import { MeshBuilder, type LocalMesh } from '../vertical-transport-generators'
import { buildLeaves, darkenHex, makeFrame, type LeafGeom } from './generators'
import type { DoorConfig } from './types'

// Hardware materials — stored as data like the defaults in types.ts,
// not UI theme colours.
const BRASS = '#b8860b'
const STEEL = '#a1a1aa'
const DARK_METAL = '#4b5563'

/** Gap between leaf and floor / head, metres. */
const FLOOR_GAP = 0.01
const HEAD_GAP = 0.005
/** Architrave width and how far it stands proud of the jamb faces. */
const CASING_W = 0.05
const CASING_PROUD = 0.014

export interface DoorMesh {
  solid: LocalMesh
  glass: LocalMesh
  parts: Record<string, number>
}

export function buildDoorMesh(vertices: [[number, number], [number, number]], cfg: DoorConfig): DoorMesh | null {
  const frame = makeFrame(vertices[0], vertices[1])
  if (!frame) return null
  const W = frame.width
  const E = Math.max(0, cfg.elevation)
  const H = Math.max(0.01, cfg.doorHeight)
  const solid = new MeshBuilder()
  const glass = new MeshBuilder()
  // Door local (x along the opening, y left of it, z) → east/north.
  const doorXf = (q: number[]) => [q[0] * frame.ux + q[1] * frame.px, q[0] * frame.uy + q[1] * frame.py, q[2]]
  const revolving = cfg.kind === 'revolving'
  const ft = Math.max(0.01, cfg.frameThickness) / 2
  const fw = Math.max(0.01, cfg.frameWidth)
  const frameC = cfg.frameColor
  const leafC = cfg.leafColor
  const zLock = E + Math.min(1.0, H * 0.48)

  // ---- Frame -------------------------------------------------------------
  solid.xf = doorXf
  if (cfg.showFrame) {
    const headTop = E + H + fw
    solid.color(frameC).mark('frame')
    solid.box(-fw, 0, -ft, ft, E, revolving ? E + H : headTop)
    solid.box(W, W + fw, -ft, ft, E, revolving ? E + H : headTop)
    if (!revolving) {
      solid.box(0, W, -ft, ft, E + H, headTop)
      // Architrave on both wall faces.
      solid.color(darkenHex(frameC, 0.05)).mark('casing')
      for (const [y0, y1] of [[ft, ft + CASING_PROUD], [-ft - CASING_PROUD, -ft]] as const) {
        solid.box(-fw - CASING_W, 0, y0, y1, E, headTop + CASING_W)
        solid.box(W, W + fw + CASING_W, y0, y1, E, headTop + CASING_W)
        solid.box(0, W, y0, y1, E + H, headTop + CASING_W)
      }
      // Threshold.
      solid.color(darkenHex(frameC, 0.3)).mark('threshold')
      solid.box(0, W, -ft, ft, E, E + 0.012)
    }
  }

  const leaves = buildLeaves(frame, cfg)

  if (revolving) {
    const R = W / 2
    const cx = W / 2
    solid.xf = doorXf
    glass.xf = doorXf
    // Centre post, floor plate and canopy drum.
    solid.color(DARK_METAL).mark('post').cylZ(cx, 0, 0.055, E, E + H, 16)
    solid.color(darkenHex(frameC, 0.2)).mark('floor-plate').cylZ(cx, 0, R + 0.04, E, E + 0.015, 40)
    solid.color(frameC).mark('canopy').cylZ(cx, 0, R + 0.07, E + H, E + H + 0.18, 40)
    // Curved glass side walls on the wall line (±x), metal edge posts.
    const wallR = R + 0.03
    for (const [from, to] of [[-50, 50], [130, 230]] as const) {
      const segs = 12
      glass.mark('drum')
      for (let i = 0; i < segs; i++) {
        const a0 = ((from + ((to - from) * i) / segs) * Math.PI) / 180
        const a1 = ((from + ((to - from) * (i + 1)) / segs) * Math.PI) / 180
        const p = (a: number, r: number, z: number) => [cx + Math.cos(a) * r, Math.sin(a) * r, z]
        const zl = E + 0.015
        const zh = E + H
        glass.glassFace()
        glass.quad(p(a0, wallR, zl), p(a1, wallR, zl), p(a1, wallR, zh), p(a0, wallR, zh))
        glass.quad(p(a0, wallR + 0.012, zl), p(a0, wallR + 0.012, zh), p(a1, wallR + 0.012, zh), p(a1, wallR + 0.012, zl))
        glass.glassEdge()
        glass.quad(p(a0, wallR, zh), p(a1, wallR, zh), p(a1, wallR + 0.012, zh), p(a0, wallR + 0.012, zh))
      }
      solid.color(DARK_METAL)
      for (const a of [from, to]) {
        const r = (a * Math.PI) / 180
        solid.cylZ(cx + Math.cos(r) * (wallR + 0.006), Math.sin(r) * (wallR + 0.006), 0.022, E, E + H, 8)
      }
    }
    // Wings: glass in a slim metal frame.
    for (const leaf of leaves) {
      const lx = leafXf(doorXf, leaf)
      solid.xf = lx
      glass.xf = lx
      const L = leaf.length
      solid.color(DARK_METAL).mark('wing')
      solid.box(L - 0.045, L - 0.01, -0.02, 0.02, E + 0.02, E + H - 0.01)
      solid.box(0.055, 0.085, -0.02, 0.02, E + 0.02, E + H - 0.01)
      solid.box(0.085, L - 0.045, -0.02, 0.02, E + 0.02, E + 0.12)
      solid.box(0.085, L - 0.045, -0.02, 0.02, E + H - 0.09, E + H - 0.01)
      glass.pane(0.085, L - 0.045, -0.006, 0.006, E + 0.12, E + H - 0.09)
    }
    solid.xf = null
    glass.xf = null
    return { solid: solid.mesh, glass: glass.mesh, parts: { ...solid.parts, ...glass.parts } }
  }

  for (const leaf of leaves) {
    const lx = leafXf(doorXf, leaf)
    solid.xf = lx
    const L = leaf.length
    const t = leaf.thick
    const z0 = E + FLOOR_GAP
    const z1 = E + H - HEAD_GAP
    const a0 = 0.003
    const a1 = L - 0.003
    solid.color(leafC).mark('leaf')
    solid.box(a0, a1, 0, t, z0, z1)

    if (leaf.hinged) {
      // Raised, moulded panels on both faces: two rows (split at the lock
      // rail), two columns on wide leaves.
      const stile = Math.min(0.14, Math.max(0.07, L * 0.14))
      const cols = L > 1.1 ? 2 : 1
      const colW = (L - 2 * stile - (cols - 1) * stile) / cols
      const rows: [number, number][] = [
        [z0 + 0.2, zLock - 0.09],
        [zLock + 0.09, z1 - 0.13],
      ]
      for (let c = 0; c < cols; c++) {
        const pa0 = stile + c * (colW + stile)
        const pa1 = pa0 + colW
        for (const [pz0, pz1] of rows) {
          if (pz1 - pz0 < 0.12 || colW < 0.08) continue
          raisedPanel(solid, leafC, pa0, pa1, pz0, pz1, t)
        }
      }
      // Lever handle on a rose, both faces, at the free end.
      const aH = L - 0.075
      for (const side of [1, -1] as const) {
        const face = side > 0 ? t : 0
        solid.color(BRASS).mark('handle')
        solid.cylS(aH, zLock, 0.027, face + side * 0.011, face, 18)
        solid.cylS(aH, zLock, 0.0095, face + side * 0.055, face + side * 0.011, 10)
        const bL = face + side * 0.055
        solid.pipe([aH, bL, zLock], [aH - 0.125, bL, zLock], 0.0095)
        solid.ball([aH - 0.125, bL, zLock], 0.011)
        solid.ball([aH, bL, zLock], 0.0105)
      }
      // Hinge knuckles on the hinge edge.
      solid.color(STEEL).mark('hinge')
      for (const zc of [z0 + 0.22, (z0 + z1) / 2, z1 - 0.25]) solid.cylZ(-0.002, t, 0.009, zc - 0.05, zc + 0.05, 10)
    } else {
      // Sliding: one tall moulded panel per face, flush pull bars.
      const stile = Math.min(0.14, Math.max(0.07, L * 0.12))
      raisedPanel(solid, leafC, stile, L - stile, z0 + 0.2, z1 - 0.15, t)
      const aPull = cfg.hingeSide === 'left' ? L - 0.07 : 0.07
      solid.color(STEEL).mark('handle')
      solid.box(aPull - 0.012, aPull + 0.012, t, t + 0.02, zLock - 0.22, zLock + 0.22)
      solid.box(aPull - 0.012, aPull + 0.012, -0.02, 0, zLock - 0.22, zLock + 0.22)
    }
  }

  if (cfg.kind === 'sliding' && leaves[0]) {
    // Top track over the opening and the pocket the leaf slides into.
    solid.xf = doorXf
    const leaf = leaves[0]
    const yA = 0
    const yB = leaf.thick * (leaf.py >= 0 ? 1 : -1)
    const x0 = Math.min(0, leaf.pivot[0])
    const x1 = Math.max(W, leaf.tip[0])
    solid.color(DARK_METAL).mark('track')
    solid.box(x0, x1, Math.min(yA, yB) - 0.02, Math.max(yA, yB) + 0.02, E + H, E + H + 0.07)
  }

  solid.xf = null
  glass.xf = null
  return { solid: solid.mesh, glass: glass.mesh, parts: { ...solid.parts, ...glass.parts } }
}

/** Leaf-local (a along the leaf, b across its thickness, z) → east/north. */
function leafXf(doorXf: (q: number[]) => number[], leaf: LeafGeom) {
  return (q: number[]) =>
    doorXf([leaf.pivot[0] + q[0] * leaf.ux + q[1] * leaf.px, leaf.pivot[1] + q[0] * leaf.uy + q[1] * leaf.py, q[2]])
}

/**
 * A raised panel on both faces of a leaf (b = 0 and b = t): a darker
 * moulding ring standing slightly proud, with the field raised further
 * inside it — reads as a real moulded panel door from any angle.
 */
function raisedPanel(m: MeshBuilder, leafC: string, a0: number, a1: number, z0: number, z1: number, t: number): void {
  const inset = Math.min(0.03, (a1 - a0) * 0.15, (z1 - z0) * 0.15)
  m.mark('panel')
  for (const side of [1, -1] as const) {
    const face = side > 0 ? t : 0
    const span = (d: number): [number, number] => (side > 0 ? [face, face + d] : [face - d, face])
    m.color(darkenHex(leafC, 0.13))
    const [r0, r1] = span(0.005)
    m.box(a0, a1, r0, r1, z0, z1)
    m.color(leafC)
    const [f0, f1] = span(0.009)
    m.box(a0 + inset, a1 - inset, f0, f1, z0 + inset, z1 - inset)
  }
}
