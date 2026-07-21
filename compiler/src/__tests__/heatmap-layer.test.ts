// Mapbox `heatmap` layer → xgis heatmap layer (Phase R). The converter
// un-SKIPs heatmap and emits a `heatmap` marker + heatmap-radius/-weight/
// -intensity/-opacity utilities the runtime routes to the HeatmapRenderer.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'
import { convertHeatmapLayer } from '../convert/layers-heatmap'
import { Lexer, Parser, lower, emitCommands } from '../index'
import { optimize } from '../ir/optimize'
import { withPragma } from './_pragma'

describe('heatmap layer conversion', () => {
  it('basic heatmap emits a heatmap layer body (not SKIPPED)', () => {
    const style = {
      version: 8,
      sources: { quakes: { type: 'geojson', data: 'quakes.geojson' } },
      layers: [
        {
          id: 'quake-heat',
          type: 'heatmap',
          source: 'quakes',
          paint: {
            'heatmap-radius': 25,
            'heatmap-weight': 2,
            'heatmap-intensity': 3,
            'heatmap-opacity': 0.8,
          },
        },
      ],
    }
    const xgis = convertMapboxStyle(style as never)
    // sanitizeId maps the `-` in the id to `_`.
    expect(xgis).toContain('layer quake_heat {')
    expect(xgis).not.toContain('SKIPPED')
    // The marker + each scalar paint axis.
    expect(xgis).toContain('heatmap ') // marker (followed by other utils)
    expect(xgis).toContain('heatmap-radius-25')
    expect(xgis).toContain('heatmap-weight-2')
    expect(xgis).toContain('heatmap-intensity-3')
    expect(xgis).toContain('heatmap-opacity-0.8')
  })

  it('omitted paint props emit Mapbox-spec defaults', () => {
    const warnings: string[] = []
    const out = convertHeatmapLayer({ id: 'h', type: 'heatmap', source: 's' } as never, warnings)
    expect(out).toContain('layer h {')
    expect(out).toContain('heatmap ')
    expect(out).toContain('heatmap-radius-30') // spec default
    expect(out).toContain('heatmap-weight-1')
    expect(out).toContain('heatmap-intensity-1')
    expect(out).toContain('heatmap-opacity-1')
  })

  it('zoom-interp radius emits the bracket binding form', () => {
    const warnings: string[] = []
    const out = convertHeatmapLayer(
      {
        id: 'h',
        type: 'heatmap',
        source: 's',
        paint: {
          'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 0, 2, 9, 20],
        },
      } as never,
      warnings,
    )
    expect(out).toContain('heatmap-radius-[')
    expect(out).not.toContain('SKIPPED')
  })

  it('custom heatmap-color linear ramp emits the density bracket binding', () => {
    const warnings: string[] = []
    const out = convertHeatmapLayer(
      {
        id: 'h',
        type: 'heatmap',
        source: 's',
        paint: {
          'heatmap-color': [
            'interpolate',
            ['linear'],
            ['heatmap-density'],
            0,
            'rgba(0,0,255,0)',
            1,
            '#ff0000',
          ],
        },
      } as never,
      warnings,
    )
    // Colours normalise to 8-digit hex; input is the heatmap_density identifier.
    expect(out).toContain(
      'heatmap-color-[interpolate(heatmap_density, 0, #0000ff00, 1, #ff0000ff)]',
    )
    expect(warnings.some((w) => w.includes('heatmap-color'))).toBe(false)
  })

  it('step heatmap-color emits duplicated boundary stops (hard edges)', () => {
    const warnings: string[] = []
    const out = convertHeatmapLayer(
      {
        id: 'h',
        type: 'heatmap',
        source: 's',
        paint: {
          'heatmap-color': ['step', ['heatmap-density'], '#000000', 0.5, '#ffffff'],
        },
      } as never,
      warnings,
    )
    // 0 → black, boundary-ε → black, boundary → white.
    expect(out).toContain('heatmap-color-[interpolate(heatmap_density, 0, #000000ff, ')
    expect(out).toContain('0.5, #ffffffff)]')
    expect(warnings.some((w) => w.includes('heatmap-color'))).toBe(false)
  })

  it('exponential heatmap-color densifies to piecewise-linear stops', () => {
    const warnings: string[] = []
    const out = convertHeatmapLayer(
      {
        id: 'h',
        type: 'heatmap',
        source: 's',
        paint: {
          'heatmap-color': [
            'interpolate',
            ['exponential', 2],
            ['heatmap-density'],
            0,
            '#000000',
            1,
            '#ffffff',
          ],
        },
      } as never,
      warnings,
    )
    const m = out.match(/heatmap-color-\[interpolate\(heatmap_density, ([^\]]+)\)\]/)
    expect(m).not.toBeNull()
    // 1 raw first stop + 6 densified samples = 7 (offset, colour) pairs.
    expect(m![1]!.split(', ').length).toBe(14)
    expect(warnings.some((w) => w.includes('heatmap-color'))).toBe(false)
  })

  it('non-constant heatmap-color stop colours warn + fall back to the default ramp', () => {
    const warnings: string[] = []
    const out = convertHeatmapLayer(
      {
        id: 'h',
        type: 'heatmap',
        source: 's',
        paint: {
          'heatmap-color': [
            'interpolate',
            ['linear'],
            ['heatmap-density'],
            0,
            ['get', 'c'],
            1,
            '#ff0000',
          ],
        },
      } as never,
      warnings,
    )
    expect(out).not.toContain('heatmap-color-[')
    expect(warnings.some((w) => w.includes('heatmap-color'))).toBe(true)
  })

  it('heatmap-color ramp reaches the ShowCommand as RGBA stop tuples', () => {
    const style = {
      version: 8,
      sources: { quakes: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'quake-heat',
          type: 'heatmap',
          source: 'quakes',
          paint: {
            'heatmap-color': [
              'interpolate',
              ['linear'],
              ['heatmap-density'],
              0,
              'rgba(0,0,255,0)',
              0.5,
              '#00ff00',
              1,
              '#ff0000',
            ],
          },
        },
      ],
    }
    const xgis = convertMapboxStyle(style as never)
    let ir = lower(new Parser(new Lexer(withPragma(xgis)).tokenize()).parse())
    ir = optimize(ir)
    const cmds = emitCommands(ir)
    const heat = cmds.shows.find((s) => s.isHeatmap)
    expect(heat).toBeDefined()
    expect(heat!.heatmapColorStops).toEqual([
      { offset: 0, rgba: [0, 0, 1, 0] },
      { offset: 0.5, rgba: [0, 1, 0, 1] },
      { offset: 1, rgba: [1, 0, 0, 1] },
    ])
  })

  it('the REAL heatmap-ramp gallery example compiles with its inferno stops intact', () => {
    // Compiles the actual playground example (single source of truth — the
    // same file the gallery serves), so gallery drift fails here first.
    const src = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        '..',
        'playground',
        'src',
        'examples',
        'heatmap-ramp.xgis',
      ),
      'utf8',
    )
    const cmds = emitCommands(optimize(lower(new Parser(new Lexer(src).tokenize()).parse())))
    const heat = cmds.shows.find((s) => s.isHeatmap)
    expect(heat).toBeDefined()
    expect(heat!.heatmapColorStops?.length).toBe(5)
    expect(heat!.heatmapColorStops?.[0]).toEqual({ offset: 0, rgba: [0, 0, 0, 0] })
    expect(heat!.heatmapColorStops?.[4]?.offset).toBe(1)
  })

  it('visibility:none emits visible:false', () => {
    const warnings: string[] = []
    const out = convertHeatmapLayer(
      { id: 'h', type: 'heatmap', source: 's', layout: { visibility: 'none' } } as never,
      warnings,
    )
    expect(out).toContain('visible: false')
  })
})
