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
})
