import { Suspense, lazy, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'

import type { Map as MapboxMapInstance } from 'mapbox-gl'

import { BinEditor } from '@/components/bin-editor'
import {
  BulkAssignDialog,
  type BulkAssignPatch,
  type BulkAssignSelection,
} from '@/components/bulk-assign-dialog'
import { ImportDialog } from '@/components/data-link/import-dialog'
import { ModelLibraryDialog } from '@/components/model-library-dialog'
import { parseGlbInspector, type ModelBounds } from '@/lib/glb-bounds'
import { useModelAssets } from '@/lib/model-assets'
import { PlaceSearcher } from '@/components/place-searcher'
import { SchemaBuilder } from '@/components/schema-builder'
import { ShapeDataEditor, type ShapeEditorTarget } from '@/components/shape-data-editor'
import { ShareLinkDialog } from '@/components/share-link-dialog'
import type { DataLinkConfig, Grid, Zone } from '@/lib/db'
import type { DoorShape } from '@/lib/door/types'
import type { Tool } from '@/lib/keyboard-shortcuts'
import type {
  CircleShape,
  ImagePlaneShape,
  ImageShape,
  LineShape,
  MarkerShape,
  ModelShape,
  ModelShapeConfig,
  PolygonShape,
  StairShape,
  TextLabelShape,
} from '@/lib/shapes'
import { patchSpatialEntity } from '@/lib/spatial-store'

// Data-link dialogs are code-split so lucide-react's ~200 KB gzipped
// (1714 icons) doesn't ship in the main bundle. React.lazy loads the
// chunk when the user opens either dialog for the first time.
// See DESIGN-data-link-v2.md (bundle size follow-up).
const DataLinkEditorDialog = lazy(() =>
  import('@/components/data-link/data-link-editor-v3').then((mod) => ({
    default: mod.DataLinkEditorV3Dialog,
  })),
)
const DataLinkManagerDialog = lazy(() =>
  import('@/components/data-link/data-link-manager').then((mod) => ({
    default: mod.DataLinkManagerDialog,
  })),
)

type SelectedBin =
  | { gridId: number; row: number; col: number; level: number }
  | null

/**
 * Modal cluster mounted after every overlay + panel. Each dialog is
 * portalled by its own Radix root, so mount order doesn't affect
 * z-index; grouping them together just tidies the JSX.
 *
 * Data-link editor + manager share one `Suspense` boundary because
 * they resolve to the same lazy chunk — mounting a second
 * `<Suspense>` would double-fetch on first open. The `key` on
 * `<DataLinkEditorDialog>` forces a remount when the user swaps
 * edit targets so its internal `useState` re-initialises from the
 * new `existing` prop.
 *
 * `<ModelLibraryDialog>` is the tricky one: its close-handler
 * distinguishes "pick then close" from "dismiss" via the
 * `modelLibraryPickedRef` flag set inside `onSelect` — reading
 * `modelConfig.modelAssetId` inside `onOpenChange` would race the
 * queued state update.
 */
export function EditorDialogs({
  mapInstance,
  language,
  placeSearchClassName,
  activeTool,
  activeWarehouseId,
  activeWarehouse,
  // Import
  dataLinkOpen,
  setDataLinkOpen,
  // Data-link editor + manager (lazy)
  dataLinkEditorOpen,
  setDataLinkEditorOpen,
  dataLinkManagerOpen,
  setDataLinkManagerOpen,
  editingDataLinkId,
  editingDataLink,
  setEditingDataLinkId,
  // Schema builder
  schemaBuilderOpen,
  setSchemaBuilderOpen,
  // Share link
  shareLinkDialogOpen,
  setShareLinkDialogOpen,
  savedImages,
  savedDataLinks,
  // Bulk assign
  bulkAssignOpen,
  setBulkAssignOpen,
  selectedGridIds,
  selectedMarkerIds,
  selectedCircleIds,
  selectedPolygonIds,
  selectedLineIds,
  selectedModelIds,
  selectedStairIds,
  selectedTextLabelIds,
  selectedDoorIds,
  selectedImageIds,
  selectedImagePlaneIds,
  savedGrids,
  savedMarkers,
  savedCircles,
  savedPolygons,
  savedLines,
  savedModels,
  savedStairs,
  savedTextLabels,
  scopedDoors,
  savedImagePlanes,
  savedZones,
  onApplyBulkAssign,
  // Model library
  modelLibraryOpen,
  setModelLibraryOpen,
  modelLibraryMode,
  setModelLibraryMode,
  modelLibraryPickedRef,
  selectedModel,
  setModelConfig,
  setActiveTool,
  // Bin editor
  selectedBin,
  binDialogOpen,
  setBinDialogOpen,
  setSelectedBin,
  // Shape data editor
  shapeEditorTarget,
  shapeEditorOpen,
  setShapeEditorOpen,
  setShapeEditorTarget,
}: {
  mapInstance: MapboxMapInstance | null
  language: string
  placeSearchClassName?: string
  activeTool: Tool
  activeWarehouseId: number | null
  activeWarehouse: Zone | null
  // Import
  dataLinkOpen: boolean
  setDataLinkOpen: Dispatch<SetStateAction<boolean>>
  // Data-link editor + manager (lazy)
  dataLinkEditorOpen: boolean
  setDataLinkEditorOpen: Dispatch<SetStateAction<boolean>>
  dataLinkManagerOpen: boolean
  setDataLinkManagerOpen: Dispatch<SetStateAction<boolean>>
  editingDataLinkId: number | null
  editingDataLink: DataLinkConfig | null
  setEditingDataLinkId: Dispatch<SetStateAction<number | null>>
  // Schema builder
  schemaBuilderOpen: boolean
  setSchemaBuilderOpen: Dispatch<SetStateAction<boolean>>
  // Share link
  shareLinkDialogOpen: boolean
  setShareLinkDialogOpen: Dispatch<SetStateAction<boolean>>
  savedImages: ImageShape[]
  savedDataLinks: DataLinkConfig[]
  // Bulk assign
  bulkAssignOpen: boolean
  setBulkAssignOpen: Dispatch<SetStateAction<boolean>>
  selectedGridIds: Set<number>
  selectedMarkerIds: Set<number>
  selectedCircleIds: Set<number>
  selectedPolygonIds: Set<number>
  selectedLineIds: Set<number>
  selectedModelIds: Set<number>
  selectedStairIds: Set<number>
  selectedTextLabelIds: Set<number>
  selectedDoorIds: Set<number>
  selectedImageIds: Set<number>
  selectedImagePlaneIds: Set<number>
  savedGrids: ReadonlyArray<Grid>
  savedMarkers: MarkerShape[]
  savedCircles: CircleShape[]
  savedPolygons: PolygonShape[]
  savedLines: LineShape[]
  savedModels: ModelShape[]
  savedStairs: StairShape[]
  savedTextLabels: TextLabelShape[]
  scopedDoors: DoorShape[]
  savedImagePlanes: ImagePlaneShape[]
  savedZones: Zone[]
  onApplyBulkAssign: (
    selection: BulkAssignSelection,
    patch: BulkAssignPatch,
  ) => Promise<void>
  // Model library
  modelLibraryOpen: boolean
  setModelLibraryOpen: Dispatch<SetStateAction<boolean>>
  modelLibraryMode: 'place' | 'swap'
  setModelLibraryMode: Dispatch<SetStateAction<'place' | 'swap'>>
  modelLibraryPickedRef: MutableRefObject<boolean>
  selectedModel: ModelShape | null
  setModelConfig: Dispatch<SetStateAction<ModelShapeConfig>>
  setActiveTool: Dispatch<SetStateAction<Tool>>
  // Bin editor
  selectedBin: SelectedBin
  binDialogOpen: boolean
  setBinDialogOpen: Dispatch<SetStateAction<boolean>>
  setSelectedBin: Dispatch<SetStateAction<SelectedBin>>
  // Shape data editor
  shapeEditorTarget: ShapeEditorTarget | null
  shapeEditorOpen: boolean
  setShapeEditorOpen: Dispatch<SetStateAction<boolean>>
  setShapeEditorTarget: Dispatch<SetStateAction<ShapeEditorTarget | null>>
}) {
  // Every asset (bundled + uploaded) with its per-asset `defaultScale`.
  // Consumed in the model-library `onSelect` handler so newly-picked
  // assets pre-fill the tool's scale slider with a size the model
  // author intended (or, for uploads, the size we auto-normalised to
  // at upload time — see `addUploadedModel`). Without this, every
  // pick reset `scale` to `[1, 1, 1]`, which for mm-authored GLBs
  // ended up covering a park at world scale.
  const modelAssets = useModelAssets()
  return (
    <>
      <ImportDialog
        open={dataLinkOpen}
        onOpenChange={setDataLinkOpen}
      />

      {/* Data-link editor dialog + manager (v2). Both are React.lazy'd
          to keep lucide-react out of the main chunk. A single Suspense
          fallback covers both — they share the split chunk. */}
      {activeWarehouseId !== null && (
        <Suspense fallback={null}>
          {(dataLinkEditorOpen || dataLinkManagerOpen) && (
            <>
              {/* key forces a remount so useState re-initialises from
                  `existing` when switching between edit targets. Without
                  it, editing a saved layer shows empty inputs. */}
              <DataLinkEditorDialog
                key={`dl-editor-${editingDataLinkId ?? 'new'}-${dataLinkEditorOpen}`}
                open={dataLinkEditorOpen}
                onOpenChange={(open) => {
                  setDataLinkEditorOpen(open)
                  if (!open) setEditingDataLinkId(null)
                }}
                zoneId={activeWarehouseId}
                existing={editingDataLink}
              />
              <DataLinkManagerDialog
                open={dataLinkManagerOpen}
                onOpenChange={setDataLinkManagerOpen}
                zoneId={activeWarehouseId}
              />
            </>
          )}
        </Suspense>
      )}

      <SchemaBuilder
        open={schemaBuilderOpen}
        onOpenChange={setSchemaBuilderOpen}
        zoneId={activeWarehouseId ?? undefined}
      />

      {/* Rich share-link dialog. Mounted only when a warehouse is
          active — `activeWarehouse` is the resolved zone row and
          `savedImages` / `savedDataLinks` are already scoped to the
          current warehouse by `scopeToWarehouse()`. */}
      {activeWarehouse && activeWarehouse.id !== undefined && shareLinkDialogOpen && (
        <ShareLinkDialog
          open={shareLinkDialogOpen}
          onOpenChange={setShareLinkDialogOpen}
          zone={{ id: activeWarehouse.id, name: activeWarehouse.name }}
          floorPlans={
            savedImages.filter(
              (img): img is ImageShape & { id: number } => img.id !== undefined,
            )
          }
          dataLinkConfigs={savedDataLinks}
        />
      )}

      {/* Mounted only while open: it builds item lists over every shape,
          and a closed-but-mounted dialog redid that on every edit. */}
      {bulkAssignOpen && (
      <BulkAssignDialog
        open={bulkAssignOpen}
        onOpenChange={setBulkAssignOpen}
        // Pre-check whatever the user already had selected on the map
        // — keeps the common single-selection flow fast (open dialog,
        // pick destination, apply). Images ARE assignable (see the
        // dialog's Kind comment) so seed them from the current image
        // selection too.
        initialSelection={{
          grid: selectedGridIds,
          marker: selectedMarkerIds,
          circle: selectedCircleIds,
          polygon: selectedPolygonIds,
          line: selectedLineIds,
          model: selectedModelIds,
          stair: selectedStairIds,
          text: selectedTextLabelIds,
          door: selectedDoorIds,
          image: selectedImageIds,
          imagePlane: selectedImagePlaneIds,
        }}
        grids={savedGrids}
        markers={savedMarkers}
        circles={savedCircles}
        polygons={savedPolygons}
        lines={savedLines}
        // Images serve two roles in this dialog: assignable items
        // (they can be moved between warehouses / re-pinned to a
        // different floor plan for multi-storey stacks) AND the
        // "Floor plan" destination dropdown. Self-referential
        // assignments are filtered inside the dialog before Apply.
        images={savedImages}
        models={savedModels}
        stairs={savedStairs}
        textLabels={savedTextLabels}
        doors={scopedDoors}
        imagePlanes={savedImagePlanes}
        zones={savedZones}
        onApply={onApplyBulkAssign}
      />
      )}

      {/* Mounted only while open (it re-rendered on every edit, and
          fetched the model catalog on every editor load). */}
      {modelLibraryOpen && (
      <ModelLibraryDialog
        open={modelLibraryOpen}
        zoneId={activeWarehouseId}
        mode={modelLibraryMode === 'swap' ? 'swap' : 'place'}
        currentAssetId={modelLibraryMode === 'swap' ? selectedModel?.config?.modelAssetId : undefined}
        onOpenChange={(next) => {
          setModelLibraryOpen(next)
          if (!next) {
            // Was this close triggered by a pick or by a real dismiss?
            // The dialog closes on both paths; only the dismiss path
            // should kick the user out of place-mode.
            const wasPick = modelLibraryPickedRef.current
            modelLibraryPickedRef.current = false
            if (
              !wasPick &&
              modelLibraryMode === 'place' &&
              activeTool === 'create-model'
            ) {
              setActiveTool('pan')
              // Forget the staged asset too — otherwise re-entering the
              // tool would silently resume the old pick.
              setModelConfig((cfg) => ({ ...cfg, modelAssetId: undefined }))
            }
            // Reset to 'place' mode whenever the dialog closes so the
            // next open enters the placement flow by default.
            setModelLibraryMode('place')
          }
        }}
        onSelect={(assetId) => {
          // Flag the close that's about to come from `onOpenChange(false)`
          // so it doesn't read stale state and undo this pick.
          modelLibraryPickedRef.current = true
          const pickedAsset = modelAssets.find((a) => a.id === assetId)
          const ds = pickedAsset?.defaultScale ?? 1
          const cachedBounds = pickedAsset?.inspector?.bounds
          const applyScale = (bounds: ModelBounds | null | undefined) => {
            // Normalise wildly-off models to a sensible on-screen size
            // (~3 m tallest dimension). Without this the "Warehouse
            // shelving (rusty)" GLB — authored at ~200 m scale —
            // renders as a giant wall filling the map. Only kicks in
            // when the raw model is more than ~3× off target so we
            // don't over-scale reasonable meshes.
            const TARGET_SIZE_M = 3
            let normFactor = 1
            if (bounds) {
              const rawSize = Math.max(
                bounds.max[0] - bounds.min[0],
                bounds.max[1] - bounds.min[1],
                bounds.max[2] - bounds.min[2],
              )
              if (rawSize > 0) {
                const scaled = rawSize * ds
                if (scaled > TARGET_SIZE_M * 3 || scaled < TARGET_SIZE_M / 10) {
                  normFactor = TARGET_SIZE_M / scaled
                }
              }
            }
            const finalScale = ds * normFactor
            const scaleTriplet: [number, number, number] = [
              finalScale,
              finalScale,
              finalScale,
            ]
            if (modelLibraryMode === 'swap' && selectedModel?.id !== undefined) {
              void patchSpatialEntity('models', selectedModel.id, {
                config: {
                  ...selectedModel.config,
                  modelAssetId: assetId,
                  // Reset scale to the new asset's default — otherwise
                  // swapping a metre-scale GLB for a mm-scale one
                  // would keep the previous scale multiplier and blow
                  // the model up 1000×.
                  scale: scaleTriplet,
                },
                updatedAt: new Date(),
              })
            } else {
              // Stash the picked asset on the modelConfig draft and
              // switch into place-mode. The placement effect picks
              // this up and starts listening for the next map click.
              setModelConfig((cfg) => ({
                ...cfg,
                modelAssetId: assetId,
                scale: scaleTriplet,
              }))
              if (activeTool !== 'create-model') setActiveTool('create-model')
            }
            setModelLibraryMode('place')
          }
          if (cachedBounds) {
            applyScale(cachedBounds)
          } else if (pickedAsset?.url) {
            // Bundled models don't have their inspector cached until
            // first fetched — the library dialog doesn't preload them.
            // Fire off the parse now so scale normalisation runs on
            // fresh picks too. Falls back to `ds` alone if parse fails.
            void (async () => {
              try {
                const r = await fetch(pickedAsset.url)
                if (!r.ok) return applyScale(undefined)
                const blob = await r.blob()
                const inspector = await parseGlbInspector(blob)
                applyScale(inspector?.bounds ?? undefined)
              } catch {
                applyScale(undefined)
              }
            })()
          } else {
            applyScale(undefined)
          }
        }}
      />
      )}

      <BinEditor
        selection={selectedBin}
        open={binDialogOpen && selectedBin !== null}
        onOpenChange={setBinDialogOpen}
        onLevelChange={(level) =>
          setSelectedBin((prev) => (prev ? { ...prev, level } : prev))
        }
      />

      <ShapeDataEditor
        target={shapeEditorTarget}
        open={shapeEditorOpen && shapeEditorTarget !== null}
        onOpenChange={(open) => {
          setShapeEditorOpen(open)
          if (!open) setShapeEditorTarget(null)
        }}
      />

      <PlaceSearcher map={mapInstance} language={language} className={placeSearchClassName} />
    </>
  )
}
