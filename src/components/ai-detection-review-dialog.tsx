/**
 * AI Detection Review Dialog — Phase 3.2.
 *
 * Replaces the Phase 2.3 debug dialog. Renders each pending detection
 * as a row with a kind chip, label, confidence bar, and Accept/Reject
 * buttons. Bulk "Accept all ≥ X%" collapses many decisions into one
 * click when the model's confidence stratifies cleanly.
 *
 * Errors from Accept (unusable geometry, network) surface inline
 * per-row so users see WHY a detection didn't materialize instead of
 * having it silently vanish.
 */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { SliderRow } from '@/components/ui/slider-row'
import type { AIDetection, AIJob } from '@/lib/ai-client'
import { AI_KIND_COLORS } from '@/lib/ai-detection-generator'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  job: AIJob | null
  isStarting: boolean
  error: string | null
  pendingDetections: AIDetection[]
  acceptedIds: ReadonlySet<string>
  rejectedIds: ReadonlySet<string>
  perDetectionErrors: ReadonlyMap<string, string>
  selectedDetectionId: string | null
  onSelectDetection: (id: string | null) => void
  onAccept: (det: AIDetection) => void
  onReject: (det: AIDetection) => void
  /** Called with each pending detection above the threshold. Parent
   *  runs them through onAccept one at a time so per-detection errors
   *  land in the same place as manual accepts. */
  onAcceptAllAboveThreshold: (thresholdPct: number) => void
  /** Cancel the in-flight job. Only wired when the job is in a
   *  cancelable state (pending / running); the button hides otherwise. */
  onCancel?: () => void
}

/** Kind → i18n key + short chip label. Chip label is kept in the
 *  component instead of shipped through i18n so beta iteration
 *  doesn't require six locale round-trips per prompt tweak. */
const KIND_META: Record<AIDetection['kind'], { label: string }> = {
  aisle: { label: 'Aisle' },
  area: { label: 'Area' },
  door: { label: 'Door' },
  stair: { label: 'Stair' },
}

