// Structural coverage test — Mapbox→RenderNode end-to-end.
//
// Every silent-drop regression so far hit a common pattern:
//   1. Mapbox style declares a paint/layout property.
//   2. Converter emits a utility (e.g. `stroke-[…]` or `label-color-#666`).
//   3. lower.ts has no handler for that named utility.
//   4. emit-commands sees `undefined` and threads `undefined` onto
//      ShowCommand.
//   5. Runtime sees `undefined` and falls back to the default (1 px,
//      black, etc.) without a single warning.
//
// The fix surface that prevents these is a structural assertion:
// for every Mapbox property the source style sets, the corresponding
// ShowCommand field MUST be populated. This file pins those mappings
// against the two fixture styles we care about — OFM Bright and the
// MapLibre demo — so a future converter regression fails CI before
// the user can spot the missing feature on a screenshot.

import { describe, it, expect } from 'vitest'
import {
  convertMapboxStyle, Lexer, Parser, lower, emitCommands,
  type MapboxLayer,
} from '../index'
import { sanitizeId } from '../convert/utils'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OFM_BRIGHT = JSON.parse(readFileSync(join(HERE, 'fixtures', 'openfreemap-bright.json'), 'utf8'))
const MAPLIBRE_DEMO = JSON.parse(readFileSync(join(HERE, 'fixtures', 'maplibre-demotiles.json'), 'utf8'))

interface ShowSample {
  layerName: string
  fill: string | null
  stroke: string | null
  strokeWidth: number
  strokeWidthExpr?: unknown
  strokeOffset?: number
  strokeBlur?: number
  opacity: number
  zoomOpacityStops: unknown
  size: number | null
  zoomSizeStops: unknown
  visible: boolean
  filterExpr: unknown
  minzoom?: number
  maxzoom?: number
  label?: {
    color?: [number, number, number, number]
    colorZoomStops?: unknown[]
    colorExpr?: unknown
    size: number
    sizeZoomStops?: unknown[]
    sizeExpr?: unknown
    font?: string[]
    fontWeight?: number
    halo?: { color: unknown; width: number; blur?: number }
    haloWidthZoomStops?: unknown[]
    placement?: string
  }
}

function pipeline(style: unknown): ShowSample[] {
  const xgis = convertMapboxStyle(style as never)
  const tokens = new Lexer(xgis).tokenize()
  const ast = new Parser(tokens).parse()
  const scene = lower(ast)
  // Surface diagnostics from the lower pass — pinning that we don't
  // accidentally emit a binding-form utility without a handler.
  for (const d of scene.diagnostics) {
    if (d.severity === 'error') throw new Error(`lower error: ${d.message}`)
    if (d.severity === 'warn' && d.code === 'X-GIS0005') {
      throw new Error(`Silent-drop binding: ${d.message}`)
    }
  }
  const cmds = emitCommands(scene)
  return cmds.shows as unknown as ShowSample[]
}

function findShow(shows: ShowSample[], mapboxId: string): ShowSample | undefined {
  const id = sanitizeId(mapboxId)
  // symbol-placement step splits one Mapbox layer into multiple xgis
  // blocks suffixed `_0`, `_1`, … Pick the first one (the split keeps
  // every paint/layout property uniform across segments).
  return shows.find(s => s.layerName === id || s.layerName?.startsWith(id + '_0'))
}

// ── Per-property assertions ─────────────────────────────────────────
// Each helper picks the Mapbox property out of the layer and checks
// the corresponding ShowCommand field. Returns null on pass; non-null
// is the failure message. We collect all failures across all layers
// and report them in one batch so a single test run surfaces every
// regression at once.

