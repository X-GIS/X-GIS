# @xgis/map — published declaration surface

GENERATED FILE — do not hand-edit. Re-bake with `bun run bake:map-surface` and commit the diff.

Every declaration in `map/dist/index.d.ts`, the bundle `map/scripts/build-dts.ts`
produces from `map/src/public.ts`. `*` marks a name the bundle re-exports; the rest
are support types folded in from the sibling `@xgis/*` packages and reachable only
through an exported one. Members are names, not signatures — see the header of
`scripts/map-public-surface.test.ts` for why.

- declarations: 463
- exported names: 50
- members: 2625 (plus 751 `private` name slots)
- `@internal` tags surviving into the bundle: 1

## Exported

```
Camera
CapSpan
ComputeDispatcher
ComputeTask
FrameRenderer
MapRendererContent
Marker
MarkerAnchor
MarkerOptions
PMTilesArchiveSource
PMTilesSourceOptions
PolarCapFeatureCollection
PolarCapOptions
Popup
PopupOptions
RUNTIME_CAPABILITIES
RenderStats
RuntimeCapability
StatsPanel
StatsTracker
TileJSONSource
VectorLayerInfo
VectorTileFormat
VectorTileLoader
VectorTileSource
XGISMap
XGISMapElement
attachPMTilesSource
availableRamps
createColorRampTexture
createRampSampler
equirectangular
fetchPMTilesVectorLayerFields
fetchPMTilesVectorLayerSchema
findClampBoundarySpans
getProjection
injectPolarCaps
loadGeoJSON
loadPMTilesSource
lonLatToMercator
mercator
naturalEarth
orthographic
projectionNeedsPolarCaps
registerXGISElement
runtimeCapability
runtimeGaps
synthesizeCapRing
synthesizePolarCaps
vertexOnClampBoundary
```

## Declarations

