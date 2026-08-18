// Source-level `refresh: <seconds>` — declarative live-source polling (#1304). The
// motivating case: the NOAA CO-OPS live-currents demo re-fetches every ~6 minutes
// with a host `setInterval` + `setSourceData` (#1272/#1301). `.xgis` is a static
// scene description, so there was no way to declare "re-fetch this source on an
// interval" — this pins that a `refresh:` reserved source prop survives the whole
// compile pipeline (lower → optimize → emitCommands) onto the LoadCommand the
// runtime arms `_armRefresh` from (map/src/source-manager.ts).
//
// `360s` already lexes as a unit-tagged NumberLiteral — `s` is a registered unit
// token alongside px/m/km/nm/deg (compiler/src/lexer/tokens.ts:100) — so this
// needed no lexer/parser change, only a `lowerSource` arm.

import { describe, it, expect } from 'vitest'
import { Lexer, Parser, lower, optimize, emitCommands } from '..'

function loadOf(src: string, name: string) {
  const cmds = emitCommands(optimize(lower(new Parser(new Lexer(src).tokenize()).parse())))
  return cmds.loads.find((l) => l.name === name)
}

function lowerSrc(src: string) {
  return lower(new Parser(new Lexer(src).tokenize()).parse())
}

describe('source-level `refresh:` reaches the runtime LoadCommand (#1304)', () => {
  it('a bare number means seconds', () => {
    const load = loadOf(
      `xgis 1
source currents {
  type: geojson
  url: "https://api.tidesandcurrents.noaa.gov/currents-latest.json"
  refresh: 300
}
layer l { source: currents, fill: #0000ff }`,
      'currents',
    )
    expect(load?.refresh).toBe(300)
  })

  it('an explicit `s` unit literal also means seconds (the issue-body example, `refresh: 360s`)', () => {
    const load = loadOf(
      `xgis 1
source currents {
  type: geojson
  url: "https://x/currents.json"
  refresh: 360s
}
layer l { source: currents, fill: #0000ff }`,
      'currents',
    )
    expect(load?.refresh).toBe(360)
  })

  it('a custom (`x-*`) source type carries refresh too — the polling loop is type-agnostic', () => {
    const load = loadOf(
      `xgis 1
source stations {
  type: "json"
  url: "https://x/stations.json"
  refresh: 120
}
layer l { source: stations, fill: #0000ff }`,
      'stations',
    )
    expect(load?.refresh).toBe(120)
    // `refresh` is now a RESERVED key — it must not leak into the custom-loader
    // options bag alongside the genuinely-custom fields.
    expect(load?.options).toBeUndefined()
  })

  it('a source that does not declare refresh stays undefined — inert for every existing style', () => {
    const load = loadOf(
      `xgis 1
source s { type: geojson url: "https://x/s.geojson" }
layer l { source: s, fill: #ff0000 }`,
      's',
    )
    expect(load?.refresh).toBeUndefined()
  })

  it('`refresh: 0` disables polling — same as absent, not a zero-second busy-loop', () => {
    const load = loadOf(
      `xgis 1
source s { type: geojson url: "https://x/s.geojson" refresh: 0 }
layer l { source: s, fill: #ff0000 }`,
      's',
    )
    expect(load?.refresh).toBeUndefined()
  })

  it('survives optimize() — the pass that already drops paint-less layers/sources', () => {
    const load = loadOf(
      `xgis 1
source currents {
  type: geojson
  url: "https://x/currents.json"
  refresh: 360
}
layer l { source: currents, fill: #0000ff }`,
      'currents',
    )
    expect(load?.refresh).toBe(360)
  })

  it('rejects a negative refresh — a compile-time error, not a runtime surprise', () => {
    expect(() =>
      lowerSrc(
        `xgis 1
source s { type: geojson url: "https://x/s.geojson" refresh: -5 }
layer l { source: s, fill: #ff0000 }`,
      ),
    ).toThrow(/refresh.*non-negative/i)
  })

  it('rejects a non-seconds unit (e.g. `ms`) rather than silently misreading the cadence', () => {
    // `refresh: 500ms` would otherwise silently be read as 500 SECONDS (1000x too
    // slow) if the unit were ignored — reject instead of guessing.
    expect(() =>
      lowerSrc(
        `xgis 1
source s { type: geojson url: "https://x/s.geojson" refresh: 500ms }
layer l { source: s, fill: #ff0000 }`,
      ),
    ).toThrow(/refresh.*seconds/i)
  })

  it('rejects a non-numeric refresh value', () => {
    expect(() =>
      lowerSrc(
        `xgis 1
source s { type: geojson url: "https://x/s.geojson" refresh: "300" }
layer l { source: s, fill: #ff0000 }`,
      ),
    ).toThrow(/refresh.*seconds/i)
  })
})
