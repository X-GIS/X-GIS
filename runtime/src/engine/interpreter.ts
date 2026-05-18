// ═══ AST Interpreter — AST를 실행 가능한 명령으로 변환 ═══

import type * as AST from '@xgis/compiler'
import { resolveUtilities, resolveColor } from '@xgis/compiler'
import type { PaintShapes, PropertyShape, PropertyRGBA } from '@xgis/compiler'
import type { ShowCommand } from './render/renderer'
// Use runtime hexToRgba (nullable variant — returns null on invalid
// hex shape) instead of the compiler's always-returns-tuple version.
// The surrounding `fillRgba !== null ? … : null` ternary expects
// nullable behaviour. Pre-fix the compiler version returned
// [0,0,0,1] for ANY invalid input including legitimately invalid
// hex strings — silently rendering them as opaque black instead of
// no-fill. See iter 318 hexToRgba contract fix.
import { hexToRgba } from './feature-helpers'

/** Synthesize a PaintShapes bundle from a constant-only legacy show.
 *  The legacy `let`/`show` and the simple `source`/`layer` utility
 *  syntax only carry compile-time-constant paint values — no zoom
 *  stops, no time animation, no per-feature data-driven exprs. So
 *  every PropertyShape comes out as `kind: 'constant'`, and
 *  unauthored slots (no fill / no stroke / no size) become `null`.
 *  Step 1c.3 will extend this when consumers off the flat fields
 *  request the typed bundle for non-opacity properties; until then
 *  fill/stroke/strokeWidth/size still also live on the flat fields
 *  bucket-scheduler reads. */
function synthesizeConstantPaintShapes(args: {
  fill: string | null
  stroke: string | null
  strokeWidth: number
  opacity: number
}): PaintShapes {
  const fillRgba = args.fill !== null ? hexToRgba(args.fill) : null
  const strokeRgba = args.stroke !== null ? hexToRgba(args.stroke) : null
  const fill: PropertyShape<PropertyRGBA> | null = fillRgba !== null
    ? { kind: 'constant', value: fillRgba as PropertyRGBA }
    : null
  const stroke: PropertyShape<PropertyRGBA> | null = strokeRgba !== null
    ? { kind: 'constant', value: strokeRgba as PropertyRGBA }
    : null
  return {
    fill,
    stroke,
    opacity: { kind: 'constant', value: args.opacity },
    strokeWidth: { kind: 'constant', value: args.strokeWidth },
    size: null,
  }
}

export interface LoadCommand {
  name: string
  url: string
  /** Optional: restrict the source to a subset of named sub-layers.
   *  For PMTiles/MVT sources this maps to PMTilesSourceOptions.layers
   *  — the decoder filters features by MVT layer name before
   *  decompose+compile. Lets multiple xgis layers reference the same
   *  archive with different MVT layer subsets so each renders with
   *  its own style (water blue, roads grey, buildings beige, etc.). */
  layers?: string[]
}

export interface SceneCommands {
  loads: LoadCommand[]
  shows: ShowCommand[]
  symbols?: { name: string; paths: string[] }[]
  /** Resolved background fill color (`#rrggbb` or `#rrggbbaa`).
   *  Set when the .xgis program contains a `background { ... }`
   *  block. Renderer applies it as the canvas clearValue; absent
   *  → renderer keeps its built-in default. */
  background?: string
  /** P3 Step 3c — scene-wide color gradient pool surfaced by
   *  `emitCommands(scene)`. Runtime uploads via `uploadPalette` and
   *  binds via `setPaletteColorAtlas`. Absent for interpreter-only
   *  paths (which don't run the compile pipeline). */
  palette?: import('@xgis/compiler').Palette
}

/**
 * Interpret a parsed X-GIS program into executable commands.
 * Handles both legacy (let/show) and new (source/layer) syntax.
 */
export function interpret(program: AST.Program): SceneCommands {
  const loads: LoadCommand[] = []
  const shows: ShowCommand[] = []
  const sources = new Map<string, SourceDef>()
  let background: string | undefined

  for (const stmt of program.body) {
    if (stmt.kind === 'BackgroundStatement') {
      const c = extractBackgroundColor(stmt)
      if (c) background = c
      continue
    }
    if (stmt.kind === 'LetStatement') {
      const load = extractLoad(stmt)
      if (load) loads.push(load)
    } else if (stmt.kind === 'ShowStatement') {
      const show = extractShow(stmt)
      if (show) shows.push(show)
    } else if (stmt.kind === 'SourceStatement') {
      const src = extractSource(stmt)
      if (src) sources.set(src.name, src)
    } else if (stmt.kind === 'LayerStatement') {
      const result = extractLayer(stmt, sources)
      if (result) {
        // De-dupe LoadCommands by source name. Multiple xgis layers
        // sharing one source (Mapbox-style: one PMTiles archive,
        // many `sourceLayer:` filters) must reference the SAME
        // backend instance — emitting a fresh LoadCommand per layer
        // would race-create N orphan TileCatalog/VTRs and the actual
        // rendering ends up wired to whichever attachPMTilesSource
        // finished last. Symptom: gpuCache stays at 0 forever.
        if (!loads.some(l => l.name === result.load.name)) {
          loads.push(result.load)
        }
        shows.push(result.show)
      }
    }
  }

  return { loads, shows, background }
}

