/**
 * CSV import wizard. Four steps:
 *   1. File       — drag/drop or pick a CSV; parse on the main thread.
 *   2. Match      — pick the match strategy + the relevant columns.
 *   3. Mapping    — per-column FieldTarget. Pre-filled by suggestion heuristic.
 *   4. Preview    — review tallies + sample rows; commit or back.
 *
 * Hosts no domain state itself — the parent toggles `open` and gets a
 * callback when the commit succeeds (so it can refresh derived caches /
 * show a toast).
 */

import { Button } from '@/components/ui/button'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { apiDb } from '@/lib/api-db'
import { getDisplayUnit, type DataSource, type WebhookSourceConfig } from '@/lib/db'
import { useApiQuery } from '@/lib/useApiQuery'
import { useCurrentTenantId } from '@/lib/data-link/tenant-service'
import {
  commitImport,
  commitShapeImport,
  createBinSource,
  deleteBinSource,
  detectFileKind,
  drainWebhookSource,
  fetchRestSource,
  parseFile,
  parseGeoJsonFile,
  previewImport,
  previewShapeImport,
  suggestFieldTarget,
  updateSourceMapping,
  UnsupportedFormatError,
  WebhookFetchError,
  type FieldTarget,
  type FileKind,
  type ImportPlan,
  type ImportSummary,
  type MatchStrategy,
  type ParsedFile,
  type ParsedGeoJson,
  type PreviewResult,
  type RestSourceConfig,
  type ShapeImportPreview,
  type ShapeImportSummary,
} from '@/lib/data-link'
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Cloud,
  Database,
  FileText,
  Loader2,
  Plus,
  RefreshCw,
  Upload,
  X,
  XCircle,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Link, useSearchParams } from 'react-router-dom'

type Step =
  | 'file'
  | 'geojson-mode'
  | 'match'
  | 'map'
  | 'preview'
  | 'shapes-preview'
  | 'done'

/** Default stepper for the row-based flow (CSV / XLSX / JSON / GeoJSON-as-data). */
const STEP_ORDER_ROWS: Step[] = ['file', 'match', 'map', 'preview']
/** Stepper for the GeoJSON-as-shapes flow (no field mapping needed). */
const STEP_ORDER_SHAPES: Step[] = ['file', 'geojson-mode', 'shapes-preview']
/** Stepper for GeoJSON-as-data — same as rows but with the mode picker in front. */
const STEP_ORDER_GEOJSON_ROWS: Step[] = ['file', 'geojson-mode', 'match', 'map', 'preview']

function stepLabel(s: Step, t: TFunction): string {
  switch (s) {
    case 'file': return t('integrations.import.step.file', { defaultValue: 'File' })
    case 'geojson-mode': return t('integrations.import.step.mode', { defaultValue: 'Mode' })
    case 'match': return t('integrations.import.step.match', { defaultValue: 'Match' })
    case 'map': return t('integrations.import.step.map', { defaultValue: 'Mapping' })
    case 'preview':
    case 'shapes-preview':
      return t('integrations.import.step.preview', { defaultValue: 'Preview' })
    case 'done': return t('integrations.import.step.done', { defaultValue: 'Done' })
  }
}

/** Which row of the GeoJSON branch we're on after the file step. */
type GeoJsonMode = 'shapes' | 'data'

interface ImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after a successful commit so the parent can refresh state / toast. */
  onCommitted?: (summary: ImportSummary) => void
  /**
   * Where the wizard was opened. From `/integrations` it's a file import
   * only: REST sources have their own editor there and webhooks aren't
   * offered, and the "configure live streams on the Integrations page"
   * pointer would point at the page you're on. The map editor (default)
   * keeps the saved-source tabs.
   */
  context?: 'editor' | 'integrations'
}

