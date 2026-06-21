export { resolveUtilities, type ResolvedProperties } from './utility-resolver'
export { lower } from './lower'
// Zoom-stop extractors (WS-1 background zoom-interp). The runtime re-parses
// a `background { fill: interpolate(zoom, …) }` / `opacity: interpolate(…)`
// styleProperty string into an AST.Expr and pulls its (zoom, value) stops so
// the background colour / opacity resolves per frame. Defs in lower-helpers.ts.
export { extractInterpolateZoomColorStops, extractInterpolateZoomStops } from './lower-helpers'
export { emitCommands } from './emit-commands'
export type { SceneCommands, LoadCommand, ShowCommand, FillPaint, LinePaint, CirclePaint, ExtrudePaint, HeatmapPaint } from './emit-commands'
export type { Scene, SourceDef, RenderNode, ColorValue, StrokeValue, OpacityValue, SizeValue, DataExpr, ZoomStop, ConditionalBranch } from './render-node'
export type { PropertyShape, PaintShapes, RasterShapes, RGBA as PropertyRGBA } from './property-types'
export { defaultRasterShapes } from './property-types'
export { hexToRgba, rgbaToHex, colorNone, colorConstant, opacityConstant, sizeNone, sizeConstant } from './render-node'
export type { TextValue, TextPart, FormatSpec, LabelDef } from './render-node'
export { optimize } from './optimize'
export { analyzeCSE, hasCSEOpportunities, type CSEReport, type CSEEntry } from './passes/cse'
export { applyCSE, applyCSEFromReport, sameCSE, type CSEAnnotation } from './passes/apply-cse'
export { annotateDeps, fillIsZoomOnly, hasFeatureDep, type DepsAnnotation, type DepsEntry, type NodeDepsAnnotation } from './passes/annotate-deps'
export { Dep, hasDep, mergeDeps, formatDeps, depsSubsetOf, getColorDeps, getDataExprDeps, getPropertyShapeDeps, DEPS_NONE, DEPS_ZOOM, DEPS_TIME, DEPS_FEATURE, DEPS_ZOOM_TIME, DEPS_ZOOM_FEATURE, type DepBits } from './deps'
