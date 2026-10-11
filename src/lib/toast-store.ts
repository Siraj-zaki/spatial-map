/**
 * App-wide toasts: short, non-blocking confirmation of an action ("Link
 * copied", "Facility deleted" + Undo). Rendered once by <Toaster /> in the
 * app shell. Errors that need attention stay inline next to their cause —
 * toasts are for outcomes, not problems the user must fix.
 */

import { create } from 'zustand'

export type ToastTone = 'success' | 'info' | 'error'

export interface Toast {
  id: number
  tone: ToastTone
  title: string
  description?: string
  /** Optional single action, e.g. Undo. Clicking it dismisses the toast. */
  action?: { label: string; onClick: () => void }
  /** ms before auto-dismiss; toasts with an action get longer by default. */
  duration: number
}

interface ToastState {
  toasts: Toast[]
  push: (t: Omit<Toast, 'id' | 'duration'> & { duration?: number }) => number
  dismiss: (id: number) => void
}

let nextId = 1
const MAX_VISIBLE = 3

export const useToastStore = create<ToastState>()((set) => ({
  toasts: [],
  push: (t) => {
    const id = nextId++
    const duration = t.duration ?? (t.action ? 8000 : 4000)
    set((s) => ({ toasts: [...s.toasts, { ...t, id, duration }].slice(-MAX_VISIBLE) }))
    return id
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}))

/** Imperative helper usable from event handlers and non-React code. */
export const toast = {
  success: (title: string, opts?: Partial<Omit<Toast, 'id' | 'tone' | 'title'>>) =>
    useToastStore.getState().push({ tone: 'success', title, ...opts }),
  info: (title: string, opts?: Partial<Omit<Toast, 'id' | 'tone' | 'title'>>) =>
    useToastStore.getState().push({ tone: 'info', title, ...opts }),
  error: (title: string, opts?: Partial<Omit<Toast, 'id' | 'tone' | 'title'>>) =>
    useToastStore.getState().push({ tone: 'error', title, ...opts }),
  dismiss: (id: number) => useToastStore.getState().dismiss(id),
}