export function ImportDialog({ open, onOpenChange, onCommitted, context = 'editor' }: ImportDialogProps) {
  const { t } = useTranslation()
  // Active warehouse from the URL search param. Newly imported shapes
  // inherit this so the sidebar's warehouse-scope filter doesn't hide
  // them. The user can still override via the wizard's zone picker.
  const [searchParams] = useSearchParams()
  const activeWarehouseId = useMemo<number | undefined>(() => {
    const raw = searchParams.get('warehouseId')
    if (raw === null || !/^\d+$/.test(raw)) return undefined
    return Number(raw)
  }, [searchParams])

  const [step, setStep] = useState<Step>('file')
  const [file, setFile] = useState<File | null>(null)
  const [fileKind, setFileKind] = useState<FileKind | null>(null)
  const [parsed, setParsed] = useState<ParsedFile | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Plan state
  const [match, setMatch] = useState<MatchStrategy>({ mode: 'externalCode', column: '' })
  const [fieldMapping, setFieldMapping] = useState<Record<string, FieldTarget>>({})
  // `zoneId` defaults to the active warehouse. The wizard is mounted
  // once and only its `open` prop toggles, so `resetAll()` (called on
  // close below) re-seeds the value the next time the user opens it.
  const [zoneId, setZoneId] = useState<number | undefined>(activeWarehouseId)
  const [autoDefine, setAutoDefine] = useState(true)
  const [sourceName, setSourceName] = useState('')

  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [summary, setSummary] = useState<ImportSummary | null>(null)

  // GeoJSON dual-mode state. Populated only when the user picks a
  // .geojson file; the shape-import path doesn't go through the
  // row-based pipeline so it carries its own preview + summary.
  const [parsedGeoJson, setParsedGeoJson] = useState<ParsedGeoJson | null>(null)
  const [geoJsonMode, setGeoJsonMode] = useState<GeoJsonMode | null>(null)
  const [shapesPreview, setShapesPreview] = useState<ShapeImportPreview | null>(null)
  const [shapesSummary, setShapesSummary] = useState<ShapeImportSummary | null>(null)

  // REST + Webhook source state — kept alongside the file state so the
  // dialog can persist the URL/headers/responseFormat onto the
  // DataSource row for later re-runs. `restConfig` is null while the
  // user is on the File tab; `webhookCfg` is null until the user
  // successfully registers a webhook source and receives its first
  // sample event.
  const [sourceMode, setSourceMode] = useState<'file' | 'url' | 'webhook'>('file')
  const [restConfig, setRestConfig] = useState<RestSourceConfig | null>(null)
  const [webhookCfg, setWebhookCfg] = useState<WebhookSourceConfig | null>(null)
  // When the wizard is driven by a source picked from the integrations
  // page (rather than inline setup that's gone now), we track its DB id
  // so `runCommit` can UPDATE that row's mapping instead of inserting a
  // duplicate. Stays null for file imports.
  const [existingSourceId, setExistingSourceId] = useState<number | null>(null)

  const tenantId = useCurrentTenantId()
  const zonesQuery = useApiQuery(
    () => apiDb.zones.toArray(),
    ['zones', tenantId],
    // Event-driven: zones are loaded by the spatial store; the dialog just
    // re-fetches once per open and on invalidation.
    { intervalMs: 0 },
  )
  const zones = zonesQuery.data

  const resetAll = () => {
    setStep('file')
    setFile(null)
    setFileKind(null)
    setParsed(null)
    setParseError(null)
    setBusy(false)
    setMatch({ mode: 'externalCode', column: '' })
    setFieldMapping({})
    setZoneId(activeWarehouseId)
    setAutoDefine(true)
    setSourceName('')
    setPreview(null)
    setSummary(null)
    setParsedGeoJson(null)
    setGeoJsonMode(null)
    setShapesPreview(null)
    setShapesSummary(null)
    setSourceMode('file')
    setRestConfig(null)
    setWebhookCfg(null)
    setExistingSourceId(null)
  }

  const handleOpenChange = (next: boolean) => {
    if (!next) resetAll()
    onOpenChange(next)
  }

  // -------------------------------------------------------- Step 1: file
  const handleFile = async (f: File) => {
    setFile(f)
    setBusy(true)
    setParseError(null)
    try {
      const kind = detectFileKind(f)
      if (kind === null) {
        throw new UnsupportedFormatError(
          t('integrations.import.error.unsupportedFile', {
            defaultValue: 'Unsupported file "{{name}}". Pick a CSV, TSV, Excel (.xlsx / .xls), JSON, or GeoJSON file.',
            name: f.name,
          }),
        )
      }
      setFileKind(kind)
      setSourceName(f.name.replace(/\.[^.]+$/, ''))

      if (kind === 'geojson') {
        // Dual-mode flow: parse the spatial structure once so the shape
        // preview can render counts immediately, and surface the flat
        // ParsedFile for the data-join branch.
        const pg = await parseGeoJsonFile(f)
        setParsedGeoJson(pg)
        const flat = pg.asParsedFile()
        setParsed(flat)
        // Pre-seed the row-based mapping in case the user picks data-join.
        const seed: Record<string, FieldTarget> = {}
        for (const col of flat.columns) {
          const guess = suggestFieldTarget(col)
          seed[col] = guess ?? { kind: 'ignore' }
        }
        setFieldMapping(seed)
        setShapesPreview(previewShapeImport(pg.features))
        setStep('geojson-mode')
        return
      }

      const p = await parseFile(f)
      setParsed(p)
      const seed: Record<string, FieldTarget> = {}
      for (const col of p.columns) {
        const guess = suggestFieldTarget(col)
        seed[col] = guess ?? { kind: 'ignore' }
      }
      setFieldMapping(seed)
      // Auto-suggest the match strategy from column names.
      // Priority: bin label (matches the on-map cell text) → external code.
      const norm = (c: string) => c.replace(/[^a-z0-9]/gi, '').toLowerCase()
      const labelCol = p.columns.find((c) =>
        /^(label|binlabel|cellcode|cell|location|loc|bin)$/.test(norm(c)),
      )
      if (labelCol) {
        setMatch({ mode: 'binLabel', column: labelCol })
      } else {
        const codeCol = p.columns.find((c) =>
          /^(externalcode|bincode|wmscode|locationcode|locator|barcode|code)$/.test(norm(c)),
        )
        if (codeCol) setMatch({ mode: 'externalCode', column: codeCol })
      }
      setStep('match')
    } catch (err) {
      setParseError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const handleGeoJsonModePick = (mode: GeoJsonMode) => {
    setGeoJsonMode(mode)
    setStep(mode === 'shapes' ? 'shapes-preview' : 'match')
  }

  /**
   * Fetch a URL and replay it through the file pipeline. The synthetic
   * File means the rest of the dialog doesn't know whether we came from
   * a picker or a network call — same match/map/preview/commit flow.
   * The fetch errors are caught here; parser errors land in `handleFile`'s
   * own try/catch.
   */
  const handleFetchUrl = async (config: RestSourceConfig) => {
    setBusy(true)
    setParseError(null)
    let synthesized: File
    try {
      synthesized = await fetchRestSource(config)
    } catch (err) {
      setParseError((err as Error).message)
      setBusy(false)
      return
    }
    setRestConfig(config)
    // `handleFile` manages its own busy + parseError; the inner setBusy
    // calls are idempotent so the leading-edge `true` we set here is
    // fine.
    await handleFile(synthesized)
  }

  /**
   * Use an existing REST source from the integrations page. Pulls the
   * config and runs it through the same fetch → parse → match → map
   * pipeline. On commit, `runCommit` updates the source's mapping
   * instead of inserting a duplicate.
   */
  const handleUseRestSource = async (source: DataSource) => {
    const cfg = source.config as unknown as RestSourceConfig
    if (!cfg?.url) {
      setParseError(
        t('integrations.import.error.restNoUrl', {
          defaultValue: 'This source has no URL yet. Edit it on the Integrations page.',
        }),
      )
      return
    }
    setExistingSourceId(source.id ?? null)
    setSourceName(source.name)
    // Seed the prior mapping so the user can re-run a fully-configured
    // source without re-picking columns. `handleFile` re-derives the
    // field guesses; if a saved mapping exists it'll be re-applied
    // via the rerun path. For wizard re-runs we let the user re-confirm.
    await handleFetchUrl(cfg)
  }

  /**
   * Use an existing webhook source. The backend already has the token
   * registered (the integrations page handled that on save), so we
   * skip /register and go straight to draining + waiting.
   */
  const handleUseWebhookSource = async (source: DataSource) => {
    const cfg = source.config as unknown as WebhookSourceConfig
    if (!cfg?.workerBaseUrl || !cfg?.sourceToken) {
      setParseError(
        t('integrations.import.error.webhookIncomplete', {
          defaultValue: 'This webhook source is missing its address or token. Edit it on the Integrations page.',
        }),
      )
      return
    }
    setExistingSourceId(source.id ?? null)
    setSourceName(source.name)
    setBusy(true)
    setParseError(null)
    const startedAt = Date.now()
    const maxWaitMs = 30_000
    let drained = null
    let lastError: string | null = null
    while (Date.now() - startedAt < maxWaitMs) {
      try {
        drained = await drainWebhookSource(cfg)
      } catch (err) {
        lastError =
          err instanceof WebhookFetchError ? err.message : (err as Error).message
        break
      }
      if (drained) break
      await sleep(1500)
    }
    if (lastError) {
      setParseError(lastError)
      setBusy(false)
      return
    }
    if (!drained) {
      setParseError(
        t('integrations.import.error.webhookTimeout', {
          defaultValue: "No event received in {{seconds}}s. Send a signed POST to the source's webhook URL and try again.",
          seconds: Math.round(maxWaitMs / 1000),
        }),
      )
      setBusy(false)
      return
    }
    setWebhookCfg({ ...cfg, lastEventAt: drained.lastReceivedAt ? new Date(drained.lastReceivedAt) : new Date() })
    setRestConfig(null)
    await handleFile(drained.file)
  }

  const runShapesCommit = async () => {
    if (!parsedGeoJson) return
    setBusy(true)
    try {
      const unit = await getDisplayUnit()
      const s = await commitShapeImport(parsedGeoJson.features, {
        unit,
        zoneId,
        sourceMeta: file
          ? { fileName: file.name, fileSize: file.size }
          : undefined,
      })
      setShapesSummary(s)
      setStep('done')
    } catch (err) {
      setParseError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const runPreview = async () => {
    if (!file || !parsed) return
    setBusy(true)
    try {
      const plan = buildPlan(parsed, match, fieldMapping, zoneId, fileKind)
      plan.fieldMapping = stripMatchColumns(fieldMapping, matchColumns(match))
      plan.autoDefineAttributes = autoDefine
      const p = await previewImport(file, plan)
      setPreview(p)
      setStep('preview')
    } catch (err) {
      setParseError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const runCommit = async () => {
    if (!file || !parsed || !preview) return
    setBusy(true)
    try {
      const now = new Date()
      const plan = buildPlan(parsed, match, fieldMapping, zoneId, fileKind)
      plan.fieldMapping = stripMatchColumns(fieldMapping, matchColumns(match))
      plan.autoDefineAttributes = autoDefine
      // Dexie's `add()` returns the inserted key. With `EntityTable<T, 'id'>`
      // and `id?: number`, TypeScript widens to `number | undefined`,
      // but at runtime an auto-increment row always has a numeric id.
      // Picking the kind:
      //   - webhook  → background scheduler will drain on poll
      //   - rest     → background scheduler will refetch on poll
      //   - file     → no auto-refresh; sidebar shows a re-pick hint
      const sourceKind: 'csv' | 'xlsx' | 'json' | 'rest' | 'webhook' = webhookCfg
        ? 'webhook'
        : restConfig
          ? 'rest'
          : fileKind === 'xlsx'
            ? 'xlsx'
            : fileKind === 'json'
              ? 'json'
              : 'csv'
      const sheetMeta =
        parsed?.meta?.kind === 'xlsx'
          ? { sheetName: parsed.meta.sheetName, sheetNames: parsed.meta.sheetNames }
          : undefined
      const sourceConfig: Record<string, unknown> = webhookCfg
        ? ({ ...webhookCfg } as unknown as Record<string, unknown>)
        : restConfig
          ? { ...restConfig }
          : {
              fileName: file?.name,
              fileSize: file?.size,
              ...(sheetMeta ?? {}),
            }
      const defaultName =
        webhookCfg?.sourceToken.slice(0, 12) ??
        restConfig?.url ??
        file?.name ??
        `${sourceKind.toUpperCase()} import`
      let sourceId: number
      if (existingSourceId !== null) {
        // Picked from the integrations page — preserve the source row,
        // just update its mapping + lastRun bookkeeping. Avoids
        // duplicate rows piling up every time the user re-runs an
        // already-configured source from the wizard.
        await updateSourceMapping(
          existingSourceId,
          { fields: mappingToWireFormat(fieldMapping, match), zoneId },
          now,
        )
        sourceId = existingSourceId
      } else {
        sourceId = await createBinSource({
          name: sourceName.trim() || defaultName,
          kind: sourceKind,
          // v3 — the file-import wizard historically served bin/rack
          // data. Default to 'rack-cell' so its rows keep the legacy
          // write path (bins). Non-rack uploads should be added via
          // /integrations where the entity-kind picker is explicit.
          entityKind: 'rack-cell',
          zoneId,
          config: sourceConfig,
          mapping: { fields: mappingToWireFormat(fieldMapping, match), zoneId },
          schedule: webhookCfg ? 'interval' : 'manual',
          intervalSeconds: webhookCfg ? (webhookCfg.pollIntervalSec ?? 30) : undefined,
          createdAt: now,
          updatedAt: now,
        })
      }
      const s = await commitImport(file, plan, preview, sourceId)
      setSummary(s)
      setStep('done')
      onCommitted?.(s)
    } catch (err) {
      setParseError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const sample = useMemo(() => parsed?.rows[0] ?? {}, [parsed])
  const matchValid = isMatchValid(match)
  // Pick the stepper order that matches the active flow. GeoJSON has
  // two branches with different step counts; everything else uses the
  // original rows-based order.
  const stepOrder = useMemo<Step[]>(() => {
    if (fileKind !== 'geojson') return STEP_ORDER_ROWS
    if (geoJsonMode === 'shapes') return STEP_ORDER_SHAPES
    return STEP_ORDER_GEOJSON_ROWS
  }, [fileKind, geoJsonMode])

  return (
    <DialogPrimitive.Root open={open} onOpenChange={handleOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          // Bypassing the shared `DialogContent` wrapper on purpose: that
          // wrapper hardcodes a top-right close button + standard padding,
          // and we want to own the chrome (header / stepper / body /
          // footer) so the close lives in the header instead of floating
          // over our title.
          // Focus the dialog itself on open — Radix would otherwise land on
          // the header close button and paint a focus ring on it.
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            ;(e.currentTarget as HTMLElement | null)?.focus()
          }}
          className={cn(
            'fixed left-[50%] top-[50%] z-50 flex flex-col translate-x-[-50%] translate-y-[-50%]',
            'w-[min(720px,calc(100vw-2rem))] h-[min(80dvh,720px)]',
            'rounded-xl border bg-card shadow-2xl overflow-hidden outline-none',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
          )}
        >
          {/* HEADER */}
          <div className="flex items-center gap-3 px-5 py-3.5 border-b bg-muted/30 flex-shrink-0">
            <div className="flex items-center justify-center w-8 h-8 rounded-md bg-primary/10 text-primary flex-shrink-0">
              <Database className="w-4 h-4" />
            </div>
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="text-sm font-semibold leading-tight">
                {context === 'integrations'
                  ? t('integrations.import.titleImportFile', { defaultValue: 'Import a file' })
                  : t('integrations.import.titleLinkData', { defaultValue: 'Link external data' })}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="text-[11px] text-muted-foreground leading-tight mt-0.5">
                {stepDescription(step, t, context === 'integrations')}
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7 flex-shrink-0" aria-label={t('integrations.import.close', { defaultValue: 'Close' })}>
                <X className="w-3.5 h-3.5" />
              </Button>
            </DialogPrimitive.Close>
          </div>

          {/* STEPPER */}
          {step !== 'done' && <Stepper current={step} order={stepOrder} />}

          {/* BODY */}
          <div className="px-5 py-4 overflow-y-auto min-h-0 flex-1">
            {parseError && (
              <div className="mb-3 text-xs text-danger bg-danger/10 border border-danger/30 rounded-md px-3 py-2 flex items-start gap-2">
                <XCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                <span>{parseError}</span>
              </div>
            )}

            {step === 'file' && (
              <FileStep
                onPicked={handleFile}
                onUseRest={(s) => void handleUseRestSource(s)}
                onUseWebhook={(s) => void handleUseWebhookSource(s)}
                busy={busy}
                fileName={file?.name}
                parsedMeta={parsed?.meta}
                mode={sourceMode}
                onModeChange={setSourceMode}
                filesOnly={context === 'integrations'}
              />
            )}

            {step === 'geojson-mode' && parsedGeoJson && (
              <GeoJsonModeStep
                parsed={parsedGeoJson}
                onPick={handleGeoJsonModePick}
              />
            )}

            {step === 'shapes-preview' && parsedGeoJson && shapesPreview && (
              <ShapesPreviewStep
                preview={shapesPreview}
                zones={zones ?? []}
                zoneId={zoneId}
                onZoneChange={setZoneId}
              />
            )}

            {step === 'match' && parsed && (
              <MatchStep
                columns={parsed.columns}
                rowCount={parsed.rows.length}
                match={match}
                onMatchChange={setMatch}
                zones={zones ?? []}
                zoneId={zoneId}
                onZoneChange={setZoneId}
                sourceName={sourceName}
                onSourceNameChange={setSourceName}
              />
            )}

            {step === 'map' && parsed && (
              <MapStep
                columns={parsed.columns.filter((c) => !matchColumns(match).includes(c))}
                mapping={fieldMapping}
                onMappingChange={setFieldMapping}
                sample={sample}
                autoDefine={autoDefine}
                onAutoDefineChange={setAutoDefine}
              />
            )}

            {step === 'preview' && preview && (
              <ImportPreviewBlock preview={preview} />
            )}

            {step === 'done' && summary && <DoneStep summary={summary} />}
            {step === 'done' && shapesSummary && (
              <ShapesDoneStep summary={shapesSummary} />
            )}
          </div>

          {/* FOOTER */}
          <div className="px-5 py-3 border-t bg-background flex-shrink-0 flex items-center justify-between gap-2">
            {step === 'done' ? (
              <>
                <span className="text-xs text-muted-foreground">
                  {t('integrations.import.savedToHistory', { defaultValue: 'Saved to your import history.' })}
                </span>
                <Button onClick={() => handleOpenChange(false)} size="sm">
                  {t('integrations.import.close', { defaultValue: 'Close' })}
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleOpenChange(false)}
                  disabled={busy}
                >
                  {t('integrations.import.cancel', { defaultValue: 'Cancel' })}
                </Button>
                <div className="flex items-center gap-2">
                  {step !== 'file' && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => goBack(step, setStep)}
                      disabled={busy}
                    >
                      <ArrowLeft className="h-3.5 w-3.5 me-1" />
                      {t('integrations.import.back', { defaultValue: 'Back' })}
                    </Button>
                  )}
                  {step !== 'file' && step !== 'geojson-mode' && (
                    <Button
                      size="sm"
                      onClick={() => {
                        if (step === 'match') setStep('map')
                        else if (step === 'map') void runPreview()
                        else if (step === 'preview') void runCommit()
                        else if (step === 'shapes-preview') void runShapesCommit()
                      }}
                      disabled={
                        !canAdvance(step, parsed, matchValid, preview, shapesPreview) || busy
                      }
                    >
                      {busy && <Loader2 className="h-3.5 w-3.5 me-1 animate-spin" />}
                      {step === 'preview'
                        ? t('integrations.import.importRows', {
                            defaultValue: 'Import {{count}} rows',
                            count: previewWriteCount(preview),
                          })
                        : step === 'shapes-preview'
                          ? t('integrations.import.importShapes', {
                              defaultValue: 'Import {{count}} shapes',
                              count: shapesWriteCount(shapesPreview),
                            })
                          : t('integrations.import.next', { defaultValue: 'Next' })}
                      {!busy && step !== 'preview' && step !== 'shapes-preview' && (
                        <ArrowRight className="h-3.5 w-3.5 ms-1" />
                      )}
                    </Button>
                  )}
                </div>
              </>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

// ============================================================ stepper

function Stepper({ current, order }: { current: Step; order: Step[] }) {
  const { t } = useTranslation()
  const currentIdx = order.indexOf(current)
  return (
    <div className="flex items-center gap-2 px-5 py-2.5 border-b bg-background flex-shrink-0">
      {order.map((s, i) => {
        const done = i < currentIdx
        const active = i === currentIdx
        return (
          <div key={s} className={cn('flex items-center gap-2 min-w-0', active ? 'flex-[2_1_0%] sm:flex-1' : 'flex-1')} aria-current={active ? 'step' : undefined}>
            <div
              className={cn(
                'flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-semibold flex-shrink-0 transition-colors',
                done && 'bg-primary text-primary-foreground',
                active && 'bg-primary text-primary-foreground ring-2 ring-primary/30',
                !done && !active && 'bg-muted text-muted-foreground',
              )}
            >
              {done ? <CheckCircle2 className="w-3 h-3" /> : i + 1}
            </div>
            <span
              className={cn(
                'text-xs font-medium truncate',
                // Phones only have room for the current step's name.
                active ? 'text-foreground' : 'text-muted-foreground max-sm:sr-only',
              )}
            >
              {stepLabel(s, t)}
            </span>
            {i < order.length - 1 && (
              <div className="flex-1 h-px bg-border min-w-[12px]" />
            )}
          </div>
        )
      })}
    </div>
  )
}

// ============================================================ step: file

function FileStep({
  onPicked,
  onUseRest,
  onUseWebhook,
  busy,
  fileName,
  parsedMeta,
  mode,
  onModeChange,
  filesOnly = false,
}: {
  filesOnly?: boolean
  onPicked: (f: File) => void
  onUseRest: (source: DataSource) => void
  onUseWebhook: (source: DataSource) => void
  busy: boolean
  fileName?: string
  parsedMeta?: ParsedFile['meta']
  mode: 'file' | 'url' | 'webhook'
  onModeChange: (mode: 'file' | 'url' | 'webhook') => void
}) {
  const { t } = useTranslation()
  const [isDragging, setIsDragging] = useState(false)
  const sheetSummary =
    parsedMeta?.kind === 'xlsx' && parsedMeta.sheetNames.length > 1
      ? t('integrations.import.file.sheetSummary', {
          defaultValue: 'Using "{{sheet}}" ({{count}} sheets in workbook).',
          sheet: parsedMeta.sheetName,
          count: parsedMeta.sheetNames.length,
        })
      : parsedMeta?.kind === 'json' && parsedMeta.rootPath && parsedMeta.rootPath !== ''
        ? t('integrations.import.file.jsonRoot', {
            defaultValue: 'Reading rows from "{{path}}".',
            path: `$.${parsedMeta.rootPath}`,
          })
        : null
  return (
    <div className="space-y-3">
      {/* Source-mode tabs */}
      {!filesOnly && (
      <div className="flex items-center gap-1 p-0.5 rounded-md border bg-muted/30 w-fit">
        <SourceTabButton
          label={t('integrations.import.source.file', { defaultValue: 'File' })}
          icon={<Upload className="w-3 h-3" />}
          active={mode === 'file'}
          onClick={() => onModeChange('file')}
        />
        <SourceTabButton
          label="REST"
          icon={<Cloud className="w-3 h-3" />}
          active={mode === 'url'}
          onClick={() => onModeChange('url')}
        />
        <SourceTabButton
          label={t('integrations.import.source.webhook', { defaultValue: 'Webhook' })}
          icon={<RefreshCw className="w-3 h-3" />}
          active={mode === 'webhook'}
          onClick={() => onModeChange('webhook')}
        />
      </div>
      )}

      {!filesOnly && mode === 'url' && (
        <SavedSourcePicker kind="rest" onUse={onUseRest} busy={busy} />
      )}
      {!filesOnly && mode === 'webhook' && (
        <SavedSourcePicker kind="webhook" onUse={onUseWebhook} busy={busy} />
      )}
      {(mode === 'file' || filesOnly) && (
        <>
          <FilePickerArea
            onPicked={onPicked}
            busy={busy}
            fileName={fileName}
            sheetSummary={sheetSummary}
            isDragging={isDragging}
            setIsDragging={setIsDragging}
          />
          <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
            <span>
              {t('integrations.import.file.templateHint', {
                defaultValue: "Don't have a file yet? Grab a template with the required columns.",
              })}
            </span>
            <SampleDownloadMenu kind="rack-cell" size="sm" variant="outline" />
          </div>
        </>
      )}

      {/* Pointer to the full integrations page — live streams (asset /
          sensor / RFID / shipment / camera) push to map overlays, not bin
          properties, so they're configured there. */}
      {!filesOnly && (
      <div className="pt-2 border-t border-border/60">
        <p className="text-[10.5px] text-muted-foreground leading-relaxed">
          <Trans
            i18nKey="integrations.import.file.liveStreamsHint"
            defaults="Looking for <b>live streams</b> (asset positions, sensor readings, RFID, shipments, cameras)? They show directly on the map, not as bin properties. Set them up on the <link>Integrations page →</link>"
            components={{
              b: <span className="font-medium" />,
              link: (
                <a
                  href="/integrations"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline-offset-2 hover:underline"
                />
              ),
            }}
          />
        </p>
      </div>
      )}
    </div>
  )
}

/**
 * Lists DataSources of a specific kind so the user can re-use a
 * connection set up on `/integrations` instead of redoing the URL/auth
 * forms inline. The wizard's job here is reduced to "pick a source,
 * map its columns, commit" — setup proper lives on the page.
 */
function SavedSourcePicker({
  kind,
  onUse,
  busy,
}: {
  kind: 'rest' | 'webhook'
  onUse: (source: DataSource) => void
  busy: boolean
}) {
  const tenantId = useCurrentTenantId()
  const sourcesQuery = useApiQuery(
    () => apiDb.dataSources.toArray().then((rows) => rows.filter((r) => r.kind === kind)),
    ['dataSources', tenantId],
    // Event-driven: fetch once per open, refresh only on mutation invalidation.
    { intervalMs: 0 },
  )
  const sources = sourcesQuery.data ?? []
  const sorted = [...sources].sort((a, b) => {
    const at = a.createdAt instanceof Date ? a.createdAt.getTime() : Date.parse(String(a.createdAt))
    const bt = b.createdAt instanceof Date ? b.createdAt.getTime() : Date.parse(String(b.createdAt))
    return bt - at
  })
  const { t } = useTranslation()
  const KindIcon = kind === 'rest' ? Cloud : RefreshCw
  return (
    <div className="space-y-3">
      <div className="text-[11px] text-muted-foreground px-0.5 flex items-start gap-1.5">
        <KindIcon className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-primary" />
        <span>
          {kind === 'rest'
            ? t('integrations.import.saved.restHint', {
                defaultValue: 'Pick a REST endpoint to import from. Its URL, sign-in, and schedule are set up on the Integrations page.',
              })
            : t('integrations.import.saved.webhookHint', {
                defaultValue: 'Pick a webhook source to read. Any events the sender posted since the last run are waiting in the queue.',
              })}
        </span>
      </div>

      {sorted.length === 0 ? (
        <div className="border-2 border-dashed rounded-lg py-8 px-4 text-center bg-muted/10">
          <KindIcon className="w-7 h-7 mx-auto text-muted-foreground mb-2" />
          <p className="text-xs text-muted-foreground mb-3">
            {kind === 'rest'
              ? t('integrations.import.saved.emptyRest', { defaultValue: 'No REST sources yet.' })
              : t('integrations.import.saved.emptyWebhook', { defaultValue: 'No webhook sources yet.' })}
          </p>
          <Link
            to="/integrations"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
          >
            <Plus className="w-3 h-3" />
            {t('integrations.import.saved.addOne', { defaultValue: 'Add one on the Integrations page' })}
            <ArrowRight className="w-3 h-3" />
          </Link>
        </div>
      ) : (
        <>
          <div className="space-y-1.5">
            {sorted.map((s) => (
              <SavedSourceRow key={s.id} source={s} onUse={onUse} busy={busy} />
            ))}
          </div>
          <Link
            to="/integrations"
            className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors px-0.5"
          >
            <Plus className="w-3 h-3" />
            {t('integrations.import.saved.manage', { defaultValue: 'Manage on the Integrations page' })}
            <ArrowRight className="w-3 h-3" />
          </Link>
        </>
      )}
    </div>
  )
}

function SavedSourceRow({
  source,
  onUse,
  busy,
}: {
  source: DataSource
  onUse: (source: DataSource) => void
  busy: boolean
}) {
  const { t } = useTranslation()
  const cfg = source.config as Partial<RestSourceConfig & WebhookSourceConfig>
  const detail =
    source.kind === 'rest'
      ? cfg.url ?? '—'
      : cfg.workerBaseUrl && cfg.sourceToken
        ? `${cfg.workerBaseUrl.replace(/\/+$/, '')}/api/v1/webhooks/${cfg.sourceToken.slice(0, 12)}…`
        : '—'
  const hasMapping = Object.keys(source.mapping?.fields ?? {}).length > 0
  return (
    <div className="border rounded-md p-2.5 bg-background/40 hover:bg-accent/30 transition-colors flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium truncate">{source.name}</div>
        <div className="text-[10px] font-mono text-muted-foreground truncate" title={detail}>
          {detail}
        </div>
        <div className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-2">
          {source.lastResult && (
            <span
              className={
                source.lastResult === 'ok'
                  ? 'text-success'
                  : source.lastResult === 'error'
                    ? 'text-danger'
                    : 'text-warning'
              }
            >
              {source.lastResult}
            </span>
          )}
          {hasMapping ? (
            <span className="text-success">{t('integrations.import.status.mapped', { defaultValue: 'Mapped' })}</span>
          ) : (
            <span className="text-warning">{t('integrations.import.status.noMappingYet', { defaultValue: 'No mapping yet' })}</span>
          )}
        </div>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => onUse(source)}
        disabled={busy}
        className="flex-shrink-0"
      >
        {busy && <Loader2 className="w-3 h-3 me-1.5 animate-spin" />}
        {t('integrations.import.saved.use', { defaultValue: 'Use' })}
      </Button>
    </div>
  )
}

function SourceTabButton({
  label,
  icon,
  active,
  onClick,
}: {
  label: string
  icon: React.ReactNode
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-colors',
        active
          ? 'bg-card shadow-sm text-foreground'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {icon}
      {label}
    </button>
  )
}

function FilePickerArea({
  onPicked,
  busy,
  fileName,
  sheetSummary,
  isDragging,
  setIsDragging,
}: {
  onPicked: (f: File) => void
  busy: boolean
  fileName?: string
  sheetSummary: string | null
  isDragging: boolean
  setIsDragging: (b: boolean) => void
}) {
  // Past file-backed DataSources — surface them above the drag-drop so
  // the user sees what they've imported before and can re-run any of
  // them. We can't re-fetch the bytes (file content isn't persisted),
  // but a click hints "re-pick the matching file" via a native file
  // dialog the same input handles.
  const { t } = useTranslation()
  const tenantId = useCurrentTenantId()
  const recentFileSourcesQuery = useApiQuery(
    () =>
      apiDb.dataSources
        .toArray()
        .then((rows) => rows.filter((r) => ['csv', 'xlsx', 'json', 'geojson'].includes(r.kind))),
    ['dataSources', tenantId],
    // Event-driven: no timer polling inside the editor dialog.
    { intervalMs: 0 },
  )
  const recentFileSources = recentFileSourcesQuery.data ?? []
  const sortedRecent = [...recentFileSources].sort((a, b) => {
    const at = a.createdAt instanceof Date ? a.createdAt.getTime() : Date.parse(String(a.createdAt))
    const bt = b.createdAt instanceof Date ? b.createdAt.getTime() : Date.parse(String(b.createdAt))
    return bt - at
  })

  return (
    <div className="space-y-3">
      {sortedRecent.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[11px] text-muted-foreground px-0.5 flex items-center gap-1.5">
            <FileText className="w-3.5 h-3.5 text-primary" />
            <span>
              {t('integrations.import.file.recentHint', {
                defaultValue: 'Recent imports. Pick the same file again to re-run one.',
              })}
            </span>
          </div>
          <div className="space-y-1 max-h-[180px] overflow-y-auto">
            {sortedRecent.map((s) => (
              <RecentFileRow key={s.id} source={s} busy={busy} />
            ))}
          </div>
        </div>
      )}

      <label
        className={cn(
          'flex flex-col items-center justify-center gap-3 border-2 border-dashed rounded-lg py-10 px-6 cursor-pointer transition-all',
          isDragging
            ? 'border-primary bg-primary/5 scale-[1.01]'
            : 'border-border hover:border-primary/40 hover:bg-accent/40',
        )}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setIsDragging(false)
          const f = e.dataTransfer.files?.[0]
          if (f) onPicked(f)
        }}
      >
        <input
          type="file"
          accept=".csv,.tsv,.txt,.xlsx,.xls,.xlsm,.json,.geojson,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/json,application/geo+json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) onPicked(f)
            e.target.value = ''
          }}
        />
        <div className="flex items-center justify-center w-12 h-12 rounded-full bg-primary/10 text-primary">
          {busy ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <Upload className="h-5 w-5" />
          )}
        </div>
        <div className="text-center space-y-1">
          <div className="text-sm font-medium">
            {busy
              ? t('integrations.import.file.reading', { defaultValue: 'Reading file…' })
              : fileName
                ? t('integrations.import.file.replace', {
                    defaultValue: 'Pick another file to replace {{name}}',
                    name: fileName,
                  })
                : sortedRecent.length > 0
                  ? t('integrations.import.file.dropNew', {
                      defaultValue: 'Drop a new file here, or click to browse',
                    })
                  : t('integrations.import.file.dropAny', {
                      defaultValue: 'Drop a CSV, Excel, JSON, or GeoJSON file here, or click to browse',
                    })}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {t('integrations.import.file.limits', {
              defaultValue: 'Up to {{size}} · {{formats}} · CSV and XLSX need a header row',
              size: '10\u00a0MB',
              formats: 'CSV / TSV / XLSX / JSON / GeoJSON',
            })}
          </div>
        </div>
      </label>
      {sheetSummary && (
        <div className="text-[11px] text-muted-foreground px-1">
          {sheetSummary}
        </div>
      )}
      <div className="text-[11px] text-muted-foreground px-1">
        {t('integrations.import.file.sheetShapeHint', {
          defaultValue:
            'Your sheet needs one column that identifies each bin (a code, a grid + row + column address, or a shape name), plus any number of value columns (SKU, capacity, notes, weight, lot, …).',
        })}
      </div>
    </div>
  )
}

/**
 * One row in the wizard's "recent file imports" list. Each is a past
 * `DataSource` of a file kind (csv / xlsx / json / geojson). We can't
 * re-fetch the bytes — file content isn't persisted — so the only
 * action that makes sense is "delete this entry"; the user picks a
 * fresh file via the drag-drop below if they want to re-import.
 */
function RecentFileRow({
  source,
  busy,
}: {
  source: DataSource
  busy: boolean
}) {
  const { t } = useTranslation()
  const cfg = source.config as { fileName?: string; fileSize?: number }
  const hasMapping = Object.keys(source.mapping?.fields ?? {}).length > 0
  return (
    <div className="border rounded-md p-2 bg-background/40 hover:bg-accent/30 transition-colors flex items-center gap-2">
      <FileText className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium truncate">{source.name}</div>
        <div className="text-[10px] font-mono text-muted-foreground flex items-center gap-2">
          <span className="uppercase">{source.kind}</span>
          {typeof cfg.fileSize === 'number' && (
            <span>· {(cfg.fileSize / 1024).toFixed(1)} KB</span>
          )}
          {source.createdAt && <span>· {timeAgo(source.createdAt, t)}</span>}
          {hasMapping ? (
            <span className="text-success">{t('integrations.import.status.mapped', { defaultValue: 'Mapped' })}</span>
          ) : (
            <span className="text-warning">{t('integrations.import.status.noMapping', { defaultValue: 'No mapping' })}</span>
          )}
        </div>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-6 w-6 text-destructive hover:bg-destructive/10 flex-shrink-0"
        title={t('integrations.import.removeFromHistory', { defaultValue: 'Remove from history' })}
        aria-label={t('integrations.import.removeFromHistory', { defaultValue: 'Remove from history' })}
        onClick={() => {
          if (source.id !== undefined && !busy) {
            void deleteBinSource(source.id)
          }
        }}
        disabled={busy}
      >
        <X className="w-3 h-3" />
      </Button>
    </div>
  )
}

function timeAgo(date: Date | string, t: TFunction): string {
  const ts = typeof date === 'string' ? Date.parse(date) : date.getTime()
  const diff = Date.now() - ts
  if (diff < 60_000) return t('integrations.import.time.justNow', { defaultValue: 'just now' })
  if (diff < 3_600_000) {
    return t('integrations.import.time.minutesAgo', {
      defaultValue: '{{count}}m ago',
      count: Math.floor(diff / 60_000),
    })
  }
  if (diff < 86_400_000) {
    return t('integrations.import.time.hoursAgo', {
      defaultValue: '{{count}}h ago',
      count: Math.floor(diff / 3_600_000),
    })
  }
  return t('integrations.import.time.daysAgo', {
    defaultValue: '{{count}}d ago',
    count: Math.floor(diff / 86_400_000),
  })
}


// ============================================================ step: match

interface MatchStepProps {
  columns: string[]
  rowCount: number
  match: MatchStrategy
  onMatchChange: (m: MatchStrategy) => void
  zones: { id?: number; name: string }[]
  zoneId: number | undefined
  onZoneChange: (id: number | undefined) => void
  sourceName: string
  onSourceNameChange: (s: string) => void
}

function MatchStep({
  columns, rowCount, match, onMatchChange,
  zones, zoneId, onZoneChange,
  sourceName, onSourceNameChange,
}: MatchStepProps) {
  const { t } = useTranslation()
  const strong = <span className="font-semibold text-foreground" />
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <FileText className="h-3.5 w-3.5" />
        <span>
          <Trans
            i18nKey="integrations.import.match.columnCount"
            defaults="<b>{{count}}</b> columns"
            count={columns.length}
            values={{ count: columns.length }}
            components={{ b: strong }}
          />
          {' · '}
          <Trans
            i18nKey="integrations.import.match.rowsRead"
            defaults="<b>{{count}}</b> rows read"
            count={rowCount}
            values={{ count: rowCount }}
            components={{ b: strong }}
          />
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label={t('integrations.import.match.sourceName', { defaultValue: 'Source name' })}>
          <input
            value={sourceName}
            onChange={(e) => onSourceNameChange(e.target.value)}
            className="w-full h-8 rounded-md border bg-background px-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            placeholder={t('integrations.import.match.sourceNamePlaceholder', { defaultValue: 'e.g. WMS export — June' })}
          />
        </Field>
        <Field
          label={t('integrations.import.match.facilityScope', { defaultValue: 'Facility' })}
          hint={t('integrations.import.match.facilityScopeHint', { defaultValue: 'Bins outside this facility will be skipped.' })}
        >
          <select
            value={zoneId ?? ''}
            onChange={(e) => onZoneChange(e.target.value === '' ? undefined : Number(e.target.value))}
            className="w-full h-8 rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="">{t('integrations.import.match.allFacilities', { defaultValue: 'All facilities' })}</option>
            {zones.map((z) => (
              <option key={z.id} value={z.id}>{z.name}</option>
            ))}
          </select>
        </Field>
      </div>

      <div className="space-y-2">
        <Label className="text-xs">{t('integrations.import.match.strategy', { defaultValue: 'Match each row by' })}</Label>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          <ModeCard
            label={t('integrations.import.match.binLabel', { defaultValue: 'Bin label' })}
            description={t('integrations.import.match.binLabelHint', {
              defaultValue: 'Match the cell label shown on the rack (e.g. "{{example}}"). Easiest when your WMS export already uses the codes on the map.',
              example: 'A-1-L01',
            })}
            checked={match.mode === 'binLabel'}
            onSelect={() => onMatchChange({ mode: 'binLabel', column: columns[0] ?? '' })}
          />
          <ModeCard
            label={t('integrations.import.match.externalCode', { defaultValue: 'External code' })}
            description={t('integrations.import.match.externalCodeHint', {
              defaultValue: 'One column with a unique WMS code. Works for any bin type.',
            })}
            checked={match.mode === 'externalCode'}
            onSelect={() => onMatchChange({ mode: 'externalCode', column: columns[0] ?? '' })}
          />
          <ModeCard
            label={t('integrations.import.match.gridCell', { defaultValue: 'Grid cell' })}
            description={t('integrations.import.match.gridCellHint', {
              defaultValue: 'Link to cells of a saved grid or rack, using grid + row + column (+ level).',
            })}
            checked={match.mode === 'gridCellAddress'}
            onSelect={() =>
              onMatchChange({
                mode: 'gridCellAddress',
                gridColumn: columns[0] ?? '',
                gridColumnIs: 'name',
                rowColumn: columns[1] ?? '',
                colColumn: columns[2] ?? '',
                levelColumn: columns[3],
              })
            }
          />
          <ModeCard
            label={t('integrations.import.match.shape', { defaultValue: 'Other shape' })}
            description={t('integrations.import.match.shapeHint', {
              defaultValue: 'A polygon, circle, line, marker, or image, matched by name.',
            })}
            checked={match.mode === 'shapeName'}
            onSelect={() =>
              onMatchChange({ mode: 'shapeName', column: columns[0] ?? '', kind: 'polygon' })
            }
          />
        </div>
        <p className="text-[10px] text-muted-foreground leading-relaxed px-0.5">
          <Trans
            i18nKey="integrations.import.match.tip"
            defaults="Tip: <b>Bin label</b> is the simplest match for rack data. The column just holds the cell's text on the map (<code>{{example}}</code>). Use <b>External code</b> when your WMS has its own codes that you'll link later, and <b>Other shape</b> for polygons, lines, or markers that act as a single bin."
            values={{ example: 'A-1-L01' }}
            components={{
              b: <span className="font-medium" />,
              code: <code className="font-mono text-[10px]" />,
            }}
          />
        </p>
      </div>

      <div className="rounded-md border bg-muted/20 p-3 space-y-3">
        {match.mode === 'binLabel' && (
          <Field
            label={t('integrations.import.match.labelColumn', { defaultValue: 'Label column' })}
            hint={t('integrations.import.match.labelColumnHint', {
              defaultValue: 'Each row in this column should hold the rack cell label exactly as shown on the map (e.g. "{{example}}").',
              example: 'A-1-L01',
            })}
          >
            <ColumnSelect
              value={match.column}
              columns={columns}
              onChange={(c) => onMatchChange({ ...match, column: c })}
            />
          </Field>
        )}

        {match.mode === 'externalCode' && (
          <Field label={t('integrations.import.match.codeColumn', { defaultValue: 'Code column' })}>
            <ColumnSelect
              value={match.column}
              columns={columns}
              onChange={(c) => onMatchChange({ ...match, column: c })}
            />
          </Field>
        )}

        {match.mode === 'gridCellAddress' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('integrations.import.match.gridColumn', { defaultValue: 'Grid column' })}>
              <ColumnSelect
                value={match.gridColumn}
                columns={columns}
                onChange={(c) => onMatchChange({ ...match, gridColumn: c })}
              />
            </Field>
            <Field label={t('integrations.import.match.gridColumnIs', { defaultValue: 'Grid column holds…' })}>
              <select
                value={match.gridColumnIs}
                onChange={(e) =>
                  onMatchChange({ ...match, gridColumnIs: e.target.value as 'id' | 'name' })
                }
                className="w-full h-8 rounded-md border bg-background px-2 text-sm"
              >
                <option value="name">{t('integrations.import.match.gridByName', { defaultValue: 'Grid name' })}</option>
                <option value="id">{t('integrations.import.match.gridById', { defaultValue: 'Grid number (ID)' })}</option>
              </select>
            </Field>
            <Field label={t('integrations.import.match.rowColumn', { defaultValue: 'Row column' })}>
              <ColumnSelect
                value={match.rowColumn}
                columns={columns}
                onChange={(c) => onMatchChange({ ...match, rowColumn: c })}
              />
            </Field>
            <Field label={t('integrations.import.match.colColumn', { defaultValue: 'Column-number column' })}>
              <ColumnSelect
                value={match.colColumn}
                columns={columns}
                onChange={(c) => onMatchChange({ ...match, colColumn: c })}
              />
            </Field>
            <Field label={t('integrations.import.match.levelColumn', { defaultValue: 'Level column (optional)' })}>
              <ColumnSelect
                value={match.levelColumn ?? ''}
                columns={['', ...columns]}
                onChange={(c) => onMatchChange({ ...match, levelColumn: c || undefined })}
              />
            </Field>
          </div>
        )}

        {match.mode === 'shapeName' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('integrations.import.match.nameColumn', { defaultValue: 'Name column' })}>
              <ColumnSelect
                value={match.column}
                columns={columns}
                onChange={(c) => onMatchChange({ ...match, column: c })}
              />
            </Field>
            <Field
              label={t('integrations.import.match.shapeKind', { defaultValue: 'Shape type' })}
              hint={t('integrations.import.match.shapeKindHint', {
                defaultValue: 'Grids aren\'t listed here. Use Grid cell for those.',
              })}
            >
              <select
                value={match.kind}
                onChange={(e) =>
                  onMatchChange({
                    ...match,
                    kind: e.target.value as Exclude<MatchStrategy & { mode: 'shapeName' }, never>['kind'],
                  })
                }
                className="w-full h-8 rounded-md border bg-background px-2 text-sm"
              >
                <option value="polygon">{t('integrations.import.kind.polygon', { defaultValue: 'Polygon' })}</option>
                <option value="circle">{t('integrations.import.kind.circle', { defaultValue: 'Circle' })}</option>
                <option value="line">{t('integrations.import.kind.line', { defaultValue: 'Line' })}</option>
                <option value="marker">{t('integrations.import.kind.marker', { defaultValue: 'Marker' })}</option>
                <option value="image">{t('integrations.import.kind.image', { defaultValue: 'Image' })}</option>
              </select>
            </Field>
          </div>
        )}
      </div>
    </div>
  )
}