function checkPaint(layer: MapboxLayer, show: ShowSample | undefined): string[] {
  const fails: string[] = []
  const paint = (layer.paint ?? {}) as Record<string, unknown>
  const layout = ((layer as { layout?: Record<string, unknown> }).layout ?? {})

  if (!show) {
    // Skipped layers (icon-only symbols, heatmap, hillshade) → only OK
    // if the source explicitly has no rendering. background layer
    // doesn't get its own ShowCommand.
    if (layer.type === 'background') return fails
    if (layer.type === 'heatmap' || layer.type === 'hillshade') return fails
    if (layer.type === 'symbol' && layout['text-field'] === undefined) return fails
    fails.push(`[${layer.id}] no ShowCommand emitted (layer.type=${layer.type})`)
    return fails
  }

  // ── line ──
  if (layer.type === 'line') {
    if (paint['line-color'] !== undefined) {
      if (!show.stroke) fails.push(`[${layer.id}] line-color set but show.stroke is null`)
    }
    if (paint['line-width'] !== undefined) {
      const lw = paint['line-width']
      if (typeof lw === 'number') {
        if (show.strokeWidth !== lw) {
          fails.push(`[${layer.id}] line-width=${lw} but show.strokeWidth=${show.strokeWidth}`)
        }
      } else {
        // interpolate / expression — must end up in strokeWidthExpr
        if (show.strokeWidthExpr === undefined && show.strokeWidth === 1) {
          fails.push(`[${layer.id}] line-width is non-constant but strokeWidthExpr is undefined AND strokeWidth is the default 1`)
        }
      }
    }
    if (paint['line-offset'] !== undefined && typeof paint['line-offset'] === 'number' && paint['line-offset'] !== 0) {
      if (show.strokeOffset === undefined || show.strokeOffset === 0) {
        fails.push(`[${layer.id}] line-offset=${paint['line-offset']} but show.strokeOffset=${show.strokeOffset}`)
      }
    }
    if (paint['line-blur'] !== undefined && typeof paint['line-blur'] === 'number' && paint['line-blur'] !== 0) {
      if (show.strokeBlur === undefined || show.strokeBlur === 0) {
        fails.push(`[${layer.id}] line-blur=${paint['line-blur']} but show.strokeBlur=${show.strokeBlur}`)
      }
    }
  }

  // ── fill ──
  if (layer.type === 'fill') {
    if (paint['fill-color'] !== undefined) {
      if (!show.fill) fails.push(`[${layer.id}] fill-color set but show.fill is null`)
    }
    if (paint['fill-outline-color'] !== undefined) {
      // Lowers to a stroke utility — fill layer gains a stroke colour.
      if (!show.stroke) {
        fails.push(`[${layer.id}] fill-outline-color set but show.stroke is null`)
      }
    }
  }

  // ── circle ──
  if (layer.type === 'circle') {
    if (paint['circle-color'] !== undefined && !show.fill) {
      fails.push(`[${layer.id}] circle-color set but show.fill is null`)
    }
    if (paint['circle-radius'] !== undefined) {
      const r = paint['circle-radius']
      if (typeof r === 'number') {
        if (show.size !== r) {
          fails.push(`[${layer.id}] circle-radius=${r} but show.size=${show.size}`)
        }
      } else {
        // non-constant → zoomSizeStops or sizeExpr
        if ((!show.zoomSizeStops || (show.zoomSizeStops as unknown[]).length === 0) && show.size === null) {
          fails.push(`[${layer.id}] circle-radius is non-constant but no zoomSizeStops and size=null`)
        }
      }
    }
  }

  // ── symbol (text labels) ──
  if (layer.type === 'symbol' && layout['text-field'] !== undefined) {
    const label = show.label
    if (!label) {
      fails.push(`[${layer.id}] symbol with text-field but show.label is undefined`)
      return fails
    }
    // text-color → label.color or colorZoomStops or colorExpr.
    // (The runtime resolves the constant from colorZoomStops too.)
    if (paint['text-color'] !== undefined) {
      const hasColor =
        label.color !== undefined ||
        (label.colorZoomStops && label.colorZoomStops.length > 0) ||
        label.colorExpr !== undefined
      if (!hasColor) {
        fails.push(`[${layer.id}] text-color set but label has no color / colorZoomStops / colorExpr`)
      }
    }
    // text-size → label.size > 0 OR sizeZoomStops OR sizeExpr.
    if (layout['text-size'] !== undefined) {
      const hasSize =
        label.size > 0 ||
        (label.sizeZoomStops && label.sizeZoomStops.length > 0) ||
        label.sizeExpr !== undefined
      if (!hasSize) {
        fails.push(`[${layer.id}] text-size set but label has no size / sizeZoomStops / sizeExpr`)
      }
    }
    // text-font → label.font set (when array of strings).
    if (Array.isArray(layout['text-font']) && (layout['text-font'] as string[]).length > 0) {
      if (!label.font || label.font.length === 0) {
        fails.push(`[${layer.id}] text-font set but label.font is empty`)
      }
    }
    // text-halo-color + text-halo-width → label.halo set (either both
    // present as constants or via zoom stops).
    if (paint['text-halo-color'] !== undefined && paint['text-halo-width'] !== undefined) {
      const hasHalo =
        label.halo !== undefined ||
        (label.haloWidthZoomStops && label.haloWidthZoomStops.length > 0)
      if (!hasHalo) {
        fails.push(`[${layer.id}] text-halo-color+width set but label has no halo / haloWidthZoomStops`)
      }
    }
    // symbol-placement: line → label.placement === 'line'
    if (layout['symbol-placement'] === 'line') {
      if (label.placement !== 'line') {
        fails.push(`[${layer.id}] symbol-placement=line but label.placement=${label.placement}`)
      }
    }
  }

  // ── filter ──
  if (layer.filter !== undefined) {
    // Geometry-type / id filter is now preserved; check that SOME
    // filter expression is set (we may simplify or rewrite it).
    if (show.filterExpr === null) {
      fails.push(`[${layer.id}] layer.filter set but show.filterExpr is null`)
    }
  }

  // ── visibility, minzoom, maxzoom ──
  if (layout['visibility'] === 'none' && show.visible !== false) {
    fails.push(`[${layer.id}] visibility=none but show.visible=${show.visible}`)
  }
  if (typeof layer.minzoom === 'number' && show.minzoom !== layer.minzoom) {
    fails.push(`[${layer.id}] minzoom=${layer.minzoom} but show.minzoom=${show.minzoom}`)
  }
  if (typeof layer.maxzoom === 'number' && show.maxzoom !== layer.maxzoom) {
    fails.push(`[${layer.id}] maxzoom=${layer.maxzoom} but show.maxzoom=${show.maxzoom}`)
  }

  return fails
}

