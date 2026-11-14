import { useSyncExternalStore } from 'react'
import type { DoorShape } from './door/types'
import type { Grid } from './db'
import type {
  CircleShape,
  LineShape,
  MarkerShape,
  ModelShape,
  PolygonShape,
  StairShape,
  TextLabelShape,
} from './shapes'

/**
 * A single undoable action. Each entry contains enough information to
 * reverse the action.
 *
 * The grid variants predate the multi-shape rewrite — kept as-is so the
 * existing grid undo/redo flow doesn't need to change. The new entries
 * (`delete-marker`, `delete-circle`, etc.) carry the deleted shape rows
 * verbatim so undo can re-add them with their original config.
 */
export type HistoryEntry =
  | { type: 'delete'; grids: Grid[] }
  | {
      type: 'redraw'
      gridId: number
      oldStart: [number, number]
      oldCurrent: [number, number]
      newStart: [number, number]
      newCurrent: [number, number]
      /** Path-layout grids: the config carries the path, so a redraw swaps it too. */
      oldConfig?: Grid['config']
      newConfig?: Grid['config']
    }
  | { type: 'recreate'; grids: Grid[] } // inverse of delete — for redo of a delete
  | { type: 'delete-marker'; markers: MarkerShape[] }
  | { type: 'delete-circle'; circles: CircleShape[] }
  | { type: 'delete-polygon'; polygons: PolygonShape[] }
  | { type: 'delete-line'; lines: LineShape[] }
  | { type: 'delete-model'; models: ModelShape[] }
  | { type: 'delete-text-label'; textLabels: TextLabelShape[] }
  | { type: 'delete-stair'; stairs: StairShape[] }
  | { type: 'delete-door'; doors: DoorShape[] }
  | {
      type: 'polygon-transform'
      polygonId: number
      prevVertices?: [number, number][]
      newVertices?: [number, number][]
      prevRotation?: number
      newRotation?: number
    }

const MAX_HISTORY = 50

/**
 * Tiny in-memory undo/redo stack for grid mutations. We intentionally keep
 * this in-memory only — IndexedDB history would be overkill for a UX-level
 * undo stack that resets on page reload.
 */
export class GridHistory {
  private undoStack: HistoryEntry[] = []
  private redoStack: HistoryEntry[] = []
  private listeners = new Set<() => void>()
  private version = 0

  /** For useSyncExternalStore — the Undo / Redo buttons re-render on change. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getVersion = (): number => this.version

  private changed(): void {
    this.version++
    this.listeners.forEach((l) => l())
  }

  canUndo(): boolean {
    return this.undoStack.length > 0
  }

  canRedo(): boolean {
    return this.redoStack.length > 0
  }

  /**
   * Record an action that can be undone. Clears the redo stack (standard
   * undo/redo semantics: once you branch, you can't redo into the new branch).
   */
  push(entry: HistoryEntry): void {
    this.undoStack.push(entry)
    if (this.undoStack.length > MAX_HISTORY) {
      this.undoStack.shift()
    }
    this.redoStack = []
    this.changed()
  }

  popUndo(): HistoryEntry | null {
    const entry = this.undoStack.pop() ?? null
    if (entry) this.redoStack.push(entry)
    this.changed()
    return entry
  }

  popRedo(): HistoryEntry | null {
    const entry = this.redoStack.pop() ?? null
    if (entry) this.undoStack.push(entry)
    this.changed()
    return entry
  }

  peekUndo(): HistoryEntry | null {
    return this.undoStack[this.undoStack.length - 1] ?? null
  }

  clear(): void {
    this.undoStack = []
    this.redoStack = []
    this.changed()
  }
}

export const gridHistory = new GridHistory()

/** Live can-undo / can-redo for the editor's Undo / Redo buttons. */
export function useHistoryAvailability(): { canUndo: boolean; canRedo: boolean } {
  useSyncExternalStore(gridHistory.subscribe, gridHistory.getVersion, gridHistory.getVersion)
  return { canUndo: gridHistory.canUndo(), canRedo: gridHistory.canRedo() }
}
