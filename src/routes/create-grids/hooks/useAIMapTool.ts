/**
 * useAIMapTool — owns the state + wire for the AI Map tool.
 *
 * One live job at a time. When the user clicks a placed floor plan
 * while `ai-map` is the active tool, `startForImage(id)` fires a
 * POST /floorplans/{id}/detect, opens the review dialog, subscribes
 * to SSE `entity="ai-jobs"` for that job id, and re-fetches the row
 * on every event.
 *
 * The hook also tracks per-detection accept/reject decisions locally
 * so the review dialog + overlay can render just the *pending* subset.
 * The actual apiDb.X.add() call lives in the parent (needs zoneId /
 * floorPlanId / unit context) — this hook only tracks decisions and
 * ships the final accepted/rejected id lists to the feedback endpoint
 * when the dialog closes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  cancelAIJob,
  getAIJob,
  startDetection,
  submitAIJobFeedback,
  type AIDetection,
  type AIJob,
  type AIRegionBBox,
} from '@/lib/ai-client'
import { subscribeExternalSSE } from '@/lib/useSSE'

export interface UseAIMapToolResult {
  currentJob: AIJob | null
  isStarting: boolean
  error: string | null
  dialogOpen: boolean
  /** Detection ids the user accepted this session. Cleared on close. */
  acceptedIds: ReadonlySet<string>
  /** Detection ids the user rejected this session. Cleared on close. */
  rejectedIds: ReadonlySet<string>
  /** Server-returned detections minus accepted / rejected. Stable ref
   *  as long as the underlying arrays don't change. Empty when no job. */
  pendingDetections: AIDetection[]
  /** Kick a detection. Optional `region` runs region-select mode:
   *  the backend crops the image to the given normalized UV bbox
   *  before sending to Ollama, yielding higher recall than whole-image
   *  detection. Omit `region` for whole-image mode. */
  startForImage: (imageId: number, region?: AIRegionBBox) => Promise<void>
  closeDialog: () => void
  markAccepted: (id: string) => void
  markRejected: (id: string) => void
  /** Cancel the currently-live job on the server. Optimistically flips
   *  status to 'canceled' so the dialog updates instantly; the real
   *  SSE event will confirm shortly after. No-op when no job is live. */
  cancelCurrent: () => void
  /** Per-detection failure (from acceptDetection) surfaced back to the
   *  dialog so the user sees why an accept didn't materialize. Key is
   *  detection id. */
  perDetectionErrors: ReadonlyMap<string, string>
  setPerDetectionError: (id: string, message: string) => void
}