// ============================================================ step: map

interface MapStepProps {
  columns: string[]
  mapping: Record<string, FieldTarget>
  onMappingChange: (m: Record<string, FieldTarget>) => void
  sample: Record<string, string>
  autoDefine: boolean
  onAutoDefineChange: (v: boolean) => void
}

function MapStep({
  columns, mapping, onMappingChange, sample,
  autoDefine, onAutoDefineChange,
}: MapStepProps) {
  const { t } = useTranslation()
  return (
    <div className="space-y-3">
      <p className="text-[11px] text-muted-foreground">
        <Trans
          i18nKey="integrations.import.map.intro"
          defaults="Send each remaining column to a bin field or a custom attribute, or skip it. Built-in fields are type-checked; custom attributes are saved as text under the bin's <code>{{bag}}</code>."
          values={{ bag: 'customProperties' }}
          components={{ code: <span className="font-mono" /> }}
        />
      </p>
      <FieldMapperBlock
        columns={columns}
        mapping={mapping}
        onChange={onMappingChange}
        sample={sample}
      />
      <div className="flex items-center gap-2.5 px-3 py-2 rounded-md border bg-muted/20">
        <Switch checked={autoDefine} onCheckedChange={onAutoDefineChange} id="autodef" />
        <Label htmlFor="autodef" className="cursor-pointer text-xs leading-tight flex-1">
          <span className="block font-medium">
            {t('integrations.import.map.autoDefine', { defaultValue: 'Create missing attributes automatically' })}
          </span>
          <span className="block text-muted-foreground mt-0.5">
            <Trans
              i18nKey="integrations.import.map.autoDefineHint"
              defaults="New <code>{{pattern}}</code> keys get an attribute definition so the sidebar shows them."
              values={{ pattern: 'custom.*' }}
              components={{ code: <span className="font-mono" /> }}
            />
          </span>
        </Label>
      </div>
    </div>
  )
}

