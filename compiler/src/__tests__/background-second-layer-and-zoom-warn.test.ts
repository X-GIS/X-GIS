// #2333 — two silent gaps in background-layer conversion:
//
//  1. mapbox-to-xgis.ts bound only the FIRST `background`-type layer
//     (via `layersArr.find`) and the main per-layer loop skipped every
//     background layer — including any others — with an unconditional
//     `continue` and no warning. A style that zoom-partitions its
//     background colour across two `background` layers (a real,
//     spec-legal day/night or land/ocean pattern) silently lost the
//     second one.
//  2. convertBackgroundLayer never read `minzoom` / `maxzoom` on the
//     background layer, so an authored zoom bound was silently
//     ignored — the background rendered at every zoom regardless.
//
// Both now warn (warning-only fix — X-GIS still renders one background
// at every zoom; this just stops the drop from being silent) and the
// coverage record for a dropped background layer carries a non-empty
// `reasons` instead of claiming `action: 'converted'` with none.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle, type StyleCoverage } from '../convert/mapbox-to-xgis'

function convert(style: unknown): { code: string; coverage: StyleCoverage } {
  const coverage: StyleCoverage = { sources: [], layers: [], warnings: [] }
  const code = convertMapboxStyle(style as never, { coverage })
  return { code, coverage }
}

describe('background: second layer dropped + minzoom/maxzoom ignored (#2333)', () => {
  it('a second background layer is reported dropped, with a non-empty reasons entry', () => {
    const style = {
      version: 8,
      sources: {},
      layers: [
        { id: 'bg1', type: 'background', maxzoom: 6, paint: { 'background-color': '#111111' } },
        { id: 'bg2', type: 'background', minzoom: 6, paint: { 'background-color': '#eeeeee' } },
      ],
    }
    const { code, coverage } = convert(style)

    // Only bg1's colour is emitted — X-GIS still renders one background.
    expect(code).toContain('background { fill: #111111 }')
    expect(code).not.toContain('#eeeeee')

    // The drop is no longer silent: a warning names bg2.
    expect(code).toMatch(/bg2/)
    // bg1's own maxzoom is also ignored by the emitted directive — warned too.
    expect(code).toMatch(/maxzoom/)

    // Coverage: bg2 is recorded as dropped, not as a clean "converted".
    const bg1Row = coverage.layers.find((l) => l.layerId === 'bg1')
    const bg2Row = coverage.layers.find((l) => l.layerId === 'bg2')
    expect(bg1Row).toBeDefined()
    expect(bg1Row!.action).not.toBe('converted') // ignored maxzoom makes it lossy, not clean
    expect(bg1Row!.reasons.length).toBeGreaterThan(0)
    expect(bg2Row).toBeDefined()
    expect(bg2Row!.action).toBe('skipped')
    expect(bg2Row!.reasons.length).toBeGreaterThan(0)
    expect(bg2Row!.reasons.join(' ')).toMatch(/bg2|only one background/)
  })

  it('minzoom > 0 on a single background layer warns', () => {
    const style = {
      version: 8,
      sources: {},
      layers: [
        { id: 'bg', type: 'background', minzoom: 4, paint: { 'background-color': '#abcdef' } },
      ],
    }
    const { code, coverage } = convert(style)

    expect(code).toContain('background { fill: #abcdef }')
    expect(code).toMatch(/minzoom/)
    const bgRow = coverage.layers.find((l) => l.layerId === 'bg')
    expect(bgRow).toBeDefined()
    expect(bgRow!.reasons.length).toBeGreaterThan(0)
    expect(bgRow!.reasons.join(' ')).toMatch(/minzoom/)
  })

  it('CONTROL: a background layer with neither minzoom nor maxzoom stays warning-free', () => {
    const style = {
      version: 8,
      sources: {},
      layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#abcdef' } }],
    }
    const { code, coverage } = convert(style)

    expect(code).toContain('background { fill: #abcdef }')
    expect(code).not.toMatch(/minzoom|maxzoom/)
    const bgRow = coverage.layers.find((l) => l.layerId === 'bg')
    expect(bgRow).toBeDefined()
    expect(bgRow!.action).toBe('converted')
    expect(bgRow!.reasons).toEqual([])
  })

  it('CONTROL: an explicit maxzoom:24 (the spec default) stays warning-free', () => {
    // #2333 correction — maplibre-demotiles.json's background layer
    // authors exactly this (maxzoom: 24, no minzoom). 24 is the top of
    // the Mapbox spec's [0, 24] zoom range (validate-layers.ts uses the
    // same window), so restating it authors no actual restriction; the
    // gate (minzoom > 0 || maxzoom < 24) deliberately treats it as
    // "no bound authored" rather than flagging every style that merely
    // spells out the default.
    const style = {
      version: 8,
      sources: {},
      layers: [
        { id: 'bg', type: 'background', maxzoom: 24, paint: { 'background-color': '#abcdef' } },
      ],
    }
    const { code, coverage } = convert(style)

    expect(code).toContain('background { fill: #abcdef }')
    expect(code).not.toMatch(/minzoom|maxzoom/)
    const bgRow = coverage.layers.find((l) => l.layerId === 'bg')
    expect(bgRow).toBeDefined()
    expect(bgRow!.action).toBe('converted')
    expect(bgRow!.reasons).toEqual([])
  })
})
