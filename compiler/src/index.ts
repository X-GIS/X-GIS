export { Lexer } from './lexer/lexer'
export { TokenType, type Token } from './lexer/tokens'
export { Parser } from './parser/parser'
export type * from './parser/ast'
export { serializeXGB, deserializeXGB, type BinaryScene } from './binary/format'
export { resolveColor } from './tokens/colors'
export { resolveUtilities, type ResolvedProperties } from './ir/utility-resolver'
export { lower } from './ir/lower'
export { emitCommands } from './ir/emit-commands'
export type { Scene, SourceDef, RenderNode, ColorValue, StrokeValue, OpacityValue, SizeValue, DataExpr, ZoomStop, ConditionalBranch } from './ir/render-node'
export type { PropertyShape, PaintShapes, RGBA as PropertyRGBA } from './ir/property-types'
export { hexToRgba, rgbaToHex, colorNone, colorConstant, opacityConstant, sizeNone, sizeConstant } from './ir/render-node'
export { evaluate, type FeatureProps } from './eval/evaluator'
export {
  CAMERA_ZOOM_KEY, FEATURE_ID_KEY, GEOMETRY_TYPE_KEY,
  makeEvalProps,
  type ReservedKey,
} from './eval/reserved-keys'
export {
  formatValue, parseFormatSpec, parseTextTemplate, isBareExpressionTemplate,
  formatNumber, formatString, formatDMS, formatDM, formatBearing, formatDate,
} from './format'
export type { TextValue, TextPart, FormatSpec, LabelDef } from './ir/render-node'
export { resolveImports, resolveImportsAsync, type FileReader, type AsyncFileReader, type ResolveImportsOptions } from './module/resolver'
export { optimize } from './ir/optimize'
export type { ShaderVariant } from './codegen/shader-gen'
export { collectPalette, emptyPalette } from './codegen/palette'
export type { Palette, ColorGradient, ScalarGradient } from './codegen/palette'
export {
  COMPUTE_WORKGROUP_SIZE,
  emitMatchComputeKernel,
  emitTernaryComputeKernel,
  emitInterpolateComputeKernel,
} from './codegen/compute-gen'
export type {
  ComputeKernel,
  MatchArmSpec,
  MatchEmitSpec,
  TernaryBranchSpec,
  TernaryEmitSpec,
  InterpolateStopSpec,
  InterpolateEmitSpec,
} from './codegen/compute-gen'
export { planComputeKernels } from './codegen/compute-plan'
export type { ComputePlanEntry, PaintAxis } from './codegen/compute-plan'
export {
  emitComputeOutputBindingDecl,
  emitComputeOutputReadExpr,
  makeComputeOutputBindGroupEntry,
} from './codegen/compute-output-binding'
export type {
  ComputeOutputPaintAxis,
  ComputeOutputBindingSpec,
  ComputeOutputBindGroupEntry,
} from './codegen/compute-output-binding'
export {
  buildComputeVariantAddendum,
  FRAGMENT_FEAT_ID_EXPR,
} from './codegen/compute-variant'
export type { ComputeVariantAddendum } from './codegen/compute-variant'
export { mergeComputeAddendumIntoVariant } from './codegen/compute-variant-merge'
export { buildPerShowMergedVariant } from './codegen/compute-variant-build'
export { TILE_FLAG_FULL_COVER, type XGVTIndex, type XGVTHeader, type TileIndexEntry } from './tiler/tile-format'
export { tileKey, tileKeyUnpack, tileKeyParent, tileKeyChildren, compileGeoJSONToTiles, compileGeoJSONToTilesAsync, compileSingleTile, decomposeFeatures, lonLatToMercF64, splitF64, packDSFUNPolygonVertices, packDSFUNLineVertices, packQuantizedPolygonVertices, QUANT_POLY_STRIDE_BYTES, QUANT_POLY_RANGE, augmentRingWithArc, tessellateLineToArrays, extractNonSyntheticArcs, makeSameBoundarySidePredicateMerc, type GeometryPart, type PropertyTable, type PropertyFieldType, type CompiledTileSet, type CompiledTile, type TileLevel, type TilerOptions, type FeatureIdResolver } from './tiler/vector-tiler'
export { clipPolygonToRect, clipPolygonToRectV2, clipLineToRect } from './tiler/clip'
export { geojsonvt, GeoJSONVT, DEFAULT_OPTIONS as GEOJSONVT_DEFAULT_OPTIONS } from './tiler/geojsonvt'
export { encodeMVT, type MVTLayerInput, type EncodeOptions } from './tiler/geojsonvt/encode-mvt'
export type { GeoJSONVTOptions, TransformedTile, TransformedTileFeature } from './tiler/geojsonvt/types'
export { simplify, simplifyPolygon, simplifyLine, toleranceForZoom, mercatorToleranceForZoom } from './tiler/simplify'
export { interpolateGreatCircle, haversineDistance } from './tiler/geodesic'
export { type RingPolygon } from './tiler/encoding'
export { decodeMvtTile, type MvtDecodeOptions } from './input/mvt-decoder'
export type { GeoJSONFeature, GeoJSONGeometry } from './tiler/geojson-types'
export { convertMapboxStyle, type MapboxStyle, type MapboxLayer, type MapboxSource, type ConvertMapboxStyleOptions } from './convert/mapbox-to-xgis'
export { MAPBOX_COVERAGE, flattenCoverage, type CoverageEntry, type CoverageSection, type CoverageStatus, type CoverageImpact } from './convert/spec-coverage'
export { getStyleProfile, formatStyleProfile, type StyleProfile, type DepHistogramRow, type CSESummary, type ComputePlanSummary, type PaletteSummary, type MatchArmBand } from './diagnostics/style-profile'
export { analyzeCSE, hasCSEOpportunities, type CSEReport, type CSEEntry } from './ir/passes/cse'
export { applyCSE, applyCSEFromReport, sameCSE, type CSEAnnotation } from './ir/passes/apply-cse'
export { annotateDeps, fillIsZoomOnly, hasFeatureDep, type DepsAnnotation, type DepsEntry, type NodeDepsAnnotation } from './ir/passes/annotate-deps'
export { Dep, hasDep, mergeDeps, formatDeps, depsSubsetOf, getColorDeps, getDataExprDeps, getPropertyShapeDeps, DEPS_NONE, DEPS_ZOOM, DEPS_TIME, DEPS_FEATURE, DEPS_ZOOM_TIME, DEPS_ZOOM_FEATURE, type DepBits } from './ir/deps'
export {
  LANGUAGE_SCHEMA,
  SOURCE_TYPES,
  ANCHORS,
  type ConstructDef,
  type SchemaProperty,
  type SchemaRef,
  type SchemaValueKind,
  type SchemaPinType,
} from './schema/language'