// ============================================================ step: done

// ============================================================ step: geojson-mode

function GeoJsonModeStep({
  parsed,
  onPick,
}: {
  parsed: ParsedGeoJson
  onPick: (mode: GeoJsonMode) => void
}) {
  const { t } = useTranslation()
  const { counts } = parsed
  const flatColumns = parsed.asParsedFile().columns
  return (
    <div className="space-y-4">
      <div className="text-xs text-muted-foreground leading-relaxed">
        <Trans
          i18nKey="integrations.import.geojson.found"
          defaults="Found <b>{{count}} features</b> in the file. How do you want to import them?"
          count={counts.total}
          values={{ count: counts.total }}
          components={{ b: <b /> }}
        />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => onPick('shapes')}
          disabled={counts.polygon + counts.line + counts.marker === 0}
          className={cn(
            'flex flex-col items-start gap-2 rounded-md border p-4 text-left transition-colors',
            'hover:bg-accent hover:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/30',
            'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent',
          )}
        >
          <div className="text-sm font-semibold">
            {t('integrations.import.geojson.asShapes', { defaultValue: 'Import as new shapes' })}
          </div>
          <div className="text-[11px] text-muted-foreground leading-snug">
            {t('integrations.import.geojson.asShapesHint', {
              defaultValue: 'Draw every feature as a new polygon, line, or marker on the map. Use this when the file is a CAD-style export of zones or assets.',
            })}
          </div>
          <div className="text-[11px] font-mono text-muted-foreground space-x-2 pt-1">
            <span>{t('integrations.import.geojson.polygonCount', { defaultValue: '{{count}} polygons', count: counts.polygon })}</span>
            <span>·</span>
            <span>{t('integrations.import.geojson.lineCount', { defaultValue: '{{count}} lines', count: counts.line })}</span>
            <span>·</span>
            <span>{t('integrations.import.geojson.markerCount', { defaultValue: '{{count}} markers', count: counts.marker })}</span>
            {counts.unsupported > 0 && (
              <>
                <span>·</span>
                <span className="text-warning">
                  {t('integrations.import.geojson.skippedCount', { defaultValue: '{{count}} skipped', count: counts.unsupported })}
                </span>
              </>
            )}
          </div>
        </button>
        <button
          type="button"
          onClick={() => onPick('data')}
          disabled={flatColumns.length === 0}
          className={cn(
            'flex flex-col items-start gap-2 rounded-md border p-4 text-left transition-colors',
            'hover:bg-accent hover:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/30',
            'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent',
          )}
        >
          <div className="text-sm font-semibold">
            {t('integrations.import.geojson.joinData', { defaultValue: 'Join to existing data' })}
          </div>
          <div className="text-[11px] text-muted-foreground leading-snug">
            <Trans
              i18nKey="integrations.import.geojson.joinDataHint"
              defaults="Use each feature's <code>{{field}}</code> as a row and link it to an existing rack or shape (by external code, grid cell, or shape name)."
              values={{ field: 'properties' }}
              components={{ code: <code className="font-mono text-[10px]" /> }}
            />
          </div>
          <div className="text-[11px] font-mono text-muted-foreground pt-1">
            {t('integrations.import.geojson.propertyColumns', {
              defaultValue: '{{count}} columns in {{field}}',
              count: flatColumns.length,
              field: 'properties',
            })}
          </div>
        </button>
      </div>
    </div>
  )
}