function extractBackgroundColor(stmt: AST.BackgroundStatement): string | undefined {
  // Walk utility items first (e.g. `| fill-sky-900`), then explicit
  // `fill: <color>` style properties — last-write-wins matches how
  // resolveUtilities + style props interact for layers.
  const allItems: AST.UtilityItem[] = []
  for (const line of stmt.utilities) allItems.push(...line.items)
  const resolved = resolveUtilities(allItems)
  let color = resolved.fill ?? undefined
  for (const sp of stmt.styleProperties) {
    if (sp.name !== 'fill') continue
    const raw = sp.value
    if (raw.startsWith('#')) color = raw
    else {
      const hex = resolveColor(raw)
      if (hex) color = hex
    }
  }
  return color ?? undefined
}

// ═══ New syntax: source/layer ═══

interface SourceDef {
  name: string
  type: string
  url: string
  layers?: string[]
}

function extractSource(stmt: AST.SourceStatement): SourceDef | null {
  let type = 'geojson'
  let url = ''
  let layers: string[] | undefined

  for (const prop of stmt.properties) {
    if (prop.name === 'type' && prop.value.kind === 'Identifier') {
      type = prop.value.name
    } else if (prop.name === 'url' && prop.value.kind === 'StringLiteral') {
      url = prop.value.value
    } else if (prop.name === 'layers') {
      // Accept either `layers: "water"` (single MVT layer) or
      // `layers: ["water", "roads"]` (subset). Anything else is
      // silently ignored — the source still works, just renders all
      // MVT layers as before.
      if (prop.value.kind === 'StringLiteral') {
        layers = [prop.value.value]
      } else if (prop.value.kind === 'ArrayLiteral') {
        const out: string[] = []
        for (const el of prop.value.elements) {
          if (el.kind === 'StringLiteral') out.push(el.value)
        }
        if (out.length > 0) layers = out
      }
    }
  }

  if (!url) return null
  return { name: stmt.name, type, url, layers }
}

function extractLayer(
  stmt: AST.LayerStatement,
  sources: Map<string, SourceDef>,
): { load: LoadCommand; show: ShowCommand } | null {
  // Find source reference + optional sourceLayer slice
  let sourceName = ''
  let sourceLayer: string | undefined
  for (const prop of stmt.properties) {
    if (prop.name === 'source' && prop.value.kind === 'Identifier') {
      sourceName = prop.value.name
    } else if (prop.name === 'sourceLayer' && prop.value.kind === 'StringLiteral') {
      sourceLayer = prop.value.value
    }
  }

  const sourceDef = sources.get(sourceName)
  if (!sourceDef) return null

  // Collect all utility items from all lines
  const allItems: AST.UtilityItem[] = []
  for (const line of stmt.utilities) {
    allItems.push(...line.items)
  }

  // Resolve utilities to properties
  const resolved = resolveUtilities(allItems)

  return {
    load: { name: sourceDef.name, url: sourceDef.url, layers: sourceDef.layers },
    show: {
      targetName: sourceDef.name,
      layerName: sourceDef.name,
      sourceLayer,
      fill: resolved.fill,
      stroke: resolved.stroke,
      strokeWidth: resolved.strokeWidth,
      projection: resolved.projection,
      visible: resolved.visible,
      opacity: resolved.opacity,
      pointerEvents: resolved.pointerEvents,
      paintShapes: synthesizeConstantPaintShapes({
        fill: resolved.fill,
        stroke: resolved.stroke,
        strokeWidth: resolved.strokeWidth,
        opacity: resolved.opacity,
      }),
    },
  }
}

// ═══ Legacy syntax: let/show ═══

function extractLoad(stmt: AST.LetStatement): LoadCommand | null {
  if (stmt.value.kind === 'FnCall') {
    const callee = stmt.value.callee
    if (callee.kind === 'Identifier' && callee.name === 'load') {
      const arg = stmt.value.args[0]
      if (arg && arg.kind === 'StringLiteral') {
        return { name: stmt.name, url: arg.value }
      }
    }
  }
  return null
}

function extractShow(stmt: AST.ShowStatement): ShowCommand | null {
  let targetName = ''
  if (stmt.target.kind === 'Identifier') {
    targetName = stmt.target.name
  }

  let fill: string | null = null
  let stroke: string | null = null
  let strokeWidth = 1
  let projection = 'mercator'
  let visible = true
  let opacity = 1.0

  for (const prop of stmt.block.properties) {
    if (prop.name === 'fill') {
      const val = prop.values[0]
      if (val && val.kind === 'ColorLiteral') {
        fill = val.value
      }
    } else if (prop.name === 'projection') {
      const val = prop.values[0]
      if (val && val.kind === 'Identifier') {
        projection = val.name
      }
    } else if (prop.name === 'visible') {
      const val = prop.values[0]
      if (val && val.kind === 'BoolLiteral') {
        visible = val.value
      }
    } else if (prop.name === 'opacity') {
      const val = prop.values[0]
      if (val && val.kind === 'NumberLiteral') {
        opacity = val.value
      }
    } else if (prop.name === 'stroke') {
      const val = prop.values[0]
      if (val && val.kind === 'ColorLiteral') {
        stroke = val.value
      }
      const widthVal = prop.values[1]
      if (widthVal && widthVal.kind === 'NumberLiteral') {
        strokeWidth = widthVal.value
      }
    }
  }

  return {
    targetName, fill, stroke, strokeWidth, projection, visible, opacity,
    paintShapes: synthesizeConstantPaintShapes({ fill, stroke, strokeWidth, opacity }),
  }
}
