/**
 * Client for the AI floor plan detection endpoints.
 *
 * Wire protocol mirrors backend/internal/handlers/ai_floorplan.go, which
 * is a thin dispatcher over the Python ai-worker service
 * (backend/ai-worker/) — SAM 2 + Tesseract + OpenCV + Shapely produce
 * the detections and reproject them to Mapbox lng/lat before returning,
 * so what arrives here is ready to hand to the spatial store.
 *
 * Progress is delivered out-of-band via SSE (entity="ai-jobs"); this
 * client only knows how to kick a job, read a job, feedback a job, and
 * cancel a job. The subscription itself is registered by the hook that
 * owns the review flow.
 */

import { apiGet, apiPost } from './api-client'

/** v1 kinds — matches ai.DetectionKind on the backend. */
export type AIDetectionKind = 'aisle' | 'area' | 'door' | 'stair'

export type AIGeometryType = 'polygon' | 'rect' | 'line' | 'point'

/**
 * One detection AFTER the backend has transformed its normalized image
 * UV coords into Mapbox lng/lat. `coords` is always `[lng, lat]` pairs,
 * regardless of the geometry type.
 */
export interface AIDetection {
  id: string
  kind: AIDetectionKind
  geometry: {
    type: AIGeometryType
    coords: [number, number][]
  }
  label?: string
  confidence: number
}

/** Optional region-select bbox — normalized [0,1] on the SOURCE image. */
export interface AIRegionBBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** ai_jobs row projection returned by GET /jobs/{id}. */
export interface AIJob {
  id: number
  imageId: number
  status: 'pending' | 'running' | 'done' | 'failed' | 'canceled'
  model: string
  promptVersion: string
  region?: AIRegionBBox | null
  /**
   * Populated when status === 'done'. Never trust length as a proxy
   * for "detection succeeded" — a done job with zero detections is
   * valid ("model saw nothing"); an errored job carries `error`.
   */
  detections?: AIDetection[]
  acceptedIds?: string[]
  rejectedIds?: string[]
  error?: string
  tokensUsed: number
  durationMs: number
  createdAt: string
  updatedAt: string
}

interface StartResponse {
  jobId: number
}

/** Kick off a detection. Rejects with ApiError on 4xx/5xx.
 *  Common ones:
 *   - 503: SGV_AI_WORKER.URL empty (feature off) or ai-worker unreachable
 *   - 403: tenant hasn't opted in (app_settings flag)
 *   - 429: monthly cap or hourly burst reached
 *   - 404: image not owned by the current tenant */
export function startDetection(imageId: number, region?: AIRegionBBox): Promise<StartResponse> {
  const body = region ? { region } : {}
  return apiPost<StartResponse>(`/floorplans/${imageId}/detect`, body)
}

/** Read the current job state. Called on SSE tick + also on initial
 *  attach (SSE could drop the first event under slow-client backpressure;
 *  the initial GET fills the gap). */
export function getAIJob(jobId: number): Promise<AIJob> {
  return apiGet<AIJob>(`/floorplans/jobs/${jobId}`)
}

/** Cancel a pending/running job. No-op when already terminal. */
export function cancelAIJob(jobId: number): Promise<{ canceled: boolean }> {
  return apiPost<{ canceled: boolean }>(`/floorplans/jobs/${jobId}/cancel`, {})
}

/** Record which detections the user accepted / rejected. Backend uses
 *  these for accuracy telemetry only — the accepted ones have already
 *  been turned into real spatial shapes via createLocal on the frontend. */
export function submitAIJobFeedback(
  jobId: number,
  acceptedIds: string[],
  rejectedIds: string[],
): Promise<{ recorded: boolean }> {
  return apiPost<{ recorded: boolean }>(`/floorplans/jobs/${jobId}/feedback`, {
    acceptedIds,
    rejectedIds,
  })
}