// ============================================================ step: shapes-preview

function ShapesPreviewStep({
  preview,
  zones,
  zoneId,
  onZoneChange,
}: {
  preview: ShapeImportPreview
  zones: { id?: number; name: string }[]
  zoneId: number | undefined
  onZoneChange: (id: number | undefined) => void
}) {
  const { t } = useTranslation()
  const { totals, entries } = preview
  const willWrite = totals.polygons + totals.lines + totals.markers
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
        <DoneStat label={t('integrations.import.stat.polygons', { defaultValue: 'Polygons' })} value={totals.polygons} accent={totals.polygons > 0 ? 'positive' : undefined} />
        <DoneStat label={t('integrations.import.stat.lines', { defaultValue: 'Lines' })} value={totals.lines} accent={totals.lines > 0 ? 'positive' : undefined} />
        <DoneStat label={t('integrations.import.stat.markers', { defaultValue: 'Markers' })} value={totals.markers} accent={totals.markers > 0 ? 'positive' : undefined} />
        <DoneStat label={t('integrations.import.stat.skipped', { defaultValue: 'Skipped' })} value={totals.skipped} accent={totals.skipped > 0 ? 'negative' : undefined} />
      </div>
      <Field
        label={t('integrations.import.shapes.facility', { defaultValue: 'Facility' })}
        hint={t('integrations.import.shapes.facilityHint', { defaultValue: 'Put every new shape in this facility (optional).' })}
      >
        <select
          value={zoneId ?? ''}
          onChange={(e) => onZoneChange(e.target.value ? Number(e.target.value) : undefined)}
          className="h-8 w-full text-xs rounded border border-input bg-background px-2"
        >
          <option value="">{t('integrations.import.shapes.unassigned', { defaultValue: 'Unassigned' })}</option>
          {zones.map((z) => (
            <option key={z.id} value={z.id}>{z.name}</option>
          ))}
        </select>
      </Field>
      <div className="border rounded-md overflow-hidden">
        <div className="px-3 py-2 bg-muted/30 border-b text-[11px] font-medium text-muted-foreground">
          {t('integrations.import.shapes.willWrite', { defaultValue: '{{count}} shapes will be added', count: willWrite })}
        </div>
        <div className="max-h-[40dvh] overflow-y-auto divide-y divide-border">
          {entries.length === 0 ? (
            <div className="px-3 py-4 text-xs text-muted-foreground">
              {t('integrations.import.shapes.noFeatures', { defaultValue: 'No features found.' })}
            </div>
          ) : (
            entries.slice(0, 200).map((e) => (
              <div key={`${e.featureIndex}`} className="px-3 py-1.5 flex items-center gap-2 text-xs">
                <span className={cn(
                  'inline-flex items-center justify-center px-1.5 h-5 rounded text-[10px] font-mono uppercase',
                  e.kind === 'polygon' && 'bg-primary/10 text-primary',
                  e.kind === 'line' && 'bg-info/10 text-info',
                  e.kind === 'marker' && 'bg-success/10 text-success',
                  e.kind === 'unsupported' && 'bg-warning/10 text-warning',
                )}>
                  {e.kind === 'polygon'
                    ? t('integrations.import.kind.polygon', { defaultValue: 'Polygon' })
                    : e.kind === 'line'
                      ? t('integrations.import.kind.line', { defaultValue: 'Line' })
                      : e.kind === 'marker'
                        ? t('integrations.import.kind.marker', { defaultValue: 'Marker' })
                        : e.kind === 'unsupported'
                          ? t('integrations.import.kind.skip', { defaultValue: 'Skip' })
                          : e.kind}
                </span>
                <span className="font-medium truncate flex-1">{e.name}</span>
                <span className="text-muted-foreground font-mono truncate text-[10px]">
                  {e.warning ?? e.summary}
                </span>
              </div>
            ))
          )}
          {entries.length > 200 && (
            <div className="px-3 py-2 text-[11px] text-muted-foreground">
              {t('integrations.import.shapes.more', { defaultValue: '… and {{count}} more.', count: entries.length - 200 })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ShapesDoneStep({ summary }: { summary: ShapeImportSummary }) {
  const { t } = useTranslation()
  const ok = summary.errors.length === 0
  const totalCreated =
    summary.polygonsCreated + summary.linesCreated + summary.markersCreated
  return (
    <div className="space-y-3">
      <div className={cn(
        'flex items-center gap-3 rounded-md border p-3',
        ok ? 'bg-success/5 border-success/30' : 'bg-warning/5 border-warning/30',
      )}>
        <div className={cn(
          'flex items-center justify-center w-9 h-9 rounded-full flex-shrink-0',
          ok ? 'bg-success/15 text-success'
             : 'bg-warning/15 text-warning',
        )}>
          {ok ? <CheckCircle2 className="w-5 h-5" /> : <FileText className="w-5 h-5" />}
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold">
            {ok
              ? t('integrations.import.done.shapesTitle', { defaultValue: 'Shapes imported' })
              : t('integrations.import.done.shapesErrorTitle', { defaultValue: 'Imported with errors' })}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {t('integrations.import.done.shapesAdded', {
              defaultValue: '{{count}} shapes added to the workspace.',
              count: totalCreated,
            })}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
        <DoneStat label={t('integrations.import.stat.polygons', { defaultValue: 'Polygons' })} value={summary.polygonsCreated} accent={summary.polygonsCreated > 0 ? 'positive' : undefined} />
        <DoneStat label={t('integrations.import.stat.lines', { defaultValue: 'Lines' })} value={summary.linesCreated} accent={summary.linesCreated > 0 ? 'positive' : undefined} />
        <DoneStat label={t('integrations.import.stat.markers', { defaultValue: 'Markers' })} value={summary.markersCreated} accent={summary.markersCreated > 0 ? 'positive' : undefined} />
        <DoneStat label={t('integrations.import.stat.skipped', { defaultValue: 'Skipped' })} value={summary.unsupportedSkipped} />
      </div>
      {summary.errors.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground transition-colors">
            {t('integrations.import.done.viewErrors', { defaultValue: 'View {{count}} errors', count: summary.errors.length })}
          </summary>
          <pre className="mt-2 bg-muted/40 border rounded p-2.5 max-h-[16dvh] overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed">
            {summary.errors.join('\n')}
          </pre>
        </details>
      )}
    </div>
  )
}

function DoneStep({ summary }: { summary: ImportSummary }) {
  const { t } = useTranslation()
  const ok = summary.rowsErrored === 0
  return (
    <div className="space-y-3">
      <div className={cn(
        'flex items-center gap-3 rounded-md border p-3',
        ok
          ? 'bg-success/5 border-success/30'
          : 'bg-warning/5 border-warning/30',
      )}>
        <div className={cn(
          'flex items-center justify-center w-9 h-9 rounded-full flex-shrink-0',
          ok ? 'bg-success/15 text-success'
             : 'bg-warning/15 text-warning',
        )}>
          {ok ? <CheckCircle2 className="w-5 h-5" /> : <FileText className="w-5 h-5" />}
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold">
            {ok
              ? t('integrations.import.done.title', { defaultValue: 'Import complete' })
              : t('integrations.import.done.errorTitle', { defaultValue: 'Import finished with errors' })}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {t('integrations.import.done.binsWritten', {
              defaultValue: '{{count}} bins saved from {{rows}}.',
              count: summary.rowsImported,
              rows: t('integrations.import.done.rowCount', {
                defaultValue: '{{count}} rows',
                count: summary.rowsRead,
              }),
            })}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-sm">
        <DoneStat label={t('integrations.import.stat.read', { defaultValue: 'Rows read' })} value={summary.rowsRead} />
        <DoneStat label={t('integrations.import.stat.matched', { defaultValue: 'Matched' })} value={summary.rowsMatched} />
        <DoneStat label={t('integrations.import.stat.imported', { defaultValue: 'Imported' })} value={summary.rowsImported} accent={summary.rowsImported > 0 ? 'positive' : undefined} />
        <DoneStat label={t('integrations.import.stat.skipped', { defaultValue: 'Skipped' })} value={summary.rowsSkipped} />
        <DoneStat label={t('integrations.import.stat.errors', { defaultValue: 'Errors' })} value={summary.rowsErrored} accent={summary.rowsErrored > 0 ? 'negative' : undefined} />
      </div>
      {summary.errors.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground transition-colors">
            {t('integrations.import.done.viewErrors', { defaultValue: 'View {{count}} errors', count: summary.errors.length })}
          </summary>
          <pre className="mt-2 bg-muted/40 border rounded p-2.5 max-h-[16dvh] overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed">
            {summary.errors.join('\n')}
          </pre>
        </details>
      )}
    </div>
  )
}

function DoneStat({
  label, value, accent,
}: { label: string; value: number; accent?: 'positive' | 'negative' }) {
  return (
    <div className={cn(
      'border rounded-md px-2.5 py-1.5',
      accent === 'positive' && 'border-success/30 bg-success/5',
      accent === 'negative' && 'border-danger/30 bg-danger/5',
    )}>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold tabular-nums">{value}</div>
    </div>
  )
}

// ============================================================ shared atoms

function Field({
  label, hint, children,
}: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
      {hint && <p className="text-[10px] text-muted-foreground leading-tight">{hint}</p>}
    </div>
  )
}

function ModeCard({
  label, description, checked, onSelect,
}: { label: string; description: string; checked: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={checked}
      // A <button> centres its content vertically; cards in one row differ
      // in height, so pin the text to the top.
      className={cn(
        'flex flex-col justify-start text-start p-3 rounded-md border transition-all',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        checked
          ? 'border-primary bg-primary/5 shadow-sm ring-1 ring-primary/20'
          : 'border-border hover:border-primary/40 hover:bg-accent/40',
      )}
    >
      <div className={cn('text-xs font-semibold', checked && 'text-primary')}>{label}</div>
      <div className="text-[11px] text-muted-foreground mt-1 leading-snug">{description}</div>
    </button>
  )
}

function ColumnSelect({
  value, columns, onChange,
}: { value: string; columns: string[]; onChange: (v: string) => void }) {
  const { t } = useTranslation()
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full h-8 rounded-md border bg-background px-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-ring"
    >
      {columns.map((c) => (
        <option key={c || '__empty'} value={c}>
          {c || t('integrations.import.match.noColumn', { defaultValue: '— None —' })}
        </option>
      ))}
    </select>
  )
}

