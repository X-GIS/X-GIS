// Source-level `maxzoom` / `minzoom` must survive the whole compile pipeline
// (lower → optimize → emitCommands) onto the LoadCommand the runtime arms from.
//
// This is the DATASET's deepest real level, not a layer's visibility gate. A tile past it
// does not exist, so requesting one is a guaranteed 404 rather than a slow fetch: the AWS
// terrarium bucket stops at z15, and `rasterCoverZoom` asks for zoom+1 on a 256-px source,
// so every visible tile failed from about camera z14.5. Verified against the reported
// failure and its own lineage:
//
//   terrarium/16/13651/25075  -> 404
//   terrarium/15/6825/12537   -> 200, 101 540 bytes
//
// Until now the native `.xgis` grammar had no way to SAY this — `lowerSource` accepted
// only type/url/data/crs/layers/encoding/tileSize and the DEM unpack factors — so the
// compiler could only warn about it on the Mapbox-import path and drop it. The clamp
// itself is gated by map/src/render/raster-cover-zoom.test.ts; this pins the plumbing
// that has to get the number there, which is the half a renderer test cannot see.

import { describe, it, expect } from 'vitest'
import { Lexer, Parser, lower, optimize, emitCommands } from '..'

function loadOf(src: string, name: string) {
  const cmds = emitCommands(optimize(lower(new Parser(new Lexer(src).tokenize()).parse())))
  return cmds.loads.find((l) => l.name === name)
}

describe('source-level maxzoom / minzoom reach the runtime LoadCommand', () => {
  it('a raster-dem source carries its declared depth through to emitCommands', () => {
    const load = loadOf(
      `xgis 1
source terrain {
  type: "raster-dem"
  url: "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
  encoding: terrarium
  tileSize: 256
  maxzoom: 15
}
layer relief { source: terrain }`,
      'terrain',
    )
    expect(load?.maxzoom).toBe(15)
    // tileSize rides alongside — both feed the same cover-zoom decision, and dropping
    // either one reopens the 404.
    expect(load?.tileSize).toBe(256)
  })

  it('carries minzoom too, and both independently', () => {
    const load = loadOf(
      `xgis 1
source s { type: raster url: "https://x/{z}/{x}/{y}.png" minzoom: 3 }
layer l { source: s }`,
      's',
    )
    expect(load?.minzoom).toBe(3)
    expect(load?.maxzoom).toBeUndefined()
  })

  it('a source that declares neither stays undefined — unbounded, as every style is today', () => {
    // The change must be inert for existing styles: `undefined` is what the selector
    // reads as "no cap", so a silent 0 or -1 here would black out every source at once.
    const load = loadOf(
      `xgis 1
source s { type: raster url: "https://x/{z}/{x}/{y}.png" }
layer l { source: s }`,
      's',
    )
    expect(load?.maxzoom).toBeUndefined()
    expect(load?.minzoom).toBeUndefined()
  })

  it('survives optimize() — the pass that already drops paint-less raster layers', () => {
    // emitCommands runs on the OPTIMIZED scene, so a pass that rebuilds SourceDef without
    // copying the new fields would strip them silently and the 404s would come back.
    const load = loadOf(
      `xgis 1
source terrain {
  type: "raster-dem"
  url: "/dem.png"
  encoding: terrarium
  maxzoom: 15
}
layer relief { source: terrain }`,
      'terrain',
    )
    expect(load?.maxzoom).toBe(15)
  })
})