// ── Known-broken allowlist ──────────────────────────────────────────
// Each entry is a Mapbox→ShowCommand gap that exists at the time
// this test landed. Removing an entry as the underlying bug is
// fixed keeps the safety net useful. The CI gate fails when:
//   (a) a NEW gap appears that's NOT in the allowlist (regression), OR
//   (b) an ALLOWLISTED gap no longer reproduces (entry is stale).
// This pattern makes silent-drops impossible to add and makes
// fixes self-policing — see /docs/mapbox-spec drift detector.

const KNOWN_GAPS_OFM_BRIGHT: ReadonlySet<string> = new Set([
  // (No outstanding gaps. All previously documented bugs are fixed.)
])

const KNOWN_GAPS_MAPLIBRE_DEMO: ReadonlySet<string> = new Set([
  // text-field as legacy stops: `{"stops": [[2, "{ABBREV}"], [4, "{NAME}"]]}`.
  // The converter's textFieldToXgisExpr doesn't recognise the stops
  // shape and returns null, so the entire symbol layer is SKIPPED.
  // Follow-up: lift legacy text-field stops to a step() / interpolate
  // call so the label survives compilation.
  '[countries-label] no ShowCommand emitted (layer.type=symbol)',
])

function runCoverage(name: string, style: unknown, layers: MapboxLayer[], knownGaps: ReadonlySet<string>): void {
  describe(`Mapbox→RenderNode structural coverage — ${name}`, () => {
    const shows = pipeline(style)

    it('only KNOWN gaps appear — every other property is preserved end-to-end', () => {
      const fails: string[] = []
      for (const layer of layers) {
        const show = findShow(shows, layer.id)
        fails.push(...checkPaint(layer, show))
      }
      fails.sort()
      const newFails = fails.filter(f => !knownGaps.has(f))
      const staleAllowlist = [...knownGaps].filter(g => !fails.includes(g))
      const messages: string[] = []
      if (newFails.length > 0) {
        messages.push(`NEW structural coverage gaps (regression — fix or add to KNOWN_GAPS):\n${newFails.join('\n')}`)
      }
      if (staleAllowlist.length > 0) {
        messages.push(`STALE KNOWN_GAPS entries (the underlying bug is fixed — remove these from the allowlist):\n${staleAllowlist.join('\n')}`)
      }
      expect(messages, messages.join('\n\n')).toEqual([])
    })
  })
}

runCoverage('OFM Bright', OFM_BRIGHT, OFM_BRIGHT.layers as MapboxLayer[], KNOWN_GAPS_OFM_BRIGHT)
runCoverage('MapLibre demo', MAPLIBRE_DEMO, MAPLIBRE_DEMO.layers as MapboxLayer[], KNOWN_GAPS_MAPLIBRE_DEMO)

describe('lower silent-drop diagnostic — X-GIS0005', () => {
  it('binding-form utility with no handler surfaces as a diagnostic', () => {
    // Synthetic xgis source with a binding-form utility that lower.ts
    // has no handler for (`foo-bar-[expr]`). Before the diagnostic,
    // this would silently drop. Now it raises X-GIS0005.
    const src = `
source v { type: pmtiles, url: "x.pmtiles" }
layer L {
  source: v
  sourceLayer: "x"
  | unknown-name-[interpolate(zoom, 0, 1, 10, 5)]
}
`
    const tokens = new Lexer(src).tokenize()
    const ast = new Parser(tokens).parse()
    const scene = lower(ast)
    const drops = scene.diagnostics.filter(d => d.code === 'X-GIS0005')
    expect(drops.length).toBeGreaterThan(0)
    expect(drops[0]!.severity).toBe('warn')
  })

  it('known binding utilities (`stroke-[…]`, `fill-[…]`, etc.) do NOT trip the diagnostic', () => {
    const src = `
source v { type: pmtiles, url: "x.pmtiles" }
layer R {
  source: v
  sourceLayer: "x"
  | stroke-[interpolate_exp(zoom, 1.2, 14, 2.5, 20, 11.5)]
}
layer F {
  source: v
  sourceLayer: "y"
  | fill-[interpolate(zoom, 0, #fff, 10, #000)]
}
`
    const tokens = new Lexer(src).tokenize()
    const ast = new Parser(tokens).parse()
    const scene = lower(ast)
    const drops = scene.diagnostics.filter(d => d.code === 'X-GIS0005')
    expect(drops).toEqual([])
  })
})