// =================================================== helper functions

function stepDescription(s: Step, t: TFunction, filesOnly: boolean): string {
  switch (s) {
    case 'file':
      return filesOnly
        ? t('integrations.import.stepHint.fileOnly', { defaultValue: 'Upload a spreadsheet or GeoJSON file.' })
        : t('integrations.import.stepHint.file', { defaultValue: 'Pick a file, REST endpoint, or webhook source.' })
    case 'geojson-mode':
      return t('integrations.import.stepHint.geojsonMode', {
        defaultValue: 'Add this GeoJSON as new shapes, or join it to existing ones?',
      })
    case 'match':
      return t('integrations.import.stepHint.match', {
        defaultValue: 'Tell us how each row finds the bin it belongs to.',
      })
    case 'map':
      return t('integrations.import.stepHint.map', {
        defaultValue: 'Send the remaining columns to bin fields or custom attributes.',
      })
    case 'preview':
      return t('integrations.import.stepHint.preview', {
        defaultValue: 'Spot-check the matched rows. The import is saved in one step.',
      })
    case 'shapes-preview':
      return t('integrations.import.stepHint.shapesPreview', {
        defaultValue: 'Review the shapes we found before saving.',
      })
    case 'done':
      return t('integrations.import.stepHint.done', { defaultValue: 'Your import is complete.' })
  }
}