```
type AddressSpace
interface AdvectedArrowInput
  bandTable
  grid
  priority
interface AdvectedArrowSource
  arrowBindingFor
type ArrayAccess
type ArrayLiteral
interface ArrowDrawSpec
  data
  getBearing
  getColor
  getPosition
  getSize
  type
  updateTriggers
type ArrowPaint
interface ArrowPaint$1
  arrowBearing
  arrowBearingExpr
  isArrow
const ASSEMBLED_AS
interface AtlasConfig
  pageSize
  slotSize
interface AtlasSlot
  cellX
  cellY
  page
  pxX
  pxY
  size
class AtlasState
  constructor
  ensure
  get capacity
  get freeCount
  get pageCount
  get size
  get stats
  peek
  private allocatePage
  private cfg
  private entries
  private evictionCount
  private fontIdKey
  private fontKeyId
  private freeSlots
  private hitCount
  private keyToNum
  private missCount
  private nextFontId
  private pageCountInternal
  private slotsPerPage
  private slotsPerRow
  touch
function attachPMTilesSource *
function availableRamps *
type BackendChoice
interface BackendTileResult
  bases
  dequantHalf
  dequantScale
  featureProps
  fullCover
  fullCoverFeatureId
  heights
  indices
  lineIndices
  lineVertices
  outlineIndices
  outlineLineIndices
  outlineVertices
  pointFeatureIds
  pointVertices
  polygons
  prebuiltLineSegments
  prebuiltOutlineSegments
  vertices
type BackgroundStatement
interface BadgeHalfExtents
  hh
  hw
type BandKind
type Bbox
type BinaryExpr
interface BindingDecl
  access
  binding
  glsl
  group
  name
  owner
  precision
  space
  type
type BinOp
type BlockProperty
interface Body
  a
  b
  e2
  f
  meanRadius
  name
  sphereR
  worldMerc
type BoolLiteral
interface CachedArchive
  archive
  archiveName
  attribution
  header
  vectorLayers
interface CachedPipeline
  fillPipeline
  fillPipelineExtruded
  fillPipelineExtrudedFallback
  fillPipelineExtrudedFallbackNoPick
  fillPipelineExtrudedNoPick
  fillPipelineFallback
  fillPipelineFallbackNoPick
  fillPipelineGround
  fillPipelineGroundFallback
  fillPipelineGroundFallbackNoPick
  fillPipelineGroundNoPick
  fillPipelineNoPick
  linePipeline
  linePipelineFallback
  linePipelineFallbackNoPick
  linePipelineNoPick
interface CachedTileJSON
  attribution
  bounds
  maxzoom
  minzoom
  name
  tilesTemplate
  vectorLayers
class Camera *
  FOV
  azimuthalProjType
  bearing
  buildMatrixAndGetGeneration
  centerLatDeg
  centerX
  centerY
  constructor
  discDragAnchorAt
  effectiveMpp
  get pitch
  getDebugSnapshot
  getECEFCenter
  getECEFFrameView
  getECEFToENURotation
  getFrameView
  getMatrix
  getRTCMatrix
  getRTCMatrixInverse
  getViewForProjection
  getVisibleWorldCopies
  globeMode
  globeOrtho
  maxZoom
  minZoom
  pan
  panDiscToScreenAnchor
  panToScreenAnchor
  pitchLocked
  private MAX_Y
  private _buildRTCMatrix
  private _cacheBearing
  private _cacheCap
  private _cacheCx
  private _cacheCy
  private _cacheDpr
  private _cacheFar
  private _cacheH
  private _cachePitch
  private _cacheW
  private _cacheZoom
  private _carryCenterLatThroughZoom
  private _ecefCacheBearing
  private _ecefCacheCx
  private _ecefCacheCy
  private _ecefCacheDpr
  private _ecefCacheFar
  private _ecefCacheH
  private _ecefCachePitch
  private _ecefCacheW
  private _ecefCacheZoom
  private _globeCacheAziProj
  private _globeCacheBearing
  private _globeCacheCx
  private _globeCacheCy
  private _globeCacheDpr
  private _globeCacheEye
  private _globeCacheFar
  private _globeCacheH
  private _globeCacheLat
  private _globeCacheOrtho
  private _globeCachePitch
  private _globeCacheW
  private _globeCacheZoom
  private _globeFrame
  private _globeFrameOut
  private _globeGeneration
  private _globeMatrix
  private _invDirty
  private _maxBoundsMerc
  private _mvpGeneration
  private _pitch
  private _relToLonLat
  private _setDiscCenterLat
  private _syncCenterLatFromMercator
  private _view
  private _viewScratch
  private _vwcCache
  private clampCenterToBounds
  private maxCameraY
  private rtcMatrix
  private rtcMatrixECEF
  private rtcMatrixInv
  projType
  resetBearing
  rotate
  set pitch
  setMaxBoundsMerc
  setProjection
  syncCenterLat
  unprojectToLonLat
  unprojectToMercatorAnchor
  unprojectToZ0
  zoom
  zoomAt
interface CameraTraceSnapshot
  bearing
  centerLat
  centerLon
  dpr
  pitch
  projection
  viewportHeightPx
  viewportWidthPx
  zoom
interface CamSig
  bearing
  canvasHeight
  canvasWidth
  centerX
  centerY
  dpr
  pitch
  proj
  projCenterLat
  projCenterLon
  zoom
type Capability
interface CapSpan *
  arcDeg
  endIdx
  endLon
  pole
  startIdx
  startLon
interface CircleDrawSpec
  data
  getColor
  getPosition
  getRadius
  getStrokeColor
  getStrokeWidth
  type
  updateTriggers
interface CirclePaint
  circleStrokeOpacityShape
interface CirclePaint$1
  circleBlur
  circlePitchAlignmentMap
  circlePitchScaleMap
  circleStrokeOpacityShape
  circleTranslateX
  circleTranslateXShape
  circleTranslateY
  circleTranslateYShape
interface CircleShapes
  size
type ClassifiedShow
interface ClassifiedShow$1
  draw
  fillPhase
  isTranslucentStroke
  resolvedShow
  show
  sourceName
type CmpOp
interface CollisionBbox
  maxX
  maxY
  minX
  minY
interface CollisionCircle
  r
  x
  y
interface CollisionObstacle
  bbox
  circles
  groupKey
interface ColorAxis
  get
  set
interface ColorGradient
  base
  stops
type ColorLiteral
interface CommonPaintShapes
  opacity
interface CompiledTile
  dequantHalf
  dequantScale
  featureCount
  fullCover
  fullCoverFeatureId
  indices
  lineIndices
  lineVertices
  outlineIndices
  outlineLineIndices
  outlineVertices
  pointVertices
  polygons
  tileOriginMerc
  tileSouth
  tileWest
  vertices
  x
  y
  z
interface CompiledTileSet
  bounds
  featureCount
  levels
  propertyTable
interface ComputeBindEntry
  binding
  resource
class ComputeDispatcher *
  constructor
  createBuffer
  createCountBuffer
  createFeatDataBuffer
  createOutColorBuffer
  dispatch
  dispatchKernel
  dispatchKernelRhi
  getOrCreateKernelPipeline
  getOrCreatePipeline
  private _dispatchBGCache
  private _kernelBGCache
  private device
  private pipelineCache
  uploadFeatData
  writeCount
interface ComputeKernel
  categoryOrder
  module
interface ComputeKernelContract
  dispatchSize
  entryPoint
  featureStrideF32
  fieldOrder
class ComputeLayerHandle
  constructor
  destroy
  dispatch
  get kernelCount
  getBindGroupEntries
  private renderNodeIndex
  private resources
  private variant
  uploadFromProps
class ComputeLayerRegistry
  attach
  constructor
  destroyAll
  detach
  dispatchAll
  get size
  getHandle
  keys
  private dispatcher
  private handles
interface ComputeOutputBindingSpec
  bindGroup
  binding
  paintAxis
type ComputeOutputPaintAxis
interface ComputePlanEntry
  categoryOrder
  fieldOrder
  kernel
  paintAxis
  renderNodeIndex
interface ComputeTask *
  featureCount
  inputBuffer
  outputBuffer
  shader
  workgroupSize
type ComputeTimestampProvider
type ConditionalExpr
interface ConstDecl
  cpuValue
  name
  type
  valueExpr
  wgslValue
interface CooperativeGesturesOptions
  macHelpText
  mobileHelpText
  windowsHelpText
interface CoverageArmOptions
  bandIndex
  filter
  flowOnly
  hidden
  opacity
  priority
  ramp
  rangeHi
  rangeLo
interface CoverageBandHeader
  kind
  max
  min
  name
  nodata
  offset
  scale
  unit
class CoverageHandle
  band
  bands
  constructor
  get meta
  header
  valueAt
interface CoverageHeader
  bands
  crs
  origin
  product
  registration
  size
  sourceMeta
  spacing
  time
  vertical
interface CoverageRegionData
  handle
  url
class CoverageRenderer
  clear
  clearRegion
  constructor
  displayOpts
  dispose
  drapedFlowFields
  flowField
  flowFields
  hasCoverage
  hasFlowField
  onRegionDropped
  private armFilter
  private arms
  private budgetBytes
  private dataSampler
  private draperFor
  private drapers
  private drawOrder
  private ensureDraper
  private ensureIndexBuf
  private evictOverBudget
  private format
  private groupFor
  private indexBuf
  private lastOpts
  private lutSampler
  private releaseRegion
  private rhi
  private states
  private uploadLut
  private uploadNodes
  private uploadR16f
  private uploadR16fFrom
  rebuildForQuality
  render
  residentRegions
  setCoverage
function createColorRampTexture *
function createRampSampler *
interface CurvedGroundArgs
  basis
  liveX
  liveY
  sizeScale
interface DashConfig
  array
  offset
interface DataExpr
  ast
  classification
type DeclarableCapability
interface DecodedBand
  codes
  header
  values
interface DemUnpack
  baseShift
  blueFactor
  greenFactor
  redFactor
interface DirtyGlyph
  key
  sdf
  slot
type DispatchKernel
interface DrapeOverzoomDiag
  currentZ
  deviceZoom
  emitted
  missingParents
  omittedEmpty
  reason
  sample
  selected
  split
  uploadedParents
  virtualZ
interface DrawHandle
  append
  count
  remove
  update
type DrawSpec
interface DrawStatsSnapshot
  drawCalls
  drawnByZoom
  globeTilesSelected
  lines
  missedTiles
  tilesVisible
  triangles
  vertices
interface DumpedLabel
  anchorX
  anchorY
  curved
  fontSize
  glyphs
  slotSize
  text
  vertical
type Easing
type ECEF
interface EnsureResult
  created
  evictedKey
  slot
interface EnsureResult$1
  colorView
  colorViewScreen
  sceneColorSampleView
  sceneResolveView
  sceneScaled
  useResolve
function equirectangular *
type Expr
type Expr$1
type Expr$2
type ExprClass
interface ExternVarDecl
  name
  spelling
  stage
  type
interface ExtrudePaint
  extrude
  extrudeBase
interface ExtrudePaint$1
  extrude
  extrudeBase
  fillExtrusionVerticalGradient
type ExtrudeValue
interface FadeRef
  a
class FailedTileLedger
  clear
  clearAll
  get size
  hasPendingRetries
  noteOutcome
  private failed
  requestable
interface Feature
  geometry
  id
  properties
  type
interface Feature$1
  geometry
  id
  properties
  type
interface FeatureCollection
  features
  type
type FeaturePropertyBag
type FeatureProps
interface FeatureRange
  indexCount
  indexOffset
  properties
function fetchPMTilesVectorLayerFields *
function fetchPMTilesVectorLayerSchema *
type FieldAccess
interface FieldViewGrid
  invSpanLat
  invSpanLon
  originLat
  originLon
type FillAntialiasValue
interface FillPaint
  fillPattern
  fillPatternRepeatM
  fillPatternUV
  resolvedFillRgba
interface FillPaint$1
  fill
  fillAntialias
  fillColorExpr
  fillPattern
  fillTranslateAnchorMap
  fillTranslateX
  fillTranslateXShape
  fillTranslateY
  fillTranslateYShape
interface FillRhiState
  extrude
  flat
  ground
  pattern
  perStyle
  perStyleByLabel
  perStyleExtrude
  perStyleExtrudeByLabel
  pipes
  split
interface FillShapes
  fill
function findClampBoundarySpans *
interface FlowDrape
  mix
  viewFor
interface FlowFieldRegion
  height
  midLatDeg
  scale
  spanDeg
  u
  v
  valid
  width
interface FlowFrame
  elapsedMs
  encoder
type FlowPaint
interface FlowPaint$1
  flowPortrayal
  isFlow
class FlowRenderer
  arrowBindingFor
  constructor
  dispose
  private arrowFields
  private begin
  private bindGroupFor
  private clearView
  private draper
  private draperFormat
  private ensureDraper
  private nearest
  private rhi
  private sampler
  private trailFor
  private trails
  setArrowFields
  setTrailRegions
  step
  trailViewFor
interface FlowStepOptions
  decay
  inject
  ratePerSec
type FnCall
type FnStatement
type FontTypographyMap
interface FormatSpec
  align
  alt
  fill
  grouping
  locale
  precision
  sign
  type
  width
  zero
interface FrameContext
  camera
  elapsedMs
  frameCount
  overdraw
  passScope
  projection
  rhi
  rhiColorView
  rhiColorViewScreen
  rhiEncoder
  rhiSceneColorSampleView
  rhiSceneResolveView
  rhiScreenView
  rhiStencilView
  rt
  sampleCount
  scene
  screen
  useResolve
class FrameDrawStats
  beginFrame
  clearDecisionCounts
  drawnByZoom
  getDrawStats
  getLastDecisionCounts
  hasDrawn
  hasWarned
  incDecisionCount
  markDrawn
  markWarned
  missed
  needed
  private _dirtyKeys
  private _frameDrawCalls
  private _frameDrawnByZoom
  private _frameGlobeTilesSelected
  private _frameLines
  private _frameTilesVisible
  private _frameTriangles
  private _frameVertices
  private _lastDecisionCounts
  private _missedTiles
  private lastTracePhase
  private lastTraceSlice
  private renderedDraws
  private tileDropWarnings
  recordMissedTile
  recordMissedTiles
  resetRenderedDraws
  setGlobeTilesSelected
  setTrace
  tracePhase
  traceSlice
class FrameRenderer *
  PALETTE_LAYOUT_ENTRIES
  SPLIT_FILL_LAYOUT_ENTRIES
  allocUniformSlot
  beginFrame
  cacheVariantPipelines
  constructor
  destroy
  dispatchComputePass
  drawOitCompose
  endFrame
  ensureComputeRegistry
  ensureOverdrawCompose
  fillRhiState
  get bindGroupLayout
  get computePlan
  get featureBindGroupLayout
  get fillPipeline
  get fillPipelineExtruded
  get fillPipelineExtrudedFallback
  get fillPipelineExtrudedFallbackNoPick
  get fillPipelineExtrudedNoPick
  get fillPipelineExtrudedOIT
  get fillPipelineFallback
  get fillPipelineFallbackNoPick
  get fillPipelineGround
  get fillPipelineGroundFallback
  get fillPipelineGroundFallbackNoPick
  get fillPipelineGroundNoPick
  get fillPipelineNoPick
  get fillPipelineOverdraw
  get fillPipelineOverdrawFeature
  get fillPipelinePatternExtruded
  get fillPipelinePatternExtrudedFallback
  get fillPipelinePatternGround
  get fillPipelinePatternGroundFallback
  get linePipeline
  get linePipelineFallback
  get linePipelineFallbackNoPick
  get linePipelineNoPick
  get linePipelineOverdraw
  get oitComposeBindGroupLayout
  get oitComposePipeline
  get overdrawComposeBindGroupLayout
  get overdrawComposePipeline
  get paletteSampler
  get paletteStubTextureView
  get registry
  get spriteAtlasStubTextureView
  get uniformBuffer
  get uniformRingHandle
  getCachedVariant
  getFeatureLayoutEntries
  getOrBuildVariantLayout
  getOrCreateVariantPipelines
  initUniformRing
  prewarmShaderVariantsAsync
  private _pipelines
  private computeDispatcher
  private computeRegistry
  private ctx
  private currentComputePlan
  private uniformRing
  private variantComputeLayoutCache
  rebuildForQuality
  setComputePlan
  stageUniformSlot
interface FrameTileCache
  archiveAncestor
  camSig
  currentZ
  farBoost
  globeTilesSelected
  indexGeneration
  marginPx
  maxLevel
  neededKeys
  parentAtMaxLevel
  protectedAncestors
  tiles
  worldOffDeg
interface FrameTrace
  cameraBearing
  cameraCenter
  cameraPitch
  cameraZoom
  dpr
  labels
  layers
  projection
  tileLOD
  viewportPx
interface FuncDecl
  [ASSEMBLED_AS]
  allowEarlyReturn
  attrs
  body
  lintDisable
  name
  opaque
  params
  portable
  ret
  retAttr
  retBuiltin
  stage
  workgroupSize
interface GeoJSONFeature
  geometry
  id
  properties
  type
interface GeoJSONFeatureCollection
  features
  type
type GeoJSONGeometry
interface GeometryPart
  coords
  featureIndex
  maxLat
  maxLon
  minLat
  minLon
  point
  rings
  type
function getProjection *
module global
class GlyphAtlasGPU
  constructor
  destroy
  flush
  get pageCount
  get pageSizePx
  getPage
  pageView
  private ensurePage
  private host
  private label
  private page
  private pageSize
  private rhi
  private view
  sampler
interface GlyphAtlasGPUOptions
  label
  pageSize
class GlyphAtlasHost
  constructor
  consumeDirty
  consumeEvictions
  destroy
  ensure
  ensureString
  getGeneration
  hasAllGlyphs
  invalidate
  invalidateAll
  preloadString
  prewarm
  private _generation
  private assembleInfo
  private dirty
  private evictions
  private fontKeyId
  private fontSize
  private hasAllGlyphsAtGen
  private infoCache
  private metrics
  private metricsKey
  private nextFontId
  private preloadedAtGen
  private rasterizer
  private routeKey
  private sdfRadius
  private stale
  private stringInfoCache
  state
interface GlyphAtlasHostOptions
  fontSize
  sdfRadius
interface GlyphInfo
  advanceWidth
  bearingX
  bearingY
  codepoint
  height
  pbf
  rasterFontSize
  slot
  width
interface GlyphKey
  codepoint
  fontKey
  sdfRadius
interface GlyphProvider
  ensure
  get
  hasPendingLoads
  isResolved
interface GlyphRasterizer
  rasterize
interface GlyphRasterRequest
  codepoint
  fontKey
  fontSize
  sdfRadius
  slotSize
interface GlyphRasterResult
  advanceWidth
  bearingX
  bearingY
  codepoint
  fontKey
  height
  pbf
  rasterFontSize
  sdf
  sdfRadius
  width
interface GlyphShaper
  pageSize
  shape
interface GPUContext
  context
  device
  maxTextureDimension2D
interface GPUTile
  dequantHalf
  dequantScale
  extruded
  featureBindGroup
  featureDataBuffer
  indexBuffer
  indexCount
  lastUsedFrame
  lineIndexBuffer
  lineIndexCount
  lineSegmentBindGroup
  lineSegmentBuffer
  lineSegmentCount
  lineVertexBuffer
  outlineIndexBuffer
  outlineIndexCount
  outlineSegmentBindGroup
  outlineSegmentBuffer
  outlineSegmentCount
  polyIndexByteLength
  polyIndexOffset
  polyVertexByteLength
  polyVertexOffset
  tileHeight
  tileSouth
  tileWest
  tileWidth
  tileZoom
  uploadEpoch
  uploadTimeMs
  vertexBuffer
  zBuffer
  zBufferByteLength
  zBufferOffset
class GPUTimer
  beginFrame
  beginTimedPass
  computeWrites
  constructor
  dispose
  enabled
  getBreakdown
  getTimings
  insidePasses
  mark
  markRhi
  passWrites
  pollReadbacks
  private MAX_SAMPLES
  private _disposed
  private computeFirstMarker
  private computeRanThisFrame
  private firstPassMarkers
  private nextSubpassToAssign
  private parseComputeFrame
  private parseFrame
  private push
  private querySet
  private resolveBuf
  private segmentNames
  private segmentSamples
  private slots
  private subpassFirstMarkerIdx
  private totalMarkers
  private writeIdx
  resetTimings
  resolveOnEncoder
  resolveOnRhi
class GraphicsManager
  add
  addCompiledArrowLayer
  addImage
  attachDevice
  clearCompiledArrows
  destroyGpu
  getLastFrameDrawCalls
  getRenderTimeSamples
  getWriteCounts
  hasAdvectedArrows
  hasAnimatedGraphics
  hasAnyImage
  hasImage
  hasRetainedBatches
  hostAtlas
  private _blockView
  private _compiledArrows
  private _copyScratch
  private _featWrites
  private _lastFrameDrawCalls
  private _retired
  private _timeSamples
  private _tintWrites
  private applyDpr
  private atlas
  private batches
  private dpr
  private drapers
  private frameBlock
  private glyphShaper
  private makeBatch
  private materialise
  private materialiseText
  private registry
  private removeBatch
  private repaintHook
  private rhi
  private updateBatch
  removeImage
  renderRetained
  setAdvectedArrowSource
  setGlyphShaper
  setRenderTiming
  setRepaintHook
interface HeatmapColorStop
  offset
  rgba
type HeatmapPaint
interface HeatmapPaint$1
  heatmapColorStops
  heatmapIntensity
  heatmapOpacity
  heatmapRadius
  heatmapWeight
  isHeatmap
class HeatmapRenderer
  addLayer
  clearLayers
  constructor
  drawLayerAccumRhi
  ensureLayerComposeRhi
  hasLayers
  layerCount
  private _drapers
  private _frameArena
  private buildRampBytes
  private drapers
  private format
  private frameBlock
  private layers
  private packLayerBuffers
  private rhi
  private uniformBuffer
  rebuildForQuality
  renderChainRhi
  updateFrameUniform
class HeatmapTargets
  destroy
  ensureRhi
  get accumViewRhi
  get blurViewRhi
  private accumRhi
  private accumViewRhiV
  private blurRhi
  private blurViewRhiV
  private deviceRhi
  private heightRhi
  private widthRhi
interface HillshadeExtraSource
  altitude
  direction
  highlight
  shadow
interface HillshadeExtraSourceShape
  altitude
  direction
  highlight
  shadow
type HillshadeMethod
interface HillshadeParams
  accent
  altitude
  anchorMap
  bounds
  direction
  exaggeration
  extraSources
  highlight
  maxzoom
  method
  shadow
  tileSize
  unpack
class HillshadeRenderer
  beginFrame
  constructor
  destroy
  get failedTiles
  hasFadingTiles
  hasPendingLoads
  hasSource
  pendingLoadCount
  private _fadeDurationMs
  private _hasFadingTiles
  private _hillshadeDraper
  private _lastTargetKeys
  private _opacity
  private _params
  private _terrainExaggeration
  private dem
  private ensureHillshadeDraper
  private format
  private rhi
  rebuildForQuality
  render
  setHillshadeFadeDurationMs
  setOpacity
  setParams
  setTerrainExaggeration
  setUrlTemplate
  terrainExaggeration
interface HillshadeShapes
  accent
  altitude
  anchorMap
  direction
  exaggeration
  extraSources
  highlight
  method
  resamplingNearest
  shadow
interface HoldoverTransform
  dx
  dy
  scale
const HTMLElementBase
type IconAnchor
type IconAnchor$1
interface IconAtlasGpu
  destroy
  ensure
  getView
  rhiSampler
  rhiView
  sampler
  size
type IconColor
interface IconDraw
  anchor
  anchorX
  anchorY
  fadeRef
  fit
  opacity
  rotateRad
  sizeScale
  sprite
  tint
interface IconDrawSpec
  anchor
  data
  getColor
  getImage
  getPosition
  getRotation
  getSize
  type
  updateTriggers
class IconRenderer
  constructor
  destroy
  draw
  firstVertexSample
  lastAtlasSize
  lastDrawViewport
  lastVertexBBox
  private _bgl
  private _iconDraper
  private _iconFmt
  private _iconSamples
  private atlas
  private bboxDiagnosticEnabled
  private bgl
  private bindGroup
  private device
  private ensureIconDraper
  private fadePatches
  private lastNeedFloats
  private rhi
  private uniformBuf
  private uniformScratch
  private vertexBuf
  private vertexBufCapacityBytes
  private vertexScratch
  setBBoxDiagnostic
  setDraws
  vertexCount
interface IconShapes
  iconColor
  iconOpacity
  iconSize
class IconStage
  addIcon
  clearDispatchedIconNames
  clearMissingIconNames
  computeObstacles
  constructor
  destroy
  forHostAtlas
  getDispatchedIconNames
  getDumpedIcons
  getLastDrawIconCount
  getLastDrawSample
  getMissingIconNames
  getSprite
  gpu
  hasPendingAtlasLoad
  host
  isAtlasTerminal
  pairedIconHalfExtents
  prepare
  private _fadeEmitted
  private _fadeHoldover
  private _fadeHoldoverBake
  private _fadeOcc
  private _iconDebugHook
  private _iconDump
  private dispatchedIconNames
  private dpr
  private droppedPairKeys
  private fadeLedger
  private inlineImages
  private missingIconNames
  private pairFitBox
  private pending
  render
  renderer
  reset
  setDpr
  setDroppedPairKeys
  setFadeLedger
  setIconDebugHook
  setIconDumpEnabled
  setInlineImagePlacements
  setPairFitBoxes
  whenReady
interface IconStageOptions
  dpr
  fetch
  onLanded
  spriteUrl
type IconUpdateTrigger
type Identifier
type ImportStatement
function injectPolarCaps *
interface InlineGlyphSeed
  bytes
  glyphs
type InlineGlyphSource
interface InlineImageDraw
  hPx
  name
  wPx
  x
  y
interface InlineImagePlacement
  hPx
  name
  wPx
  x
  y
interface InlineImageSpriteSource
  get
type InputRef
type InputStatement
class InputStore
  colorSlots
  f32Slots
  get
  names
  private decls
  private evalCache
  private values
  private writeSlot
  reset
  revision
  set
  toEvalInputs
type InputType
type InputValue
type Keyframe
type KeyframesStatement
interface LabelDef
  allowOverlap
  anchor
  anchorCandidates
  color
  font
  fontStyle
  fontWeight
  halo
  iconAnchor
  iconCollide
  iconColor
  iconIgnorePlacement
  iconImage
  iconImageExpr
  iconKeepUpright
  iconOffset
  iconOpacity
  iconOptional
  iconPadding
  iconRotate
  iconRotationAlignment
  iconSize
  iconTextFit
  iconTextFitPadding
  iconTranslateAnchorMap
  iconTranslateExpr
  iconTranslateX
  iconTranslateY
  ignorePlacement
  justify
  keepUpright
  letterSpacing
  lineHeight
  maxAngle
  maxWidth
  offset
  padding
  pitchAlignment
  placement
  radialOffset
  rotate
  rotationAlignment
  shapes
  size
  sortKey
  sortKeyExpr
  spacing
  symbolZOrder
  text
  textOptional
  transform
  translate
  translateAnchorMap
  variableAnchorOffset
  writingMode
class LabelFadeLedger
  advance
  beginPrepare
  constructor
  finishPrepare
  get durationMs
  get enabled
  get size
  hasActive
  isFadingOut
  place
  private _durationMs
  private gen
  private lastAdvanceMs
  private records
  refOf
  setDurationMs
interface LabelShapes
  icon
  textLayout
  textPaint
type LayerDrawPhase
type LayerStatement
interface LineGradientStop
  offset
  rgba
interface LineMeshData
  bounds
  features
  indices
  vertices
interface LinePaint
  dashArrayShape
  dashOffsetShape
  linePattern
  linePatternRepeatM
  linePatternUV
  resolvedStrokeRgba
  zoomStrokeWidthStops
  zoomStrokeWidthStopsBase
interface LinePaint$1
  dashArray
  dashArrayShape
  dashOffsetShape
  linePattern
  linecap
  linejoin
  miterlimit
  patterns
  roundLimit
  stroke
  strokeAlign
  strokeBlur
  strokeColorExpr
  strokeGapWidth
  strokeGradientStops
  strokeOffset
  strokeTranslateAnchorMap
  strokeTranslateX
  strokeTranslateXShape
  strokeTranslateY
  strokeTranslateYShape
  strokeWidth
  strokeWidthExpr
class LineRenderer
  beginFrame
  beginTranslucentPass
  beginTranslucentPassRhi
  clearLayers
  composite
  constructor
  createLayerBindGroup
  drawSegments
  drawSegmentsBake
  drawSegmentsRhi
  endFrame
  ensureOffscreenRhi
  private COMPOSITE_SLOT
  private _compositeDraper
  private _layerBgl
  private _layerSrcView
  private _layerSrcViewBuffer
  private _lineDrapers
  private _offscreenHRhi
  private _offscreenTexRhi
  private _offscreenViewRhi
  private _offscreenWRhi
  private _splitLayout
  private compositeRing
  private compositeRingCapacity
  private compositeSlot
  private device
  private emptyShapeBuffer
  private ensureCompositeDraper
  private ensureLineDraper
  private format
  private layerBgl
  private layerDirtyHi
  private layerDirtyLo
  private layerRing
  private layerRingCapacity
  private layerSlot
  private layerStaging
  private layerStride
  private patternWarnings
  private rhi
  private shapeRegistry
  private tileBindGroupLayout
  private warnOnce
  rebuildForQuality
  resolveShapeId
  setShapeRegistry
  setSplitLayout
  splitStrokeEligible
  tileLayoutRhi
  uploadSegmentBuffer
  uploadSegmentBufferAsync
  writeLayerSlot
interface LineShapes
  stroke
  strokeWidth
class ListenerRegistry
  add
  dispatch
  has
  private map
  remove
interface LoadCommand
  baseShift
  blueFactor
  bounds
  encoding
  greenFactor
  inlineData
  layers
  maxzoom
  name
  options
  redFactor
  refresh
  scheme
  tileSize
  type
  url
interface LoaderFeatureCollection
  features
  type
interface LoaderPointPatch
  ids
  lat
  lon
  properties
function loadGeoJSON *
function loadPMTilesSource *
type LogLevel
type LogOp
type LogSink
type LonLat
function lonLatToMercator *
class MapEventBus
  _fireMapEvent
  _loadFired
  addEventListener
  constructor
  dispatchMapEvent
  fireBackendResolvedEvent
  fireErrorEvent
  fireLoadEvent
  mapEventListeners
  mapListeners
  off
  off
  on
  on
  once
  once
  private _evtSigBearing
  private _evtSigCX
  private _evtSigCY
  private _evtSigPitch
  private _evtSigZoom
  private _moveActive
  private _wasIdle
  private _zoomActive
  private host
  processCameraEvents
  removeEventListener
interface MapEventBusHost
  camera
  getCameraState
  shouldRenderThisFrame
  target
class MapEventRegistry
  add
  dispatch
  has
  private map
  remove
class MapRendererContent *
  addLayer
  beginFrame
  clearLayers
  constructor
  destroy
  dispatchComputePass
  drawOitCompose
  endFrame
  ensureOverdrawCompose
  fillRhiState
  get bindGroupLayout
  get featureBindGroupLayout
  get fillPipeline
  get fillPipelineExtruded
  get fillPipelineExtrudedFallback
  get fillPipelineExtrudedFallbackNoPick
  get fillPipelineExtrudedNoPick
  get fillPipelineExtrudedOIT
  get fillPipelineFallback
  get fillPipelineFallbackNoPick
  get fillPipelineGround
  get fillPipelineGroundFallback
  get fillPipelineGroundFallbackNoPick
  get fillPipelineGroundNoPick
  get fillPipelineNoPick
  get fillPipelineOverdraw
  get fillPipelineOverdrawFeature
  get fillPipelinePatternExtruded
  get fillPipelinePatternExtrudedFallback
  get fillPipelinePatternGround
  get fillPipelinePatternGroundFallback
  get linePipeline
  get linePipelineFallback
  get linePipelineFallbackNoPick
  get linePipelineNoPick
  get linePipelineOverdraw
  get oitComposeBindGroupLayout
  get oitComposePipeline
  get overdrawComposeBindGroupLayout
  get overdrawComposePipeline
  get paletteSampler
  getDrawStats
  getLayer
  getOrBuildVariantLayout
  getOrCreateVariantPipelines
  inputs
  isGraticuleEnabled
  listProperties
  paletteColorAtlasView
  prewarmShaderVariantsAsync
  private _graticule
  private bindGroup
  private ctx
  private engine
  private get uniformBuffer
  private layers
  private rebuildUniformBindGroups
  rebuildForQuality
  renderGraticuleOverlay
  renderGraticuleOverlayRhi
  renderToPass
  setComputePlan
  setGraticuleEnabled
  setPaletteColorAtlas
  setSpriteAtlas
  spriteAtlasView
interface MapSnapshot
  camera
  pageUrl
  pageViewport
  pixelHash
  pixelHashBy
  renderOrder
  schemaVersion
  sources
  userAgent
  viewport
class Marker *
  addTo
  constructor
  getElement
  getLngLat
  getPopup
  isDraggable
  off
  on
  private _emit
  private _onClick
  private _onMove
  private _onPointerDown
  private _onPointerMove
  private _onPointerUp
  private _update
  private anchor
  private draggable
  private dragging
  private element
  private listeners
  private lngLat
  private map
  private offset
  private popup
  remove
  setDraggable
  setLngLat
  setPopup
  togglePopup
const MARKER_LABELS_INSIDE
type MarkerAnchor *
type MarkerEvent
type MarkerLabel
interface MarkerMapLike
  getContainer
  off
  on
  project
  unproject
interface MarkerOptions *
  anchor
  color
  draggable
  element
  offset
type MatchArm
type MatchBlock
class Material
  constructor
  destroy
  get hasPool
  get poolGroup
  globalUniform
  layout
  pipeline
  poolSlot
  private _destroyed
  private layouts
  private pipelines
  private poolBGs
  private poolBufs
  private poolGroupIdx
  private poolSlotSize
  rhi
  writeGlobal
interface MaterialDesc
  colorTargets
  cullMode
  depthFormat
  format
  fsCode
  fsEntry
  globalUniformSize
  groups
  pool
  sampleCount
  shader
  topology
  variants
  vertexBuffers
  vsCode
  vsEntry
const mercator *
interface MeshData
  bounds
  features
  indices
  vertices
interface ModuleDecl
  bindings
  consts
  enables
  externs
  funcs
  overrides
  structs
interface MotionHoldoverCtx
  bearingKey
  canvasH
  canvasW
  refs
  solve
interface MultiPolygonGeometry
  coordinates
  type
function naturalEarth *
interface NodeLike
  __k
  expr
interface NumberAxis
  get
  set
type NumberLiteral
type ObjectLiteral
type OpaqueGroup
interface OpaqueGroup$1
  shows
  sourceName
function orthographic *
interface OverrideDecl
  default
  name
  type
type Packed
type PaintAxis
interface PaintShapes
  circle
  common
  fill
  hillshade
  line
  raster
class PaintTransitionRegistry
  beginColor
  beginNumber
  clear
  get size
  hasActive
  private entries
  settle
interface Palette
  colorGradients
  colors
  findColor
  findColorGradient
  findScalar
  findScalarGradient
  scalarGradients
  scalars
interface ParticleFlowDrawSpec
  data
  driftPx
  getBearing
  getColor
  getPosition
  getVolume
  lifetimeSeconds
  maxParticles
  minPerCell
  particleCount
  particleRadiusPx
  seed
  seedRadiusMeters
  type
  updateTriggers
interface PatternSlot
  anchor
  offset
  offsetUnit
  shapeId
  size
  sizeUnit
  spacing
  spacingUnit
  startOffset
interface PbfGlyph
  advance
  bitmap
  height
  id
  left
  top
  width
const PENDING_WORK_KINDS
class PendingLedger
  begin
  constructor
  count
  private deadlineMs
  private since
type PendingLedgerKind
type PendingWorkKind
class PendingWorkRegistry
  begin
  constructor
  count
  hasPending
  private ledgers
  private sources
type PendingWorkScope
interface PendingWorkSource
  count
interface PendingWorkTicket
  done
interface PerStyleLabelOwner
  entry
  key
interface PerStyleTwin
  mat
  variant
interface PipelineInspection
  adaptive
  camera
  cameraExplicitlyPositioned
  frame
  labels
  quality
  recentFlickers
  sources
  viewport
interface PipelineVariant
  colorTargets
  depthBias
  depthCompare
  depthWrite
  fsCode
  fsEntry
  label
  stencil
  vsCode
  vsEntry
class PMTilesArchiveSource *
  constructor
  format
  prewarm
  private loader
  resolve
type PMTilesFetcher
interface PMTilesSourceOptions *
  extrudeBaseExprs
  extrudeExprs
  kind
  layers
  onResolveError
  prewarmSkeletonByteBudget
  prewarmSkeletonDepth
  showSlices
  strokeColorExprs
  strokeWidthExprs
  url
type PointerEvents
interface PointFeatureMove
  featureId
  lat
  lon
interface PointPatch
  ids
  lat
  lon
  properties
class PointRenderer
  addLayer
  addTilePoint
  beginFrame
  canSkipTilePointRepack
  clearLayers
  constructor
  evictTilePointSlots
  flushTilePointsRhi
  hasLayers
  private _bgl
  private _emptyStorageBuf
  private _frameArena
  private _pointDrapers
  private _tilePointCache
  private _tilePointDrawDeps
  private bgl
  private device
  private emptyStorageBuf
  private ensurePointDraper
  private format
  private frameBlock
  private layers
  private makeBindGroup
  private rhi
  private shapeRegistry
  private tilePoints
  private uniformBuffer
  private vertexBufferLayout
  rebuildForQuality
  redrawTilePointsCached
  render
  renderRhi
  setShapeRegistry
  updateDynamicSizes
interface PolarCapFeatureCollection *
  features
  type
interface PolarCapOptions *
  featureProperty
  latThreshold
  lonSegments
  poles
interface PolygonGeometry
  coordinates
  type
interface PolygonGeometry$1
  coordinates
  type
class Popup *
  addTo
  constructor
  getElement
  getLngLat
  isOpen
  private _onMapClick
  private _onMove
  private _update
  private closeOnClick
  private content
  private fixedAnchor
  private lngLat
  private map
  private offset
  private root
  remove
  setDOMContent
  setHTML
  setLngLat
  setText
interface PopupOptions *
  anchor
  className
  closeButton
  closeOnClick
  maxWidth
  offset
type Position
interface PreambleModule
  bindings
  consts
  funcs
type PresetStatement
type Program
interface Projection
  forward
  inverse
  name
const PROJECTION_TOKEN_BRAND
function projectionNeedsPolarCaps *
interface ProjectionToken
  [PROJECTION_TOKEN_BRAND]
type PropertyFieldType
type PropertyShape
interface PropertyTable
  fieldNames
  fieldTypes
  values
interface PushCoverageOpts
  group
  ramp
  range
  region
  url
interface QualityConfig
  adaptive
  interactionDpr
  maxDpr
  msaa
  picking
class RasterRenderer
  beginFrame
  constructor
  destroy
  failedTiles
  hasFadingTiles
  hasPendingLoads
  hasSource
  pendingLoadCount
  private _brightnessMax
  private _brightnessMin
  private _cacheTile
  private _cachedBytes
  private _cachedTemplate
  private _contrast
  private _fadeDurationMs
  private _hasFadingTiles
  private _hueRotate
  private _lastTargetKeys
  private _nearest
  private _opacity
  private _rasterDraper
  private _rhiChecker
  private _rowGeom
  private _saturation
  private _scheme
  private _sourceBounds
  private _sourceMaxzoom
  private _tileSize
  private colorParams
  private ensureRasterDraper
  private ensureRhiChecker
  private evictTiles
  private format
  private frameCount
  private lastVisibleKeys
  private lastZoom
  private loadTileTexture
  private loadingTiles
  private rhi
  private tileCache
  private urlTemplate
  rebuildForQuality
  render
  renderRhiChecker
  setColorAdjust
  setOpacity
  setRasterFadeDurationMs
  setResampling
  setSourceBounds
  setSourceMaxzoom
  setTileSize
  setUrlTemplate
interface RasterShapes
  brightnessMax
  brightnessMin
  contrast
  fadeDurationMs
  hueRotate
  resamplingNearest
  saturation
type RawDataset
interface RefreshCoverageOpts
  bbox
  force
  group
type RefreshReason
function registerXGISElement *
interface RenderContext
  _validationErrors
  canvas
  deviceLost
  float32FilterableSupported
  format
  onDeviceLost
  onDeviceLostInternal
  rhi
  sampleCount
  timestampInsidePassesSupported
  timestampQuerySupported
interface RenderLayer
  featureDataBuffer
  fillPipeline
  lineIndexBuffer
  lineIndexCount
  linePipeline
  lineVertexBuffer
  perLayerBindGroup
  pickId
  polygonIndexBuffer
  polygonIndexCount
  polygonVertexBuffer
  props
  show
interface RenderStats *
  arenaCapacityBytes
  arenaLiveBytes
  bundleEvictions
  bundleHitRate
  bundleHits
  bundleMisses
  bundleReplaysThisFrame
  cachedBytes
  cachedBytesBudget
  drawCalls
  fps
  frameTime
  gpuTilesBudget
  heapDeltaAvgBytes
  heapDeltaBytes
  inflightRequests
  lines
  medianFrameMs
  sessionNetworkBytes
  tilesCached
  tilesVisible
  triangles
  vertices
  zoom
class RenderTargets
  constructor
  ensure
  ensureExtrudeShell
  ensureOit
  extrudeShellResolveTexture
  extrudeShellTexture
  get device
  get extrudeShellResolveView
  get extrudeShellSampleView
  get extrudeShellView
  get msaaView
  get oitAccumView
  get oitAccumViewNative
  get oitRevealageView
  get oitRevealageViewNative
  get overdrawView
  get overdrawViewNative
  get pickView
  get stencilView
  invalidate
  msaaHeight
  msaaTexture
  msaaWidth
  offscreenExtrudeDepth
  oitAccumTexture
  oitRevealageTexture
  overdrawAccumTexture
  pickSize
  pickTexture
  private _device
  private _viewCache
  private getCtx
  private oitHeight
  private oitSampleCount
  private oitWidth
  private pickH
  private pickW
  private scenePairH
  private scenePairW
  private screenPairH
  private screenPairSc
  private screenPairW
  private shellHeight
  private shellSampleCount
  private shellWidth
  private syncDevice
  private viewOf
  sceneColorTexture
  screenMsaaTexture
  stencilTexture
interface RenderTraceRecorder
  recordCamera
  recordLabel
  recordLayer
  recordTileLOD
  snapshot
function replayMapSnapshot
interface ReplayResult
  matched
  missingTiles
  pendingFetchTotal
  pendingUploadTotal
interface ResolvedInputInfo
  default
  line
  name
  slot
  type
interface ResolvedShow
  dashArray
  dashOffset
  fill
  fillAntialias
  fillTranslateX
  fillTranslateY
  layerName
  opacity
  size
  stroke
  strokeTranslateX
  strokeTranslateY
  strokeWidth
interface ResolvedSource
  attribution
  bounds
  fetcher
  format
  logDetail
  maxZoom
  minZoom
  name
  vectorLayers
type Rgba
type RGBA
type RGBA$1
type RGBA$2
interface RhiBindEntry
  binding
  resource
interface RhiBindGroup
  __rhi
interface RhiBindGroupLayout
  __rhi
interface RhiBindLayoutEntry
  binding
  dynamic
  kind
  name
  unfilterableFloat
  vertexVisible
type RhiBindResource
interface RhiBuffer
  __rhi
interface RhiBufferDesc
  copySrc
  elem
  label
  size
  usage
  writable
type RhiBufferUsage
interface RhiCaps
  chainFrame
  compute
  executionModel
  floatBlendTargets
  maxSampleCount
  outOfFramePasses
  pickReadback
  presentablePassMrt
  renderBundles
  shaderLanguage
  timestampQuery
interface RhiColorAttachment
  clearValue
  loadOp
  resolveTarget
  storeOp
  view
interface RhiCommandEncoder
  beginRenderPass
  copyBufferToBuffer
  finish
interface RhiDepthStencilAttachment
  depthClearValue
  depthLoadOp
  depthStoreOp
  stencilClearValue
  stencilLoadOp
  stencilStoreOp
  view
interface RhiDevice
  acquireFrameEncoder
  acquireScreenView
  backend
  beginOffscreenPass
  beginScreenPass
  caps
  copyExternalImage
  createBindGroup
  createBindGroupLayout
  createBuffer
  createCommandEncoder
  createPipeline
  createSampler
  createTexture
  createView
  destroy
  destroyBuffer
  destroyPipeline
  destroySampler
  destroyTexture
  endScreenPass
  generateMipmaps
  maxAnisotropy
  onContextLost
  onContextRestored
  popValidationScope
  pushValidationScope
  readPixelRg32ui
  takeGlErrors
  writeBuffer
  writeTexture
interface RhiDeviceLostInfo
  message
  reason
type RhiFilter
interface RhiPipeline
  __rhi
interface RhiPipelineDesc
  bindGroupLayouts
  code
  colorTargets
  cullMode
  depthStencil
  frontFace
  fsCode
  fsEntry
  label
  sampleCount
  topology
  vertexBuffers
  vsCode
  vsEntry
interface RhiPipelineHandle
  label
interface RhiRenderPass
  draw
  drawIndexed
  end
  setBindGroup
  setIndexBuffer
  setPipeline
  setStencilReference
  setVertexBuffer
interface RhiRenderPassDesc
  colorAttachments
  depthStencilAttachment
  label
interface RhiSampler
  __rhi
interface RhiSamplerDesc
  label
  mag
  maxAnisotropy
  min
  mipmap
interface RhiScreenPassDesc
  clear
  height
  screenView
  width
interface RhiScreenPassDevice
  beginOffscreenPass
  beginScreenPass
  endScreenPass
  readPixelRg32ui
  takeGlErrors
interface RhiTexture
  __rhi
interface RhiTextureDesc
  format
  height
  label
  mipLevelCount
  sampleCount
  usage
  width
type RhiTextureFormat
interface RhiTextureView
  __rhi
interface RingPolygon
  featId
  rings
const RUNTIME_CAPABILITIES *
function runtimeCapability *
interface RuntimeCapability *
  layerType
  note
  property
  supported
  variant
function runtimeGaps *
type Scalar
interface ScalarGradient
  base
  stops
interface SceneCommands
  background
  inputs
  loads
  palette
  shows
  symbols
interface SceneProgram
  __xgisSceneProgram
  program
interface Selection
  archiveAncestor
  cameraIdle
  currentZ
  maxLevel
  neededKeys
  parentAtMaxLevel
  protectedAncestors
  targetZ
  tiles
  worldOffDeg
type ShaderType
interface ShaderVariant
  categoryOrder
  computeBindings
  featureFields
  fillExpr
  fillIsDefault
  fillIsStage
  key
  needsFeatureBuffer
  opacityExpr
  opacityUsesPalette
  paletteScalarGradients
  preamble
  strokeExpr
  strokeIsDefault
  strokeIsStage
  uniformFields
type ShaderVariantInfo
interface ShapedGlyph
  advanceWidth
  bearingX
  bearingY
  codepoint
  height
  rasterFontSize
  slot
  width
interface ShapedGlyphSlot
  page
  pxX
  pxY
  size
class ShapeRegistry
  addShape
  addUserShape
  addUserSymbol
  constructor
  get segmentBuffer
  get shapeBuffer
  get shapeCount
  getShapeId
  private _segmentBuffer
  private _shapeBuffer
  private allSegments
  private dirty
  private nextId
  private rhi
  private shapes
  uploadToGPU
interface ShowCommand
  anchor
  billboard
  filterExpr
  geometryExpr
  label
  layerName
  maxzoom
  minzoom
  opacity
  paintShapes
  pickId
  pointerEvents
  projection
  ramp
  range
  renderNodeIndex
  shaderVariant
  shape
  size
  sizeExpr
  sizeUnit
  sourceLayer
  targetName
  visible
type ShowDrawFn
type SourceBounds
interface SourceLoadContext
  fetch
  id
  options
  url
type SourceLoader
type SourceLoadResult
type SourceStatement
interface SpriteInfo
  height
  name
  pixelRatio
  sdf
  width
  x
  y
interface SpriteMetadataSource
  get
  getSpriteCenterColor
  getState
  hasPendingLoad
  whenReady
type StageBlock
class StagingBufferPool
  _forceDirectWriteFallback
  borrow
  constructor
  dispose
  get gpuDevice
  get hasMappedAtCreationFallback
  getCreatedCount
  getFreeCounts
  private _createMappedBuffer
  private created
  private device
  private disposed
  private free
  private mappedAtCreationFails
  release
interface StagingSlot
  buffer
  byteCapacity
  tier
type Statement
class StatsPanel *
  constructor
  destroy
  private el
  private rows
  private visible
  toggle
  update
class StatsTracker *
  addDraw
  arenaCapacityBytes
  arenaLiveBytes
  beginFrame
  bundleEvictions
  bundleHits
  bundleMisses
  bundleReplaysThisFrame
  cachedBytes
  drawCalls
  endFrame
  get
  heapDeltaAvgBytes
  heapDeltaBytes
  inflightRequests
  lines
  private _frameMsFilled
  private _frameMsIdx
  private _frameMsRing
  private _frameMsSorted
  private _heapDeltaRing
  private _heapDeltaRingFilled
  private _heapDeltaRingIdx
  private _prevBundleTotal
  private _prevHeapBytes
  private fps
  private frameTime
  private frames
  private lastFrameStart
  private lastTime
  private medianFrameMs
  tilesCached
  tilesVisible
  triangles
  vertices
  zoom
type Stmt
type StringLiteral
interface StrokePattern
  anchor
  offset
  offsetUnit
  shape
  size
  sizeUnit
  spacing
  spacingUnit
  startOffset
interface StructDecl
  fields
  name
interface StructField
  attr
  builtin
  interpolate
  location
  name
  type
type StructField$1
type StructFieldType
type StructStatement
type StyleHost
class StyleProperties
  get
  getBool
  getColor
  getNumber
  keys
  private defaults
  private overrides
  reset
  resetAll
  set
  setDefault
type StyleProperty
type SymbolElement
type SymbolStatement
function synthesizeCapRing *
function synthesizePolarCaps *
interface TargetGeometry
  dpr
  h
  w
interface TerrainOptions
  exaggeration
type TerrainStatement
interface TextDraw
  anchorX
  anchorY
  color
  fadeRef
  fontSize
  glyphLayout
  glyphOffsets
  glyphRotations
  glyphs
  groundBasis
  groundBasisPivot
  halo
  italic
  letterSpacingPx
  rasterFontSize
  rotateRad
  sdfRadius
interface TextDrawSpec
  anchor
  data
  font
  getColor
  getPosition
  getSize
  getText
  type
  updateTriggers
interface TextLayoutShapes
  font
  fontStyle
  fontWeight
  size
interface TextOverlay
  color
  font
  halo
  lat
  lon
  size
  text
  transform
interface TextOverlayHandle
  remove
interface TextOverlayOptions
  anchor
  color
  font
  halo
  size
  text
  transform
interface TextPaintShapes
  color
  haloBlur
  haloColor
  haloWidth
  opacity
type TextPart
class TextRenderer
  constructor
  destroy
  draw
  getLastGroundAlignedCount
  private _bgl
  private _frameArena
  private _groundAlignedDraws
  private _textDraper
  private _textFmt
  private _textSamples
  private allUniforms
  private atlas
  private bgl
  private bindGroupsByPage
  private device
  private drawSlices
  private ensureTextDraper
  private rhi
  private uniformBuf
  private uniformBufCapacityBytes
  private vertexBuf
  private vertexBufCapacityBytes
  private vertexCount
  setDraws
class TextStage
  addCurvedLineLabel
  addGlyphProvider
  addLabel
  beginFrame
  clearDispatchedLabelTexts
  clearHaloDebug
  constructor
  destroy
  getActiveTextPairKeys
  getAtlasGeneration
  getDispatchedLabelTexts
  getDroppedPairKeys
  getDumpedLabels
  getFadeLedger
  getHaloDebug
  getInlineImagePlacements
  getLastDrawnLabelCount
  getLastSubmittedLabelCount
  getLayoutCacheStats
  getPairFitBoxes
  gpu
  hasPendingGlyphLoads
  host
  internCurvedPolyline
  invalidateAllGlyphs
  opts
  prepare
  prewarm
  prewarmGISDefaults
  private LAYOUT_CACHE_MAX
  private _debugHook
  private _diag
  private _fadeHoldover
  private _fadeHoldoverBake
  private _fadeOcc
  private _frameArena
  private _inlineImagePlacements
  private _internedPolyline
  private _lastPrepareFullyResolved
  private _layoutCache
  private _layoutCacheHits
  private _layoutCacheMisses
  private _pairBadge
  private _pairFitBox
  private _traceRecorder
  private bearingDeg
  private cameraZoom
  private dpr
  private droppedPairKeys
  private fadeLedger
  private fontTypography
  private pbfRasterizer
  private pending
  private pendingLine
  private spriteSource
  private typographyFor
  render
  renderer
  reset
  setBearing
  setCameraZoom
  setDpr
  setFadeDurationMs
  setLabelDebugHook
  setLabelDumpFilter
  setPairIconHalfExtents
  setSpriteMetadata
  setTraceRecorder
  wasLastPrepareFullyResolved
interface TextStageOptions
  defaultFont
  dpr
  fadeDurationMs
  fontTypography
  glyphProviders
  glyphsUrl
  inlineGlyphs
  onResourceLanded
  pageSize
  rasterFontSize
  rasterizer
  sdfRadius
  slotSize
type TextureElem
type TextValue
const TILE_LAYOUT_VERSION
class TileCatalog
  addTileLevel
  attachBackend
  cancelStale
  compileTileOnDemand
  consumeReplacedKeys
  contentGeneration
  destroy
  detachBackend
  evictTiles
  generateSubTile
  get maxLevel
  getBounds
  getCacheSize
  getCompileBudgetUsed
  getIndex
  getLayerZoomRange
  getPendingLoadCount
  getPropertyTable
  getRelevantParts
  getScheme
  getStateBreakdown
  getSubTileBudgetUsed
  getTileData
  getTileFailureCount
  getTileState
  hasData
  hasEntryInIndex
  hasPendingLoads
  hasReplacedKeys
  hasTileData
  indexGeneration
  isLoading
  loadFromTileSet
  markReplaced
  markSkeleton
  onDestroy
  onTileLoaded
  patchPointFeatures
  prefetchAdjacent
  prefetchNextZoom
  prefetchTiles
  prewarmSkeleton
  private _BURST_TICK_BUDGET
  private _TICK_BUDGET
  private _coldStartBurst
  private _contentGeneration
  private _destroyed
  private _draining
  private _frameId
  private _layoutMismatchWarned
  private _mergedScratch
  private _onDestroy
  private _pendingRefresh
  private _prefetchAge
  private _prefetchAgedFrame
  private _prefetchKeys
  private _refreshQueue
  private _replacedKeys
  private _skeletonPrewarm
  private acceptResult
  private backends
  private budget
  private cache
  private cacheTileData
  private checkLayoutVersion
  private createFullCoverTileData
  private deleteCacheEntry
  private drainRefreshQueue
  private entryToBackend
  private evictTilesForBackend
  private eviction
  private geojsonBackend
  private index
  private loadingTiles
  private makeSink
  private mergeBackendMeta
  private setSlice
  private subTileGen
  private tryCompileSync
  refreshTiles
  requestTiles
  resetCompileBudget
  setColdStartBurst
  setFetchPriority
  setRawParts
  setVirtualCatalog
interface TileCoord
  fallbackOnly
  ox
  x
  y
  z
interface TileData
  bases
  dequantHalf
  dequantScale
  featureProps
  fullCover
  fullCoverFeatureId
  heights
  indices
  lineIndices
  lineVertices
  originBackend
  outlineIndices
  outlineLineIndices
  outlineVertices
  pointFeatureIds
  pointVertices
  polygons
  prebuiltLineSegments
  prebuiltOutlineSegments
  tileHeight
  tileSouth
  tileWest
  tileWidth
  tileZoom
  vertices
interface TileIndexEntry
  compactSize
  dataOffset
  flags
  fullCoverFeatureId
  gpuReadySize
  indexCount
  lineIndexCount
  lineVertexCount
  tileHash
  vertexCount
class TileJSONSource *
  constructor
  format
  prewarm
  private loader
  resolve
type TileLayoutVersion
interface TileLevel
  tiles
  zoom
interface TilePointFrameArgs
  camera
  canvasHeight
  canvasWidth
  dpr
  pass
  projCenterLat
  projCenterLon
  projType
  show
interface TilePointPackKey
  anchor
  billboard
  contentGeneration
  fill
  opacity
  pitch
  shape
  size
  sizeAst
  sizeUnit
  sliceLayer
  stableKeysHash
  stroke
  strokeOpacityShape
  strokeWidth
  worldCopyMask
  zoom
interface TilePointShow
  anchor
  billboard
  circleBlur
  circlePitchAlignmentMap
  circlePitchScaleMap
  circleStrokeOpacityShape
  circleTranslateX
  circleTranslateXShape
  circleTranslateY
  circleTranslateYShape
  fill
  opacity
  shaderVariant
  shape
  size
  sizeExpr
  sizeUnit
  stroke
  strokeWidth
type TileRowScheme
type TileScheme
class TileSelectionCache
  _czPendingAdvance
  frameTileCache
  invalidateFrame
  private FRAME_TILE_CACHE_SLOTS
  private _frameTileCacheLru
  private _gateSSECache
  private _gateSSECacheFrameId
  private _hysteresisZ
  private _lastCamMoveAt
  private _lastCamSnap
  private _scratchAncestorMemo
  private _selectionComputeCount
  selectForFrame
  selectionComputeCount
interface TileSelectionCamera
  centerX
  centerY
  getFrameView
  getRTCMatrix
  pitch
  unprojectToZ0
  zoom
interface TileSource
  attach
  cancelStale
  compileSync
  detach
  failureCount
  has
  isFailed
  loadTile
  loadTilesBatch
  meta
  setFetchPriorityCallback
  tick
interface TileSourceMeta
  bounds
  entries
  layoutVersion
  maxZoom
  minZoom
  propertyTable
  scheme
interface TileSourceSink
  acceptResult
  getLoadingCount
  hasTileData
  releaseLoading
  trackLoading
type TileState
interface TimeStop
  timeMs
  value
interface TopLevelAtmosphere
  innerColor
  outerColor
  sky
interface TopLevelAtmospherePatch
  innerColor
  outerColor
  sky
interface TopLevelLight
  color
  intensity
  position
interface TopLevelLightPatch
  color
  intensity
  position
interface TopLevelSky
  color
  horizonBlend
  horizonColor
interface TopLevelSkyPatch
  color
  horizonBlend
  horizonColor
interface TraceLabel
  anchorScreenX
  anchorScreenY
  color
  fontFamily
  fontStyle
  fontWeight
  halo
  layerName
  placement
  sizePx
  state
  text
interface TraceLayer
  aaWidthPx
  dashArrayMeters
  fillPhase
  layerName
  resolvedFill
  resolvedOpacity
  resolvedStroke
  resolvedStrokeWidth
interface TraceTileLOD
  fetchedKeys
  selectedCz
type UnaryExpr
class UnderOccluderRenderer
  constructor
  destroy
  private _pickMaterial
  private bgByMaterial
  private block
  private buildMaterial
  private color
  private format
  private globalBG
  private indexBuffer
  private indexCount
  private material
  private pickMat
  private rhi
  private sampleCount
  private vertexBuffer
  render
  setColor
class UniformRing
  allocSlot
  constructor
  destroy
  ensure
  flush
  get rhiBuffer
  private _buffer
  private capacity
  private dirtyHi
  private dirtyLo
  private grow
  private label
  private onGrow
  private onGrowEnd
  private onGrowStart
  private retired
  private rhi
  private slot
  private slotSize
  private staging
  private viewCache
  resetSlot
  slotCursor
  stageSlot
  takeRetired
type UtilityItem
type UtilityLine
interface VectorLayerInfo *
  fields
  id
  maxzoom
  minzoom
type VectorTileFormat *
class VectorTileLoader *
  attach
  clearCache
  fetchVectorLayerFields
  fetchVectorLayerSchema
  load
  openArchive
  openTileJSON
  prewarm
  private archiveCache
  private tileJsonCache
  sourceFor
class VectorTileRenderer
  _drapeOverzoomDiag
  _drapeOverzoomDiagBySlice
  _selection
  arenaBytes
  bakeTileToTexture
  beginFrame
  buildFeatureDataBuffer
  constructor
  currentProjection
  destroy
  dispatchComputePass
  emitTilePointsRhi
  ensureLabelTilesRhi
  forEachLabelFeature
  forEachLineLabelFeature
  forEachLineLabelPolyline
  get gpuCache
  get sourceMaxLevel
  getBounds
  getBundleStats
  getCacheSize
  getDrawStats
  getLastDecisionCounts
  getPendingUploadCount
  getPropertyTable
  getTileLoadDiagnostic
  hasData
  hasFeatureData
  hasPendingUploads
  inputs
  private _bakeBlock
  private _diagFillsThisFrame
  private _fillBakeMatRhi
  private _fillMatRhi
  private _fillPatternMatRhi
  private _fillPatternTileBgRhi
  private _fillPickMatRhi
  private _fillTileBgRhi
  private _fillVariantsRhi
  private _labelSource
  private _lineTileBgRhi
  private _nextTilePointPrefix
  private _onSplitRebind
  private _onUniformRingGrow
  private _releaseTileHook
  private _scratchProtectedKeys
  private _spriteAtlasRhi
  private _store
  private _strokeQueueSlots
  private _strokeQueueTileOff
  private _strokeQueueTiles
  private _stubAtlasRhi
  private _tilePointOwner
  private _tilePointShowIdPrefix
  private _worldOffScratch
  private applyReplacedTiles
  private ensureFillBakeMaterialRhi
  private ensureFillMaterialRhi
  private ensureFillPatternMaterialRhi
  private ensureFillPickMaterialRhi
  private fillPatternTileBgRhi
  private fillTileBgRhi
  private fillVariants
  private flushUniformStaging
  private guardAndUnwrapPass
  private lineTileBgRhi
  private prefetchScheduler
  private resetUploadFrameCap
  private ringBufferNative
  private stagingPool
  private stubAtlasRhi
  private uniformRing
  pumpPrefetch
  rebuildForQuality
  render
  renderFillsRhi
  renderLinesRhi
  reseedTiles
  setBindGroupLayout
  setColdStartBurst
  setComputePlan
  setExtrudedPipelines
  setFillRhi
  setGroundPipelines
  setLight
  setLineRenderer
  setOITPipeline
  setPaletteResources
  setPatternExtrudedPipelines
  setPatternPipelines
  setSeededFeatures
  setSource
  setSpriteAtlasRhi
  setSpriteAtlasView
  sourceLayerOutsideDataZoom
class VectorTileSource *
  attachTo
  constructor
  format
  lastResolveError
  prewarm
  resolve
  url
function vertexOnClampBoundary *
interface VirtualCatalog
  bounds
  fetcher
  maxZoom
  minZoom
type VirtualTileFetcher
function visibleTilesFrustum
interface XGISFeature
  id
  layer
  properties
  source
class XGISFeatureEvent
  clientX
  clientY
  constructor
  coordinate
  currentTarget
  feature
  get defaultPrevented
  originalEvent
  pixel
  preventDefault
  private _defaultPrevented
  stopPropagation
  target
  timeStamp
  type
type XGISFeatureEventType
type XGISFeatureListener
interface XGISFontResource
  data
  family
  letterSpacingEm
  lineHeightScale
  style
  weight
class XGISLayer
  addEventListener
  constructor
  dispatchEvent
  get id
  get visible
  hasListeners
  name
  private listeners
  private show
  removeEventListener
  resetStyle
  style
class XGISLayerStyle
  constructor
  get extrude
  get extrudeBase
  get fill
  get opacity
  get pointerEvents
  get stroke
  get strokeWidth
  get visible
  private _defaults
  private applyColor
  private applyNumber
  private host
  private snapshot
  reset
  set extrude
  set extrudeBase
  set fill
  set opacity
  set pointerEvents
  set stroke
  set strokeWidth
  set visible
type XGISLayerStyleKey
class XGISMap *
  _atmosphere
  _backgroundColor
  _backgroundColorFromStyle
  _backgroundColorShape
  _backgroundOpacityShape
  _backgroundPattern
  _dispatchMapEvent
  _elapsedMs
  _eventBus
  _featureExprsCache
  _flickerFirstFrame
  _flickerLastFrame
  _flickerLog
  _frameCount
  _hillshadeShow
  _interacting
  _labelDispatchHits
  _labelDispatchLoopRuns
  _labelDispatchMisses
  _labelsHaveTimeAnimation
  _lastSigBearing
  _lastSigCX
  _lastSigCY
  _lastSigH
  _lastSigPitch
  _lastSigW
  _lastSigZoom
  _light
  _missingTileCount
  _needsRender
  _pendingLabelDebugHook
  _pendingTraceRecorder
  _pendingWork
  _rasterShow
  _reResolveVariantPipelines
  _reprojectIngest
  _runBoundsFitGate
  _scheduleFrame
  _scratchEmittedLineIconKeys
  _scratchEmittedPointNames
  _scratchEmittedTextNames
  _spriteAtlasViewPushed
  _startTime
  _stats
  _statsPanel
  addEventListener
  addFonts
  addGlyphProvider
  addImage
  addLayer
  addOverlay
  addSource
  autoRefreshCoverage
  boxZoomEnabled
  camera
  cameraAnimationDurationMs
  captureNextFrameTrace
  captureSnapshot
  classifyVectorTileShows
  clearOverlays
  constructor
  consumeLabelDirty
  cooperativeGestures
  coverageRenderer
  ctx
  destroy
  doubleClickZoomEnabled
  easeTo
  effectiveFadeDurationMs
  effectiveRasterFadeDurationMs
  fitBounds
  flowRenderer
  flyTo
  fontTypography
  fontsReady
  get
  get _cameraPositionedFlag
  get _pendingFlushHandle
  get _pendingPatches
  get graphics
  get mapEventListeners
  get pickTexture
  get projectionName
  get stats
  getAtlasGeneration
  getBackend
  getBearing
  getBounds
  getCamera
  getCameraDebugSnapshot
  getCameraState
  getCanvas
  getCanvasDpr
  getCenter
  getContainer
  getCoverage
  getDispatchedIconNames
  getDispatchedLabelTexts
  getDumpedIcons
  getDumpedLabels
  getHaloDebug
  getInput
  getLabelDispatchStats
  getLastDrawIconCount
  getLastDrawSample
  getLastLabelCounts
  getLayer
  getLayers
  getLayoutCacheStats
  getMaxBounds
  getMaxZoom
  getMinZoom
  getMissingIconNames
  getMissingTileCount
  getPaintProperty
  getPitch
  getProjectionName
  getQuality
  getTerrain
  getTileLoadDiagnostic
  getZoom
  glyphProviders
  glyphsUrl
  gpuTimer
  groupOpaqueBySource
  hasImage
  heatmapPointData
  heatmapRenderer
  heatmapTargets
  hillshadeRenderer
  iconStage
  inlineGlyphs
  inputs
  inspectPipeline
  invalidate
  isGraticuleEnabled
  isPolarCapsEnabled
  jumpTo
  labelFadeDurationMs
  lineRenderer
  listProperties
  load
  loaded
  markCameraPositioned
  markInteracting
  markLabelDirty
  off
  off
  on
  on
  onDeviceLost
  onWebGPUUnavailable
  once
  once
  overlays
  paintTransitionDurationMs
  panBy
  pauseCoverageTime
  pickAt
  playCoverageTime
  pointRenderer
  private _INTERACTION_IDLE_MS
  private _animClockMs
  private _appliedTouchAction
  private _armCoverageFields
  private _armDeviceLostRecovery
  private _backend
  private _burst
  private _burstVisibilityHandler
  private _cancelScheduledFrame
  private _collectShaderVariants
  private _coverageAbort
  private _coverageArrowsArmed
  private _coverageCatalogues
  private _coverageDeps
  private _coverageFieldShow
  private _coverageFlowArmed
  private _coverageMoveHandler
  private _coverageRefresh
  private _coverageTime
  private _ctxOwned
  private _currentComputePlan
  private _cursor
  private _destroyed
  private _detachAutoResize
  private _detachReducedMotion
  private _detachVisibilityPause
  private _deviceLostBudget
  private _deviceLostRecover
  private _deviceLostResumePending
  private _dirty
  private _docHidden
  private _enableComputePath
  private _enterColdStartBurst
  private _epochStale
  private _fireLoadEvent
  private _fitZoomToLonSpan
  private _frameFailures
  private _gpuBootDeps
  private _graphics
  private _hashMoveHandler
  private _hashSync
  private _hashWriteTimer
  private _installSyntheticEarthSurfaceSource
  private _interactionIdleTimer
  private _keyDownHandler
  private _loaded
  private _logConversionNotes
  private _makeWebGl2Device
  private _markDirty
  private _onDeviceLost
  private _onDocHidden
  private _onDocVisible
  private _onKeyDown
  private _onReducedMotionChange
  private _onWebGPUUnavailable
  private _paintTransitions
  private _paletteHandles
  private _pendingGpuBoot
  private _pointerActive
  private _polarCapHost
  private _prefersReducedMotion
  private _preserveDrawingBuffer
  private _priorInlineTouchAction
  private _processCameraEvents
  private _rafId
  private _rafTick
  private _reducedMotionOverride
  private _registerVtSource
  private _releaseGpuResources
  private _runEpoch
  private _runGuarded
  private _runProgram
  private _sceneHasAnimation
  private _scheduleHashWrite
  private _settleRecovery
  private _setupAccessibility
  private _setupHashSync
  private _setupTouchAction
  private _showWebGPUUnavailableDefault
  private _stopCoverageMachinery
  private _syntheticBackend
  private _teardownForReinit
  private _terrain
  private _viewport
  private _warnUnsupported
  private _warnedStyleAPI
  private _writeHash
  private applyEffectiveRasterFadeDuration
  private applyTerrain
  private buildFeatureForEvent
  private cameraController
  private canvas
  private clientToLngLat
  private controller
  private eventDispatcher
  private featureUpdateQueue
  private geojsonCapPoles
  private get _cameraExplicitlyPositioned
  private get _coverageFieldArmed
  private get mapListeners
  private getLayerByPickId
  private installRendererSet
  private interactionController
  private layerIds
  private rebuildLayers
  private renderFrame
  private renderLoopInstance
  private running
  private set _cameraExplicitlyPositioned
  private shapeRegistry
  private shouldRenderThisFrame
  private sourceCRS
  private sourceManager
  private switchController
  private teardownSource
  private vectorTileShows
  private vtVariantPipelines
  private xgisLayers
  project
  rasterFadeDurationMs
  rasterRenderer
  rawDatasets
  refreshCoverage
  removeCoverageRegion
  removeEventListener
  removeImage
  removeLayer
  removeSource
  renderLoop
  renderTargets
  renderer
  replaySnapshot
  reset
  resize
  run
  runBinary
  runScene
  set
  set _pendingFlushHandle
  setAtmosphere
  setBackgroundFill
  setBearing
  setCenter
  setCoverageData
  setCoverageFrame
  setCoverageTime
  setGlyphsUrl
  setGraticuleEnabled
  setIconDumpEnabled
  setInlineGlyphs
  setInput
  setLabelDebugHook
  setLabelDumpFilter
  setLight
  setLogSink
  setMaxBounds
  setMaxZoom
  setMinZoom
  setPaintProperty
  setPitch
  setPolarCapsEnabled
  setProjection
  setQuality
  setSourceData
  setSourcePoints
  setSpriteUrl
  setStyle
  setTerrain
  setTraceRecorder
  setZoom
  showCommands
  showInspector
  spriteUrl
  stop
  stopAnimation
  stopAutoRefreshCoverage
  textStage
  underOccluder
  unproject
  updateFeature
  vtSources
  zoomIn
  zoomOut
class XGISMapElement *
  connectedCallback
  constructor
  disconnectedCallback
  private canvas
  private map
  run
interface XGISMapErrorInfo
  error
  fatal
  phase
  source
type XGISMapErrorPhase
class XGISMapEvent
  backend
  bearing
  center
  constructor
  error
  fatal
  phase
  pitch
  target
  timeStamp
  type
  zoom
type XGISMapEventType
type XGISMapListener
interface XGISMapOptions
  ariaLabel
  backend
  bearing
  body
  boxZoom
  cameraAnimationDuration
  center
  cooperativeGestures
  cursor
  doubleClickZoom
  enableComputePath
  fadeDuration
  fonts
  glyphProviders
  glyphs
  graticule
  hash
  logConversionNotes
  paintTransitionDuration
  pitch
  preserveDrawingBuffer
  projection
  rasterFadeDuration
  respectReducedMotion
  sources
  spriteUrl
  touchAction
  zoom
interface XGVTHeader
  bounds
  indexLength
  indexOffset
  levelCount
  maxLevel
  propTableLength
  propTableOffset
interface XGVTIndex
  entries
  entryByHash
  header
  propertyTable
interface ZoomStop
  value
  zoom
```