export function useAIMapTool(): UseAIMapToolResult {
  const [currentJob, setCurrentJob] = useState<AIJob | null>(null)
  const [isStarting, setIsStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [acceptedIds, setAcceptedIds] = useState<Set<string>>(() => new Set())
  const [rejectedIds, setRejectedIds] = useState<Set<string>>(() => new Set())
  const [perDetectionErrors, setPerDetectionErrors] = useState<Map<string, string>>(
    () => new Map(),
  )
  // ref so the SSE callback (bound once) can read the current live id.
  const jobIdRef = useRef<number | null>(null)

  useEffect(() => {
    return subscribeExternalSSE((kind, ev) => {
      if (kind !== 'ai-jobs') return
      const id = jobIdRef.current
      if (id === null) return
      if (String(ev.id) !== String(id)) return
      getAIJob(id).then(setCurrentJob).catch((e) => {
        // Refetch failure is non-fatal — the poll below will catch it
        // on the next tick.
        console.warn('ai-map: refetch after SSE failed', e)
      })
    })
  }, [])

  // Poll fallback while the job is in a non-terminal state. SSE is the
  // primary update channel, but two failure modes need coverage:
  //   (a) any backend restart mid-job closes the EventSource; the
  //       browser reconnects after 3s but any events fired during that
  //       gap are lost — a job that transitions pending → running →
  //       failed inside <100ms (the ubiquitous "api key not configured"
  //       scenario) writes all three DB updates and their SSE events
  //       before the frontend even sees the first one.
  //   (b) the job could finish faster than the initial GET returns,
  //       making the SSE the only signal, which arrives before the
  //       subscriber attaches. Poll bridges the race.
  // 3s tick — fast enough to feel live, cheap enough not to hammer the
  // backend for the 10-40s a real job takes. Stops on terminal state.
  useEffect(() => {
    if (!currentJob) return
    const status = currentJob.status
    if (status !== 'pending' && status !== 'running') return
    const id = jobIdRef.current
    if (id === null) return
    const timer = window.setInterval(() => {
      getAIJob(id).then(setCurrentJob).catch((e) => {
        console.warn('ai-map: poll failed', e)
      })
    }, 3000)
    return () => window.clearInterval(timer)
  }, [currentJob])

  const startForImage = useCallback(async (imageId: number, region?: AIRegionBBox) => {
    setError(null)
    setIsStarting(true)
    setDialogOpen(true)
    setCurrentJob(null)
    setAcceptedIds(new Set())
    setRejectedIds(new Set())
    setPerDetectionErrors(new Map())
    try {
      const { jobId } = await startDetection(imageId, region)
      jobIdRef.current = jobId
      const job = await getAIJob(jobId)
      setCurrentJob(job)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setIsStarting(false)
    }
  }, [])

  const closeDialog = useCallback(() => {
    // Fire-and-forget feedback POST — the backend uses it for accuracy
    // telemetry only, so a lost call is acceptable (no user-visible
    // consequence). Wrapping in Promise.resolve so a synchronous throw
    // in submitAIJobFeedback doesn't blow up the close path.
    const id = jobIdRef.current
    if (id !== null && (acceptedIds.size > 0 || rejectedIds.size > 0)) {
      void submitAIJobFeedback(id, Array.from(acceptedIds), Array.from(rejectedIds))
        .catch((e) => console.warn('ai-map: feedback POST failed', e))
    }
    setDialogOpen(false)
    jobIdRef.current = null
  }, [acceptedIds, rejectedIds])

  const markAccepted = useCallback((id: string) => {
    setAcceptedIds((prev) => {
      if (prev.has(id)) return prev
      const next = new Set(prev)
      next.add(id)
      return next
    })
    // Clear any prior error for this id — a retry accepted successfully.
    setPerDetectionErrors((prev) => {
      if (!prev.has(id)) return prev
      const next = new Map(prev)
      next.delete(id)
      return next
    })
  }, [])

  const markRejected = useCallback((id: string) => {
    setRejectedIds((prev) => {
      if (prev.has(id)) return prev
      const next = new Set(prev)
      next.add(id)
      return next
    })
  }, [])

  const cancelCurrent = useCallback(() => {
    const id = jobIdRef.current
    if (id === null) return
    // Optimistic: reflect the cancel in the UI before the round-trip
    // completes. The backend flip + SSE will overwrite this shortly.
    setCurrentJob((prev) => (prev && (prev.status === 'pending' || prev.status === 'running')
      ? { ...prev, status: 'canceled' } : prev))
    void cancelAIJob(id).catch((e) => console.warn('ai-map: cancel failed', e))
  }, [])

  const setPerDetectionError = useCallback((id: string, message: string) => {
    setPerDetectionErrors((prev) => {
      const next = new Map(prev)
      next.set(id, message)
      return next
    })
  }, [])

  const pendingDetections = useMemo(() => {
    if (!currentJob?.detections) return [] as AIDetection[]
    return currentJob.detections.filter(
      (d) => !acceptedIds.has(d.id) && !rejectedIds.has(d.id),
    )
  }, [currentJob, acceptedIds, rejectedIds])

  return {
    currentJob,
    isStarting,
    error,
    dialogOpen,
    acceptedIds,
    rejectedIds,
    pendingDetections,
    startForImage,
    closeDialog,
    markAccepted,
    markRejected,
    cancelCurrent,
    perDetectionErrors,
    setPerDetectionError,
  }
}
