// #777 Phase II — a raster-dem source + a paint-less layer must survive the
// full compile pipeline (lower → optimize → emitCommands) as a raster-dem LoadCommand
// with the DEM decode threaded. Two regressions this locks:
//   1. A hyphenated built-in type (`raster-dem`) must be a QUOTED string in .xgis
//      (bare `raster-dem` lexes as the expression `raster - dem`) — else the type
//      silently defaults to geojson.
//   2. optimize()'s dead-layer-elim keeps a paint-less layer over a raster-dem
//      source (like raster) — else the hillshade layer is dropped before it ever
//      reaches the runtime (which routes raster-dem → HillshadeRenderer).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Lexer, Parser, lower, optimize, emitCommands } from '..'

function compile(src: string) {
  const scene = lower(new Parser(new Lexer(src).tokenize()).parse())
  return emitCommands(optimize(scene))
}

describe('#777 raster-dem → hillshade compile pipeline', () => {
  it('a quoted raster-dem source + paint-less layer survives optimize as a raster-dem load', () => {
    const cmds = compile(`xgis 1
source dem {
  type: "raster-dem"
  url: "/dem-fixture.png"
  encoding: mapbox
}
layer relief { source: dem }`)
    const dem = cmds.loads.find((l) => l.name === 'dem')
    expect(dem?.type).toBe('raster-dem')
    expect(dem?.encoding).toBe('mapbox')
    // The paint-less layer is NOT dead-eliminated (raster-dem is renderable via
    // the HillshadeRenderer, mirroring the raster keep-guard).
    expect(cmds.shows.map((s) => s.targetName)).toContain('dem')
  })

  it('threads tileSize + terrarium encoding through to the load', () => {
    const cmds = compile(`xgis 1
source dem {
  type: "raster-dem"
  url: "/dem/{z}/{x}/{y}.png"
  encoding: terrarium
  tileSize: 256
}
layer relief { source: dem }`)
    const dem = cmds.loads.find((l) => l.name === 'dem')
    expect(dem?.encoding).toBe('terrarium')
    expect(dem?.tileSize).toBe(256)
  })

  it('the REAL terrarium gallery example compiles with its authored paint intact', () => {
    // Compiles the actual playground example (single source of truth — the
    // same file the gallery serves), not an inline copy, so gallery drift
    // fails here first. Locks: .xgis-authored hillshade utilities (decimal
    // exaggeration suffix, #hex colour suffixes) survive lex → parse →
    // lower → optimize → emitCommands into the paintShapes.hillshade bundle.
    const src = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        '..',
        'playground',
        'src',
        'examples',
        'hillshade-terrarium.xgis',
      ),
      'utf8',
    )
    const cmds = compile(src)
    const dem = cmds.loads.find((l) => l.name === 'terrain')
    expect(dem?.type).toBe('raster-dem')
    expect(dem?.encoding).toBe('terrarium')
    expect(dem?.tileSize).toBe(256)
    expect(dem?.url).toContain('{z}/{x}/{y}')

    const show = cmds.shows.find((s) => s.targetName === 'terrain')
    expect(show).toBeDefined()
    const hs = show!.paintShapes?.hillshade
    expect(hs).toBeDefined()
    expect(hs!.exaggeration).toEqual({ kind: 'constant', value: 0.6 })
    expect(hs!.direction).toEqual({ kind: 'constant', value: 315 })
    // #3d2b1f / #fffcf5 / #4d3a26 → normalized rgba (8-bit / 255).
    const rgb = (hex: string): number[] => [
      parseInt(hex.slice(0, 2), 16) / 255,
      parseInt(hex.slice(2, 4), 16) / 255,
      parseInt(hex.slice(4, 6), 16) / 255,
      1,
    ]
    expect(hs!.shadow).toEqual({ kind: 'constant', value: rgb('3d2b1f') })
    expect(hs!.highlight).toEqual({ kind: 'constant', value: rgb('fffcf5') })
    expect(hs!.accent).toEqual({ kind: 'constant', value: rgb('4d3a26') })
    // Unauthored axes seed the spec defaults (bundle is total, not sparse).
    expect(hs!.altitude).toEqual({ kind: 'constant', value: 45 })
    expect(hs!.method).toBe('standard')
    expect(hs!.extraSources).toEqual([])
  })

  it('the REAL multidirectional gallery example compiles with all four sources intact', () => {
    const src = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        '..',
        'playground',
        'src',
        'examples',
        'hillshade-multidir.xgis',
      ),
      'utf8',
    )
    const cmds = compile(src)
    const hs = cmds.shows.find((s) => s.targetName === 'terrain')!.paintShapes?.hillshade
    expect(hs).toBeDefined()
    expect(hs!.method).toBe('multidirectional')
    expect(hs!.direction).toEqual({ kind: 'constant', value: 225 })
    expect(hs!.altitude).toEqual({ kind: 'constant', value: 30 })
    expect(hs!.extraSources.map((s) => [s.direction, s.altitude])).toEqual([
      [270, 30],
      [315, 40],
      [355, 45],
    ])
  })

  it('multidirectional source-2..4 utilities fold into extraSources (missing axes ← source 1)', () => {
    const cmds = compile(`xgis 1
source dem {
  type: "raster-dem"
  url: "/dem-fixture.png"
  encoding: mapbox
}
layer relief {
  source: dem
  | hillshade-method-multidirectional hillshade-illumination-direction-225
  | hillshade-illumination-direction2-270 hillshade-illumination-altitude2-30
  | hillshade-shadow-color2-#402000 hillshade-highlight-color2-#ffe0c0
  | hillshade-illumination-direction3-315
}`)
    const hs = cmds.shows.find((s) => s.targetName === 'dem')!.paintShapes?.hillshade
    expect(hs).toBeDefined()
    expect(hs!.method).toBe('multidirectional')
    expect(hs!.direction).toEqual({ kind: 'constant', value: 225 })
    expect(hs!.extraSources).toEqual([
      {
        direction: 270,
        altitude: 30,
        shadow: [0x40 / 255, 0x20 / 255, 0, 1],
        highlight: [1, 0xe0 / 255, 0xc0 / 255, 1],
      },
      // Source 3 authored only a direction — the other axes resolve from
      // source 1 (repeat-last padding collapsed to source 1 in the IR).
      {
        direction: 315,
        altitude: 45,
        shadow: [0, 0, 0, 1],
        highlight: [1, 1, 1, 1],
      },
    ])
  })
})
