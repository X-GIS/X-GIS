// Pin: each "silently dropped property" warning class fires exactly
// where expected. The conversion-notes block is the only user-visible
// signal for properties that the converter drops without an IR-side
// equivalent — a regression that removes any of these warnings is a
// silent-drop regression, and the tests below catch it.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function warningsOf(style: unknown): string[] {
  const out = convertMapboxStyle(style as never)
  const lines = out.split('\n')
  const warnings: string[] = []
  let inNotes = false
  for (const l of lines) {
    if (l.includes('Conversion notes')) {
      inNotes = true
      continue
    }
    if (l.trim() === '*/') {
      inNotes = false
      continue
    }
    if (inNotes && l.includes('• ')) warnings.push(l.split('• ')[1] ?? '')
  }
  return warnings
}

describe('converter warning coverage', () => {
  it('fill-pattern without fill-color → no Batch 2 warning (iter-177 Stage 1)', () => {
    // iter-177: `fill-pattern` is now emitted as a `fill-pattern-<name>`
    // utility and the runtime samples the sprite centre pixel for
    // colour. The legacy "Batch 2 sprite-atlas dependency" warning was
    // retired; this assertion locks the new contract so a regression
    // back to warn-only is caught.
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [
        {
          id: 'wetland',
          type: 'fill',
          source: 'v',
          'source-layer': 'landcover',
          paint: { 'fill-pattern': 'wetland_bg_11' },
        },
      ],
    })
    expect(
      w.some(
        (s) => s.includes('fill-pattern declared without') || s.includes('Batch 2 sprite-atlas'),
      ),
    ).toBe(false)
  })

  it('line-pattern without line-color → no Batch 2 warning (iter-178 Stage 1)', () => {
    // iter-178: parallel to fill-pattern Stage 1 — `line-pattern`
    // now emits a `stroke-pattern-<name>` utility and the runtime
    // samples the sprite centre pixel for the line colour. Legacy
    // Batch-2 warning retired.
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [
        {
          id: 'road_pattern',
          type: 'line',
          source: 'v',
          'source-layer': 'transportation',
          paint: { 'line-pattern': 'dashed_white' },
        },
      ],
    })
    expect(
      w.some(
        (s) => s.includes('line-pattern declared without') || s.includes('Batch 2 sprite-atlas'),
      ),
    ).toBe(false)
  })

  it('fill-pattern WITH fill-color → no warning (pattern is supplement)', () => {
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [
        {
          id: 'park',
          type: 'fill',
          source: 'v',
          'source-layer': 'park',
          paint: { 'fill-color': '#0f0', 'fill-pattern': 'park_dots' },
        },
      ],
    })
    expect(w.some((s) => s.includes('fill-pattern declared without'))).toBe(false)
  })

  it('source scheme: "tms" → the Y-flip warning is RETIRED; a raster source emits (#1985)', () => {
    // Was: "tiles will render Y-flipped … wait for native scheme support". The scheme now
    // reaches the request path (`tileUrl` substitutes `2^z − 1 − y` for `{y}`), so the
    // whole warning is gone for the two types that consume it. The vector family keeps a
    // NARROWED one, pinned in source-scheme-emit.test.ts alongside the emit witness.
    const w = warningsOf({
      version: 8,
      sources: {
        legacy: {
          type: 'raster',
          tiles: ['https://example.com/{z}/{x}/{y}.png'],
          scheme: 'tms',
        },
      },
      layers: [{ id: 'r', type: 'raster', source: 'legacy' }],
    })
    expect(w.filter((s) => s.includes('scheme'))).toEqual([])
    expect(w.some((s) => s.includes('Y-flipped'))).toBe(false)
  })

  it('multiple tile mirrors → subdomain-rotation warning', () => {
    const w = warningsOf({
      version: 8,
      sources: {
        m: {
          type: 'raster',
          tiles: [
            'https://a.example.com/{z}/{x}/{y}.png',
            'https://b.example.com/{z}/{x}/{y}.png',
            'https://c.example.com/{z}/{x}/{y}.png',
          ],
        },
      },
      layers: [{ id: 'r', type: 'raster', source: 'm' }],
    })
    expect(w.some((s) => s.includes('"m"') && s.includes('mirrors'))).toBe(true)
  })

  it('top-level projection → ignored-fields warning; fog gets its OWN precise warning (#2166); light stays host-applied (WS-9, #2007 supersedes WS-8)', () => {
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [],
      projection: { type: 'globe' },
      fog: { range: [0.5, 10], 'high-color': '#245cdf' },
      light: { intensity: 0.3 },
    })
    expect(w.some((s) => s.startsWith('Top-level style fields ignored'))).toBe(true)
    const note = w.find((s) => s.startsWith('Top-level style fields ignored'))!
    // #2007 supersedes WS-8: the playground demo-runner/compare-runner still
    // apply `projection` themselves, but the COMPILER never did — a host
    // embedding convertMapboxStyle() directly had zero signal. `projection`
    // now appears in the ignored list with a clause naming it a host/runtime
    // choice (not a plain "unimplemented" gap like fog).
    expect(note, `expected "projection" in: ${note}`).toContain('projection')
    expect(note, `expected the host/runtime clause in: ${note}`).toContain(
      'host/runtime choice in X-GIS',
    )
    // WS-9: top-level `light` is still host-applied (XGISMap.setLight via the
    // demo-runner / compare-runner) with no compiler-side gap to warn about,
    // so it must still NOT appear in the ignored list.
    expect(note, `light should be host-applied, not ignored: ${note}`).not.toContain('light')
    // #2166 B1 — `fog` LEFT gapFields. BOTH directions are pinned, because a
    // bare "the lump no longer says fog" assertion would pass just as well if
    // the converter had gone silent about fog entirely.
    expect(
      note,
      `"fog" left gapFields in #2166 — it must not be lumped any more: ${note}`,
    ).not.toContain('fog')
    const fogNote = w.find((s) => s.startsWith('Top-level "fog" is not applied'))
    expect(fogNote, `expected the precise fog warning, got: ${JSON.stringify(w)}`).toBeDefined()
    // It names what the author actually wrote and sorts each key into the
    // taxonomy docs/plans/2026-08-24-sky-fog.md §5 established — `range` is the
    // distance half, everything sky-spelled is the direction half. The
    // per-key clauses are gated separately below; this fixture authors one of
    // each, so it pins that BOTH clauses appear together.
    expect(fogNote, `expected the authored keys named in: ${fogNote}`).toContain('range')
    expect(fogNote, `expected the authored keys named in: ${fogNote}`).toContain('high-color')
    expect(fogNote, `expected the distance half named for range: ${fogNote}`).toContain(
      'range is distance-dependent',
    )
    expect(fogNote, `expected the direction half named for high-color: ${fogNote}`).toContain(
      'high-color is direction-dependent',
    )
    expect(
      fogNote,
      `expected the atmosphere half pointed at the spelling that renders: ${fogNote}`,
    ).toContain('setAtmosphere')
  })

  it('top-level transition → precise "identical at rest" warning, not the ignored lump (#2166)', () => {
    // `lights` keeps the lump alive so "transition is not in it" is asserted
    // against a real string rather than against an absent warning.
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [],
      lights: [{ id: 'ambient', type: 'ambient', properties: { color: '#fff' } }],
      transition: { duration: 500, delay: 100 },
    })
    const note = w.find((s) => s.startsWith('Top-level style fields ignored'))
    expect(note, `expected the lump to survive for lights: ${JSON.stringify(w)}`).toBeDefined()
    expect(note, `expected "lights" still lumped in: ${note}`).toContain('lights')
    expect(
      note,
      `"transition" left gapFields in #2166 — it must not be lumped any more: ${note}`,
    ).not.toContain('transition')
    const t = w.find((s) => s.startsWith('Top-level "transition"'))
    expect(t, `expected the precise transition warning, got: ${JSON.stringify(w)}`).toBeDefined()
    // The authored timings, and the fact that distinguishes this gap from
    // every other one in the lump: nothing is missing from a static frame.
    expect(t, `expected the authored duration in: ${t}`).toContain('500ms')
    expect(t, `expected the authored delay in: ${t}`).toContain('100ms')
    expect(t, `expected the "identical at rest" clause in: ${t}`).toContain(
      'renders identically at rest',
    )
  })

  it('a transition asking for no animation at all warns nothing (#2166)', () => {
    // duration 0 / no delay IS what X-GIS does, so the old lump was a false
    // positive here. Same "only warn about what is actually lost" guard the
    // partial-sky block uses.
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [],
      transition: { duration: 0 },
    })
    expect(
      w.filter((s) => s.includes('transition')),
      `a no-op transition must produce no warning at all, got: ${JSON.stringify(w)}`,
    ).toEqual([])
  })

  // ── The three mechanisms the #2199 review proved nothing watched ──────
  //
  // Each of these was found by CUTTING the mechanism and running the FULL
  // compiler suite: all three stayed 4506/4506 green, because the existing
  // fixtures happen to exercise only the shapes where the cut is invisible.
  // A fixture that cannot distinguish the states of the thing it covers is
  // not coverage (CLAUDE.md §12).

  it('a DISTANCE-ONLY fog block is not told it authored atmosphere keys (#2166)', () => {
    // CUT: `authored.filter(k => SKY_SPELLED.includes(k))` → the whole list.
    // The suite stayed green because the only fog fixture authors BOTH halves
    // and asserts with a substring, which passes either way. `{range, color}`
    // is the commonest real Mapbox v3 shape, and under that cut it was told
    // it wrote `high-color, space-color, horizon-blend` and pointed at a
    // spelling it never asked for.
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [],
      fog: { range: [0.5, 10] },
    })
    const f = w.find((s) => s.startsWith('Top-level "fog"'))
    expect(f, `expected the precise fog warning, got: ${JSON.stringify(w)}`).toBeDefined()
    expect(f, `range is the distance half and must be named as such: ${f}`).toContain(
      'distance-dependent',
    )
    for (const k of ['high-color', 'space-color', 'horizon-blend']) {
      expect(f, `unauthored key "${k}" must not appear: ${f}`).not.toContain(k)
    }
    expect(f, `an author who wrote no sky-spelled key must not be sent to sky: ${f}`).not.toContain(
      'setAtmosphere',
    )
  })

  it('a DIRECTION-ONLY fog block is not told it lost distance fog, and agrees in number (#2166)', () => {
    // The mirrored partial-sky block only ever names keys the author wrote;
    // the first clause had lost that guard, so a sky-only block was told
    // "nothing tints geometry by distance" — a loss that did not happen.
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [],
      fog: { 'high-color': '#245cdf' },
    })
    const f = w.find((s) => s.startsWith('Top-level "fog"'))!
    expect(f, `no distance key was authored, so no depth clause: ${f}`).not.toContain(
      'distance-dependent',
    )
    // Number agreement, which the mirrored block carries and this one dropped.
    expect(f, `one key takes the singular verb: ${f}`).toContain(
      'high-color is direction-dependent',
    )
  })

  it('`star-intensity` is never pointed at the sky root — the atmosphere pass draws no stars (#2166)', () => {
    // CUT: adding 'star-intensity' to the sky-spelled list left the suite
    // green. The exclusion is stated as a deliberate correctness decision in
    // the code comment AND the published coverage note, so it needs a witness.
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [],
      fog: { 'star-intensity': 0.8 },
    })
    const f = w.find((s) => s.startsWith('Top-level "fog"'))!
    expect(f, `star-intensity must be named as having no equivalent: ${f}`).toContain(
      'draws no stars',
    )
    expect(f, `star-intensity must NOT be sent to the sky root: ${f}`).not.toContain(
      'setAtmosphere',
    )
  })

  it('`vertical-range` is reported as altitude-banded, not as a depth gap (#2166)', () => {
    // sky-fog §9.2 assigns it to ADR-0012 D5 (terrain). The first draft of
    // this lane put it in the depth half, contradicting the plan of record.
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [],
      fog: { 'vertical-range': [0, 1000] },
    })
    const f = w.find((s) => s.startsWith('Top-level "fog"'))!
    expect(f, `vertical-range is altitude-banded: ${f}`).toContain('altitude-banded')
    expect(f, `it is not a depth problem: ${f}`).not.toContain('distance-dependent')
  })

  it('an EMPTY transition block reports the spec defaults, not silence (#2166)', () => {
    // CUT: the `: 300` spec default → `: 0`. The suite stayed green because
    // both existing fixtures pass `duration` explicitly, so the fallback is
    // never exercised — and under the cut `{}` went completely SILENT,
    // reinstating the very silent-drop class this lane removes.
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [],
      transition: {},
    })
    const t = w.find((s) => s.startsWith('Top-level "transition"'))
    expect(
      t,
      `an unauthored transition still animates at the spec default: ${JSON.stringify(w)}`,
    ).toBeDefined()
    expect(t, `spec default duration is 300ms: ${t}`).toContain('300ms')
    expect(t, `spec default delay is 0ms: ${t}`).toContain('0ms')
  })

  it('a MALFORMED transition is flagged, not described with invented numbers (#2166)', () => {
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [],
      transition: 'fast' as unknown as Record<string, never>,
    })
    const t = w.find((s) => s.startsWith('Top-level "transition"'))!
    expect(t, `a non-object transition is malformed: ${t}`).toContain('malformed')
    expect(t, `numbers the author never wrote must not be reported: ${t}`).not.toContain('300ms')
  })

  it('GeoJSON source clustering → conversion-notes warning', () => {
    // Pins 754e4b9 — the five Mapbox cluster fields surface as a
    // single per-source warning so style authors know X-GIS has no
    // clustering pipeline.
    const w = warningsOf({
      version: 8,
      sources: {
        poi: {
          type: 'geojson',
          data: 'https://example.com/poi.geojson',
          cluster: true,
          clusterRadius: 50,
          clusterMaxZoom: 14,
        },
      },
      layers: [{ id: 'p', type: 'circle', source: 'poi' }],
    })
    expect(w.some((s) => s.includes('"poi"') && s.includes('clustering'))).toBe(true)
  })

  it('GeoJSON source tuning fields → ignored-tuning warning', () => {
    // Pins e700bd0 — tolerance / buffer / generateId each surface in the consolidated
    // note. `lineMetrics` LEFT the list at #2117: the tiler measures every line's arc
    // unconditionally (the dash phase needs it), so line-progress works with or without
    // the flag and calling it "ignored" would be a false diagnostic.
    const w = warningsOf({
      version: 8,
      sources: {
        lines: {
          type: 'geojson',
          data: 'https://example.com/roads.geojson',
          tolerance: 0.3,
          buffer: 128,
          lineMetrics: true,
          generateId: true,
        },
      },
      layers: [{ id: 'l', type: 'line', source: 'lines' }],
    })
    const note = w.find((s) => s.includes('"lines"') && s.includes('ignored tuning fields'))
    expect(note, `expected ignored-tuning note: ${JSON.stringify(w)}`).toBeDefined()
    for (const k of ['tolerance', 'buffer', 'generateId']) {
      expect(note, `expected "${k}" in: ${note}`).toContain(k)
    }
    expect(note, `lineMetrics is honoured by construction (#2117): ${note}`).not.toContain(
      'lineMetrics',
    )
  })

  it('source minzoom → still unhandled; maxzoom (#1983) and bounds (#1984) now emit', () => {
    // Pins bc32a5c (minzoom/maxzoom) + 39a3cee (bounds), narrowed TWICE: #1983 stopped
    // dropping a raster source's `maxzoom` (it clamps the cover zoom), and #1984 stopped
    // dropping its `bounds` (the raster / raster-dem selectors clip to it —
    // map/src/render/source-bounds-clip.ts). `minzoom` is the one half still genuinely
    // dropped: it IS emitted, but no tile selector consumes a source-level minzoom.
    const w = warningsOf({
      version: 8,
      sources: {
        regional: {
          type: 'raster',
          tiles: ['https://example.com/{z}/{x}/{y}.png'],
          minzoom: 4,
          maxzoom: 12,
          bounds: [125, 33, 132, 39],
        },
      },
      layers: [{ id: 'r', type: 'raster', source: 'regional' }],
    })
    expect(w.some((s) => s.includes('"regional"') && s.includes('minzoom: 4'))).toBe(true)
    // The two halves that stopped being dropped — asserted as the ABSENCE of any
    // warning naming them, which is what "the property reaches the runtime" looks like
    // from here (the emission itself is pinned in source-bounds-emit.test.ts).
    expect(w.some((s) => s.includes('maxzoom') && s.includes('not emitted'))).toBe(false)
    expect(w.some((s) => s.includes('"regional"') && s.includes('bounds'))).toBe(false)
  })

  it('a VECTOR source keeps a bounds warning — narrowed to name the real owner (#1984)', () => {
    // The other side of the #1984 narrowing: bounds is emitted only for the two types
    // whose selectors clip. A vector source still warns, but no longer as "unsupported"
    // — its ARCHIVE metadata (PMTiles header / TileJSON manifest) already owns the clip,
    // so re-declaring it in the xgis block would create a second authority.
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', url: 'https://example.com/x.pmtiles' } },
      layers: [{ id: 'l', type: 'line', source: 'v', 'source-layer': 'roads' }],
    })
    const bounds = warningsOf({
      version: 8,
      sources: {
        v: { type: 'vector', url: 'https://example.com/x.pmtiles', bounds: [125, 33, 132, 39] },
      },
      layers: [{ id: 'l', type: 'line', source: 'v', 'source-layer': 'roads' }],
    }).filter((s) => s.includes('bounds'))
    expect(w.filter((s) => s.includes('bounds'))).toHaveLength(0) // no bounds ⇒ no note
    expect(bounds).toHaveLength(1)
    expect(bounds[0]).toContain('not emitted for type "vector"')
    expect(bounds[0]).toMatch(/PMTiles header|TileJSON manifest/)
  })

  it('interpolate-lab colour spec → compile-time densification warning (iter 61)', () => {
    // Iter 61 (Plan §11 follow-up): Mapbox v3 perceptually-uniform
    // colour interp is now resampled in Lab space at compile time,
    // emitting a dense piecewise-linear hex stop set the runtime
    // linearly interpolates between. Endpoints preserved exactly.
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [
        {
          id: 'lab_fade',
          type: 'fill',
          source: 'v',
          'source-layer': 'landuse',
          paint: {
            'fill-color': ['interpolate-lab', ['linear'], ['zoom'], 0, '#fff', 18, '#888'],
          },
        },
      ],
    })
    expect(
      w.some(
        (s) =>
          s.includes('interpolate-lab') &&
          s.includes('dense piecewise-linear') &&
          s.includes('Lab space'),
      ),
    ).toBe(true)
  })

  it('interpolate-hcl colour spec → compile-time densification warning (iter 61)', () => {
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [
        {
          id: 'hcl_fade',
          type: 'fill',
          source: 'v',
          'source-layer': 'landuse',
          paint: {
            'fill-color': ['interpolate-hcl', ['linear'], ['zoom'], 0, '#f00', 18, '#00f'],
          },
        },
      ],
    })
    expect(
      w.some(
        (s) =>
          s.includes('interpolate-hcl') &&
          s.includes('dense piecewise-linear') &&
          s.includes('LCh space'),
      ),
    ).toBe(true)
  })

  it('cubic-bezier zoom interp with numeric stops → compile-time densification warning (iter 60)', () => {
    // Iter 60: Mapbox `["interpolate", ["cubic-bezier", …], ["zoom"],
    // …]` over numeric stops resamples in CSS bezier space at compile
    // time, emitting dense piecewise-linear stops.
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [
        {
          id: 'bezier_width',
          type: 'line',
          source: 'v',
          'source-layer': 'roads',
          paint: {
            'line-color': '#000',
            'line-width': [
              'interpolate',
              ['cubic-bezier', 0.42, 0, 0.58, 1],
              ['zoom'],
              10,
              1,
              20,
              8,
            ],
          },
        },
      ],
    })
    expect(w.some((s) => s.includes('cubic-bezier') && s.includes('dense piecewise-linear'))).toBe(
      true,
    )
  })

  it('source "type": "pmtiles" routes through to xgis pmtiles source', () => {
    // Pins 1c61b9f — Protomaps community-extension shape ("type":
    // "pmtiles" instead of "vector" + .pmtiles URL detection) must
    // emit a real pmtiles source block, not the terminal
    // "unsupported source type" warning.
    const out = convertMapboxStyle({
      version: 8,
      sources: {
        protomaps: {
          type: 'pmtiles',
          url: 'https://example.com/regions.pmtiles',
        },
      },
      layers: [
        {
          id: 'water',
          type: 'fill',
          source: 'protomaps',
          'source-layer': 'water',
          paint: { 'fill-color': '#aef' },
        },
      ],
    } as never)
    expect(out, 'xgis output should declare a pmtiles source').toMatch(
      /source\s+protomaps\s*\{[^}]*type:\s*pmtiles/,
    )
    // And the layer block survives the conversion (sanity that the
    // dropped-source path isn't re-routed here).
    expect(out).toContain('layer water')
    // No "unsupported source type" warning either.
    const w = warningsOf({
      version: 8,
      sources: { protomaps: { type: 'pmtiles', url: 'https://example.com/x.pmtiles' } },
      layers: [],
    })
    expect(w.some((s) => s.includes('"protomaps"') && s.includes('unsupported type'))).toBe(false)
  })

  it('background-pattern constant → lowered to a pattern: property, no ignored-properties warning (#777 I-E)', () => {
    // #777 I-E: the CONSTANT background-pattern sprite name is now LOWERED to a
    // `pattern:` style property the runtime tiles over the clear — it no longer
    // surfaces via the ignored-properties bucket (which pinned iter 47's
    // constant-opacity fold). Constant background-opacity still folds into the
    // fill hex alpha. Non-constant opacity / zoom-crossfade pattern still warn —
    // verified separately (below + background-pattern-convert.test.ts).
    const style = {
      version: 8,
      sources: {},
      layers: [
        {
          id: 'bg',
          type: 'background',
          paint: {
            'background-color': '#f8f4f0',
            'background-opacity': 0.7,
            'background-pattern': 'paper',
          },
        },
      ],
    }
    const out = convertMapboxStyle(style as never)
    // The block carries the sprite name; the folded opacity rides the fill hex.
    expect(out).toMatch(/background \{[^}]*pattern: paper[^}]*\}/)
    // Neither constant prop surfaces as an ignored-properties gap now.
    const note = warningsOf(style).find(
      (s) => s.includes('"bg"') && s.includes('ignored properties'),
    )
    expect(
      note,
      `expected NO background ignored-properties note, got: ${note ?? '<none>'}`,
    ).toBeUndefined()
  })

  it('background-opacity zoom-interp → emits opacity: interpolate, no warning (WS-1)', () => {
    // WS-1: a zoom-interpolated background-opacity is now emitted as an
    // `opacity: interpolate(zoom, …)` style property the runtime resolves
    // per frame — it no longer surfaces as a non-constant gap.
    const w = warningsOf({
      version: 8,
      sources: {},
      layers: [
        {
          id: 'bg',
          type: 'background',
          paint: {
            'background-color': '#f8f4f0',
            'background-opacity': ['interpolate', ['linear'], ['zoom'], 0, 0.5, 10, 1],
          },
        },
      ],
    })
    const note = w.find((s) => s.includes('"bg"') && s.includes('background-opacity'))
    expect(
      note,
      `expected no background-opacity warning, got: ${JSON.stringify(w)}`,
    ).toBeUndefined()
  })

  it('GeoJSON promoteId → reserved-id warning', () => {
    // Pins f8aed39.
    const w = warningsOf({
      version: 8,
      sources: {
        d: {
          type: 'geojson',
          data: 'https://example.com/d.geojson',
          promoteId: 'osm_id',
        },
      },
      layers: [{ id: 'l', type: 'circle', source: 'd' }],
    })
    expect(w.some((s) => s.includes('"d"') && s.includes('promoteId'))).toBe(true)
  })

  it('source tileSize: 256 → emitted, NOT warned (#1983 replaced 20af7b6)', () => {
    // Was: "the runtime tile selector hardcodes 512 px tiles". It does not — the raster
    // arm takes 256 | 512 and biases the cover zoom by log2(512/tileSize) — so the
    // declared size is now emitted into the source block instead of being warned away.
    // A warning here again means the emit regressed back to a silent drop.
    const w = warningsOf({
      version: 8,
      sources: {
        relief: {
          type: 'raster',
          tiles: ['https://example.com/ne2/{z}/{x}/{y}.png'],
          tileSize: 256,
        },
      },
      layers: [{ id: 'r', type: 'raster', source: 'relief' }],
    })
    expect(w.some((s) => s.includes('"relief"') && s.includes('tileSize'))).toBe(false)
    expect(
      convertMapboxStyle({
        version: 8,
        sources: {
          relief: {
            type: 'raster',
            tiles: ['https://example.com/ne2/{z}/{x}/{y}.png'],
            tileSize: 256,
          },
        },
        layers: [{ id: 'r', type: 'raster', source: 'relief' }],
      } as never),
    ).toContain('tileSize: 256')
  })

  it('fill-extrusion-base non-zero → NO unhonoured-base warning (iter 489 + 493 — vertex shader now honors u.extrude_base_m)', () => {
    // Pins 4682b0d's removal. Iter 489 wired the renderer.ts
    // vs_main_quantized z_world select to pull u.extrude_base_m
    // as the wall bottom, and iter 493 dropped the obsolete
    // converter warning. A non-zero base is now correctly honoured
    // at render time — the warning is gone and no test should
    // expect it.
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [
        {
          id: 'floating_building',
          type: 'fill-extrusion',
          source: 'v',
          'source-layer': 'building',
          paint: {
            'fill-extrusion-height': 40,
            'fill-extrusion-base': 10,
            'fill-extrusion-color': '#888',
          },
        },
      ],
    })
    expect(
      w.some((s) => s.includes('"floating_building"') && s.includes('fill-extrusion-base')),
    ).toBe(false)
  })

  it('fill-extrusion-base: 0 → no unhonoured warning', () => {
    // Default 0 is the no-op case; the warning would be noise.
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [
        {
          id: 'ground_building',
          type: 'fill-extrusion',
          source: 'v',
          'source-layer': 'building',
          paint: {
            'fill-extrusion-height': 40,
            'fill-extrusion-base': 0,
            'fill-extrusion-color': '#888',
          },
        },
      ],
    })
    expect(w.some((s) => s.includes('ground_building') && s.includes('fill-extrusion-base'))).toBe(
      false,
    )
  })

  it('literal-wrapped line-dasharray emits the dash utility (no warning)', () => {
    // Mapbox v8 `["literal", [4, 2]]` wraps the bare-array shape.
    // Pre-fix the operator-string guard treated "literal" as an
    // expression and fell through to the non-constant warning. Now
    // unwrapped before the numeric check so the modern form behaves
    // identically to the legacy `[4, 2]` shape.
    const out = convertMapboxStyle({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [
        {
          id: 'literal_dash',
          type: 'line',
          source: 'v',
          'source-layer': 'transportation',
          paint: {
            'line-color': '#000',
            'line-dasharray': ['literal', [4, 2]],
          },
        },
      ],
    } as never)
    expect(out, 'literal-wrapped dasharray should emit stroke-dasharray-4-2').toContain(
      'stroke-dasharray-4-2',
    )
    // No "non-constant" warning either.
    expect(out.includes('paint.line-dasharray: non-constant')).toBe(false)
  })

  it('literal-wrapped text-offset emits label-offset utilities', () => {
    // Pins 7986ea5 — Mapbox v8 `["literal", [0, -1.5]]` shape used to
    // fail the numeric-tuple check (outer length === 2 but offset[0]
    // === "literal" string). Now unwrapped before the check.
    const out = convertMapboxStyle({
      version: 8,
      sources: {},
      layers: [
        {
          id: 'wrapped',
          type: 'symbol',
          source: 'x',
          layout: {
            'text-field': 'A',
            'text-offset': ['literal', [0, -1.5]],
          },
        },
      ],
    } as never)
    // Negative y should ride the bracket binding form per fmtSigned.
    expect(out).toMatch(/label-offset-y-\[-1\.5\]/)
  })

  it('literal-wrapped icon-offset survives conversion', () => {
    const out = convertMapboxStyle({
      version: 8,
      sources: {},
      layers: [
        {
          id: 'shield',
          type: 'symbol',
          source: 'x',
          layout: {
            'icon-image': 'shield',
            'icon-offset': ['literal', [3, 4]],
          },
        },
      ],
    } as never)
    expect(out).toContain('label-icon-offset-x-3')
    expect(out).toContain('label-icon-offset-y-4')
  })

  it('["to-color", hex] unwraps to constant fill utility', () => {
    // Pins 51bfaf1 — `["to-color", "#aef"]` should emit `fill-#aef`,
    // not collapse to a per-feature bracket-binding eval.
    const out = convertMapboxStyle({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [
        {
          id: 'to_color_fill',
          type: 'fill',
          source: 'v',
          'source-layer': 'park',
          paint: { 'fill-color': ['to-color', '#aef'] },
        },
      ],
    } as never)
    expect(out).toContain('fill-#aef')
    expect(out).not.toMatch(/fill-\["#aef"\]/)
  })

  it('literal-wrapped visibility: "none" hides the layer (visible: false)', () => {
    // Pins f47ca12. `["literal", "none"]` should resolve to the
    // visibility-none → `visible: false` block property.
    const out = convertMapboxStyle({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [
        {
          id: 'hidden',
          type: 'fill',
          source: 'v',
          'source-layer': 'park',
          layout: { visibility: ['literal', 'none'] },
          paint: { 'fill-color': '#0f0' },
        },
      ],
    } as never)
    expect(out).toContain('visible: false')
  })

  it('literal-wrapped line-cap: "round" emits stroke-round-cap utility', () => {
    const out = convertMapboxStyle({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [
        {
          id: 'rounded',
          type: 'line',
          source: 'v',
          'source-layer': 'transportation',
          layout: { 'line-cap': ['literal', 'round'] },
          paint: { 'line-color': '#000' },
        },
      ],
    } as never)
    expect(out).toContain('stroke-round-cap')
  })

  it('literal-wrapped text-anchor: "top-left" emits label-anchor utility', () => {
    const out = convertMapboxStyle({
      version: 8,
      sources: {},
      layers: [
        {
          id: 'corner_label',
          type: 'symbol',
          source: 'x',
          layout: {
            'text-field': 'L',
            'text-anchor': ['literal', 'top-left'],
          },
        },
      ],
    } as never)
    expect(out).toContain('label-anchor-top-left')
  })

  it('literal-wrapped icon-image emits label-icon-image utility', () => {
    const out = convertMapboxStyle({
      version: 8,
      sources: {},
      layers: [
        {
          id: 'sprite_layer',
          type: 'symbol',
          source: 'x',
          layout: {
            'icon-image': ['literal', 'shield-us'],
          },
        },
      ],
    } as never)
    expect(out).toContain('label-icon-image-shield-us')
  })

  it('literal-wrapped fill-color → constant fill utility (not data-driven)', () => {
    // Pins the colors.ts literal-unwrap. Mapbox v8 `["literal", "#fff"]`
    // pre-fix fell to exprToXgis as a quoted string and emitted
    // `fill-["#fff"]` (a data-driven bracket binding) — wasteful eval
    // per-feature. Now unwrapped to the constant `fill-#fff` utility.
    const out = convertMapboxStyle({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [
        {
          id: 'literal_fill',
          type: 'fill',
          source: 'v',
          'source-layer': 'park',
          paint: { 'fill-color': ['literal', '#aef'] },
        },
      ],
    } as never)
    // Constant fill, not bracket binding.
    expect(out).toContain('fill-#aef')
    expect(out).not.toMatch(/fill-\["#aef"\]/)
  })

  it('literal-wrapped text-variable-anchor-offset pairs survive', () => {
    // Pins 8db3d26 — the VAO inner [x, y] can be literal-wrapped per
    // Mapbox v8. Pre-fix the bare-array check failed and the
    // anchor + offset silently dropped.
    const out = convertMapboxStyle({
      version: 8,
      sources: {},
      layers: [
        {
          id: 'vao_literal',
          type: 'symbol',
          source: 'x',
          layout: {
            'text-field': 'L',
            'text-variable-anchor-offset': [
              'top',
              ['literal', [0, -1]],
              'bottom',
              ['literal', [0, 1]],
            ],
          },
        },
      ],
    } as never)
    expect(out).toContain('label-anchor-top')
    expect(out).toContain('label-anchor-bottom')
    expect(out).toMatch(/label-vao-0-y-\[-1\]/)
    expect(out).toMatch(/label-vao-1-y-1/)
  })

  it('zoom-interp line-dasharray → bracket binding, no warning (WS-1)', () => {
    // WS-1 — interpolate-by-zoom dasharray now lowers to a
    // PropertyShape<number[]> (stroke-dasharray-[interpolate(zoom, …)])
    // resolved per frame (STEP). No longer dropped/warned.
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [
        {
          id: 'dashed_zoom',
          type: 'line',
          source: 'v',
          'source-layer': 'transportation',
          paint: {
            'line-color': '#000',
            'line-dasharray': [
              'interpolate',
              ['linear'],
              ['zoom'],
              8,
              ['literal', [4, 2]],
              16,
              ['literal', [8, 2]],
            ],
          },
        },
      ],
    })
    // WS-1: the zoom-interp form is handled (bracket binding), so no
    // line-dasharray warning is emitted.
    expect(w.some((s) => s.includes('paint.line-dasharray'))).toBe(false)
  })

  it('glyphs / sprite must NOT appear in the top-level warning (host-integration handled)', () => {
    // Regression for 2819cd6 — these used to be flagged here even
    // though the playground importers forward them via setGlyphsUrl /
    // setSpriteUrl.
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [],
      glyphs: 'https://example.com/fonts/{fontstack}/{range}.pbf',
      sprite: 'https://example.com/sprites/standard',
    })
    const note = w.find((s) => s.startsWith('Top-level style fields ignored'))
    if (note) {
      expect(note).not.toContain('glyphs')
      expect(note).not.toContain('sprite')
    }
  })

  it('data-driven fill-opacity → loud per-feature-drop warning (#725)', () => {
    // The runtime has no per-feature opacity channel: a feature-referencing
    // fill-opacity evaluates to ONE layer scalar, silently losing its
    // per-feature variation. Pre-fix this converted without ANY warning.
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [
        {
          id: 'parcels',
          type: 'fill',
          source: 'v',
          'source-layer': 'parcel',
          paint: {
            'fill-color': '#336699',
            'fill-opacity': ['match', ['get', 'zoned'], 'yes', 0.9, 0.2],
          },
        },
      ],
    })
    expect(w.some((s) => s.includes('data-driven (per-feature) opacity'))).toBe(true)
  })

  it('zoom-only interpolated fill-opacity stays warning-free (fully supported)', () => {
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [
        {
          id: 'suburb',
          type: 'fill',
          source: 'v',
          'source-layer': 'landuse',
          paint: {
            'fill-color': '#eee0d0',
            'fill-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0, 12, 1],
          },
        },
      ],
    })
    expect(w.some((s) => s.includes('data-driven (per-feature) opacity'))).toBe(false)
  })
})