export function AIDetectionReviewDialog(props: Props) {
  const {
    open,
    onOpenChange,
    job,
    isStarting,
    error,
    pendingDetections,
    acceptedIds,
    rejectedIds,
    perDetectionErrors,
    selectedDetectionId,
    onSelectDetection,
    onAccept,
    onReject,
    onAcceptAllAboveThreshold,
    onCancel,
  } = props
  const { t } = useTranslation()
  const isCancelable = job?.status === 'pending' || job?.status === 'running'

  // Bulk-accept threshold — starts at 80% (a common "very confident"
  // watermark) and drops on user drag. Slider only shows once there's
  // at least one pending detection to keep the header uncluttered.
  const [threshold, setThreshold] = useState(80)

  const totalDetections = job?.detections?.length ?? 0
  const decidedCount = acceptedIds.size + rejectedIds.size
  const abovePending = useMemo(
    () => pendingDetections.filter((d) => Math.round(d.confidence * 100) >= threshold),
    [pendingDetections, threshold],
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('ai.reviewTitle')}</DialogTitle>
          <DialogDescription>{t('ai.reviewSubtitle')}</DialogDescription>
        </DialogHeader>

        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {isStarting && !job && (
          <div className="text-sm text-muted-foreground">{t('ai.startingJob')}</div>
        )}

        {job && (
          <div className="space-y-3 text-sm">
            {/* Status line — one row so it doesn't hog space above the
                detection list. Job details (model, tokens, duration)
                are debug-tier info; expose via a small "details" popover
                later if operators need it during triage. */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>{t('ai.status')}: <span className="font-mono">{job.status}</span></span>
              <span>{t('ai.detectionsCount')}: <span className="font-mono">{totalDetections}</span></span>
              <span>{t('ai.acceptedCount')}: <span className="font-mono">{acceptedIds.size}</span></span>
              <span>{t('ai.rejectedCount')}: <span className="font-mono">{rejectedIds.size}</span></span>
              {job.durationMs > 0 && (
                <span>{t('ai.durationMs')}: <span className="font-mono">{job.durationMs}</span></span>
              )}
              {isCancelable && onCancel && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={onCancel}
                  className="ml-auto h-6 px-2 text-xs"
                >
                  {t('ai.cancel', { defaultValue: 'Cancel' })}
                </Button>
              )}
            </div>

            {job.error && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive whitespace-pre-wrap">
                {job.error}
              </div>
            )}

            {/* Bulk accept row. Hidden when the pending set is empty so
                a done-reviewing dialog doesn't dangle a call-to-action. */}
            {pendingDetections.length > 0 && (
              <div className="flex items-center gap-3 rounded-md border bg-muted/40 p-2">
                <div className="flex-1">
                  <SliderRow
                    label={t('ai.acceptAllAbove', { defaultValue: 'Accept all at or above' })}
                    value={threshold}
                    onChange={setThreshold}
                    min={0}
                    max={100}
                    step={5}
                    suffix="%"
                  />
                </div>
                <Button
                  size="sm"
                  disabled={abovePending.length === 0}
                  onClick={() => onAcceptAllAboveThreshold(threshold)}
                >
                  {t('ai.acceptN', { count: abovePending.length, defaultValue: `Accept ${abovePending.length}` })}
                </Button>
              </div>
            )}

            {/* Detection list — sort by confidence descending so the
                strongest evidence is at the top. Rejected ones are
                filtered out at the parent level (pendingDetections). */}
            {pendingDetections.length === 0 && totalDetections > 0 && (
              <div className="rounded-md border bg-muted/30 p-3 text-center text-xs text-muted-foreground">
                {t('ai.allReviewed', { defaultValue: 'All detections reviewed.' })} {decidedCount > 0 && `(${acceptedIds.size} accepted, ${rejectedIds.size} rejected)`}
              </div>
            )}

            {pendingDetections.length === 0 && totalDetections === 0 && job.status === 'done' && (
              <div className="rounded-md border bg-muted/30 p-3 text-center text-xs text-muted-foreground">
                {t('ai.noDetections', { defaultValue: 'No detections found in this image.' })}
              </div>
            )}

            <ul className="max-h-96 space-y-1 overflow-auto pr-1">
              {[...pendingDetections]
                .sort((a, b) => b.confidence - a.confidence)
                .map((d) => (
                  <DetectionRow
                    key={d.id}
                    detection={d}
                    selected={d.id === selectedDetectionId}
                    onSelect={() => onSelectDetection(d.id === selectedDetectionId ? null : d.id)}
                    onAccept={() => onAccept(d)}
                    onReject={() => onReject(d)}
                    error={perDetectionErrors.get(d.id) ?? null}
                  />
                ))}
            </ul>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

interface DetectionRowProps {
  detection: AIDetection
  selected: boolean
  onSelect: () => void
  onAccept: () => void
  onReject: () => void
  error: string | null
}

function DetectionRow({ detection, selected, onSelect, onAccept, onReject, error }: DetectionRowProps) {
  const { t } = useTranslation()
  const meta = KIND_META[detection.kind]
  const kindColor = AI_KIND_COLORS[detection.kind]
  const pct = Math.round(detection.confidence * 100)
  return (
    <li
      className={
        'flex flex-col gap-1 rounded-md border p-2 transition-colors ' +
        (selected ? 'border-primary bg-primary/5' : 'border-transparent hover:border-border hover:bg-muted/40')
      }
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onSelect}
          className="inline-flex min-w-[56px] items-center justify-center rounded-sm px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white"
          style={{ backgroundColor: kindColor }}
        >
          {meta.label}
        </button>
        <button
          type="button"
          onClick={onSelect}
          className="flex-1 text-left text-sm hover:underline"
        >
          {detection.label || t('ai.unlabeled', { defaultValue: '(unlabeled)' })}
        </button>
        {/* Confidence bar — 6-column grid with a fixed width so a long
            label doesn't push the bar off-screen. */}
        <div className="flex w-24 items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full"
              style={{ width: `${pct}%`, backgroundColor: kindColor }}
            />
          </div>
          <span className="w-8 text-right text-xs text-muted-foreground">{pct}%</span>
        </div>
        <Button size="sm" variant="ghost" onClick={onReject} className="h-7 px-2 text-xs">
          {t('ai.reject', { defaultValue: 'Reject' })}
        </Button>
        <Button size="sm" onClick={onAccept} className="h-7 px-2 text-xs">
          {t('ai.accept', { defaultValue: 'Accept' })}
        </Button>
      </div>
      {error && (
        <div className="ml-[64px] text-xs text-destructive">{error}</div>
      )}
    </li>
  )
}