/** Rows the commit will write: everything the preview resolved (not unmatched). */
function previewWriteCount(preview: PreviewResult | null): number {
  if (!preview) return 0
  const { rowsMatchedGrid, rowsMatchedShape, rowsWillCreate } = preview.totals
  return rowsMatchedGrid + rowsMatchedShape + rowsWillCreate
}

/** Shapes the GeoJSON commit will write (polygons + lines + markers). */
function shapesWriteCount(preview: ShapeImportPreview | null): number {
  const totals = preview?.totals
  return totals ? totals.polygons + totals.lines + totals.markers : 0
}

function buildPlan(
  parsed: ParsedFile,
  match: MatchStrategy,
  fieldMapping: Record<string, FieldTarget>,
  zoneId: number | undefined,
  fileKind: FileKind | null,
): ImportPlan {
  // `ImportPlan.source.kind` is narrowed to csv / xlsx / json. We coerce
  // the dispatcher's wider FileKind back into that union; geojson will
  // land on csv until that adapter ships, which keeps preview running.
  const planKind: 'csv' | 'xlsx' | 'json' =
    fileKind === 'xlsx' ? 'xlsx' : fileKind === 'json' ? 'json' : 'csv'
  return {
    source: { kind: planKind, name: '', size: parsed.totalBytes },
    columns: parsed.columns,
    match,
    fieldMapping,
    zoneId,
  }
}

function matchColumns(m: MatchStrategy): string[] {
  switch (m.mode) {
    case 'externalCode': return [m.column].filter(Boolean)
    case 'shapeName':    return [m.column].filter(Boolean)
    case 'binLabel':     return [m.column].filter(Boolean)
    case 'gridCellAddress':
      return [m.gridColumn, m.rowColumn, m.colColumn, m.levelColumn]
        .filter((c): c is string => typeof c === 'string' && c.length > 0)
  }
}

function stripMatchColumns(
  mapping: Record<string, FieldTarget>,
  matchCols: string[],
): Record<string, FieldTarget> {
  const out: Record<string, FieldTarget> = {}
  for (const [k, v] of Object.entries(mapping)) {
    if (!matchCols.includes(k)) out[k] = v
  }
  return out
}

function isMatchValid(m: MatchStrategy): boolean {
  switch (m.mode) {
    case 'externalCode': return m.column.length > 0
    case 'shapeName':    return m.column.length > 0
    case 'binLabel':     return m.column.length > 0
    case 'gridCellAddress':
      return [m.gridColumn, m.rowColumn, m.colColumn].every((c) => c.length > 0)
  }
}

function canAdvance(
  step: Step,
  parsed: ParsedFile | null,
  matchValid: boolean,
  preview: PreviewResult | null,
  shapesPreview: ShapeImportPreview | null,
): boolean {
  if (step === 'file') return parsed !== null
  if (step === 'geojson-mode') return false // navigation happens via the two mode buttons
  if (step === 'match') return matchValid
  if (step === 'map') return true
  if (step === 'preview') return (preview?.totals.rowsRead ?? 0) > 0
  if (step === 'shapes-preview') {
    const totals = shapesPreview?.totals
    return !!totals && totals.polygons + totals.lines + totals.markers > 0
  }
  return false
}

function goBack(step: Step, setStep: (s: Step) => void): void {
  const back: Record<Step, Step> = {
    file:            'file',
    'geojson-mode':  'file',
    match:           'file',
    map:             'match',
    preview:         'map',
    'shapes-preview':'geojson-mode',
    done:            'done',
  }
  setStep(back[step])
}

function mappingToWireFormat(
  mapping: Record<string, FieldTarget>,
  match: MatchStrategy,
): Record<string, string> {
  const out: Record<string, string> = {}
  switch (match.mode) {
    case 'externalCode':
      out[match.column] = 'match.externalCode'
      break
    case 'shapeName':
      out[match.column] = `match.shapeName:${match.kind}`
      break
    case 'gridCellAddress':
      out[match.gridColumn] = `match.gridCell:${match.gridColumnIs}`
      out[match.rowColumn] = 'match.gridCell.row'
      out[match.colColumn] = 'match.gridCell.col'
      if (match.levelColumn) out[match.levelColumn] = 'match.gridCell.level'
      break
    case 'binLabel':
      out[match.column] = 'match.binLabel'
      break
  }
  for (const [col, t] of Object.entries(mapping)) {
    if (out[col] !== undefined) continue
    if (t.kind === 'ignore') continue
    if (t.kind === 'builtin') out[col] = `bin.${t.field}`
    if (t.kind === 'custom') out[col] = `prop.${t.key}`
  }
  return out
}

// Local re-exports — keep this file self-contained at the top while the
// underlying components live in sibling files.
import { FieldMapper } from './field-mapper'
import { ImportPreview } from './import-preview'
import { SampleDownloadMenu } from './sample-download-menu'
function FieldMapperBlock(props: Parameters<typeof FieldMapper>[0]) {
  return <FieldMapper {...props} />
}
function ImportPreviewBlock(props: Parameters<typeof ImportPreview>[0]) {
  return <ImportPreview {...props} />
}

/** Tiny await helper for the webhook drain long-poll. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}
