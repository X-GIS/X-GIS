// text-pitch-alignment — the runtime-gap warning, and the set it may fire on.
//
// #2166. The warning used to fire on EVERY label the spec resolves to `map`,
// which was correct when nothing in map/src consumed `LabelDef.pitchAlignment`
// and is now false on almost all of it: #2060 / #2092 / #2106 shipped the ground
// basis for the CURVED line branch (label-pass.ts →
// dispatch-curved-line-labels.ts) and for the POINT path
// (dispatch-point-labels.ts makeGroundBasisFor). In the shipped
// conversion-report snapshot every single occurrence of the old message was a
// `symbol-placement: line` layer — i.e. 100 % of what it fired on was working
// behaviour, telling authors to avoid a feature that works.
//
// The point half of that pair is NARROWER than it first reads, and the first cut
// of this file got it wrong: `makeGroundBasisFor` is reached only from the
// raw-dataset point loop, so a point label on a VECTOR-TILE source — which is
// what `buildStyle` below builds, and what a converted basemap is made of —
// still billboards. The two "POINT … does NOT warn" cases this file used to
// assert have been re-derived into warning cases below; `groundAlignsAtRuntime`
// carries the four-cell table that explains why.
//
// So the warning is now derived from `groundAlignsAtRuntime`, the shared
// authority's model of what map/src actually does, and this file is the binding
// gate on that derivation: the per-case tests below pin the four corners, and
// the cross-authority test at the bottom pins the whole cube so the warning can
// neither silently widen back nor silently narrow further.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'
import { pitchAlignmentGapWarning } from '../convert/layers-helpers'
import { groundAlignsAtRuntime, resolvePitchAlignment } from '../ir/label-alignment'

function buildStyle(layout: Record<string, unknown>, id = 'labels') {
  return {
    version: 8,
    sources: { v: { type: 'vector', url: 'x.pmtiles' } },
    layers: [
      {
        id,
        type: 'symbol',
        source: 'v',
        'source-layer': 'poi',
        layout: { 'text-field': '{name}', ...layout },
      },
    ],
  }
}

/** Every warning this style produced that is about text-pitch-alignment. */
function pitchWarnings(layout: Record<string, unknown>): string[] {
  const coverage = { sources: [], layers: [], warnings: [] as string[] }
  convertMapboxStyle(buildStyle(layout) as never, { coverage })
  return coverage.warnings.filter((w) => w.includes('text-pitch-alignment'))
}

describe('#2166 — the warning is SILENT on what the runtime ground-projects', () => {
  it('LINE placement with NOTHING authored does NOT warn — the 32-occurrence case', () => {
    // FAIL-BEFORE: this is every road-name / waterway-name layer in every real
    // basemap, and it was 100 % of the shipped snapshot's occurrences. The
    // converter emits `label-spacing-250` for `line` unconditionally, so these
    // take the curved branch, which walks the pitch-0 label plane.
    expect(pitchWarnings({ 'symbol-placement': 'line' })).toEqual([])
  })

  it('LINE placement with an explicit "map" does NOT warn either', () => {
    expect(pitchWarnings({ 'symbol-placement': 'line', 'text-pitch-alignment': 'map' })).toEqual([])
  })

  it('an explicit "viewport" stays silent (there was never a gap there)', () => {
    expect(pitchWarnings({ 'text-pitch-alignment': 'viewport' })).toEqual([])
    expect(
      pitchWarnings({ 'symbol-placement': 'line', 'text-pitch-alignment': 'viewport' }),
    ).toEqual([])
    expect(
      pitchWarnings({ 'symbol-placement': 'line', 'text-rotation-alignment': 'viewport' }),
    ).toEqual([])
  })

  it('"auto" on a point layer stays silent (it resolves to viewport)', () => {
    expect(pitchWarnings({ 'text-pitch-alignment': 'auto' })).toEqual([])
  })
})

describe('#2166 — the warning still fires on the residual, and names it', () => {
  // `buildStyle` puts every layer on `{ type: 'vector' }` — the tiled column,
  // where the point dispatch supplies no basis. These two cases were asserted
  // SILENT in the first cut of this file, on the reasoning that
  // `makeGroundBasisFor` honours an authored `map`; it does, but only on the
  // raw-dataset point arm, which a vector source never reaches.
  it('POINT placement with an explicit "map" warns, naming the tiled point gap', () => {
    const ws = pitchWarnings({ 'text-pitch-alignment': 'map' })
    expect(ws.length).toBe(1)
    expect(ws[0]).toContain('point')
    expect(ws[0]).toContain('vector-tile')
    expect(ws[0]).toContain('upright')
    // Same rule as the other arms: it must describe the gap, not claim the
    // whole feature is missing.
    expect(ws[0]).not.toContain('not yet implemented')
  })

  it('POINT placement with an explicit rotation "map" warns the same way', () => {
    // pitch `auto` inherits rotation `map`, so the chain reaches the same cell
    // without the style ever naming text-pitch-alignment.
    const ws = pitchWarnings({ 'text-rotation-alignment': 'map' })
    expect(ws.length).toBe(1)
    expect(ws[0]).toContain('point')
  })

  it('LINE-CENTER placement warns, naming line-center', () => {
    const ws = pitchWarnings({ 'symbol-placement': 'line-center' })
    expect(ws.length).toBe(1)
    expect(ws[0]).toContain('"line-center"')
    expect(ws[0]).toContain('upright billboard')
    // It must NOT claim the feature is unimplemented — that is the falsehood
    // this issue exists to remove.
    expect(ws[0]).not.toContain('not yet implemented')
  })

  it('LINE + rotation "viewport" + an explicit pitch "map" warns, naming the combination', () => {
    const ws = pitchWarnings({
      'symbol-placement': 'line',
      'text-rotation-alignment': 'viewport',
      'text-pitch-alignment': 'map',
    })
    expect(ws.length).toBe(1)
    expect(ws[0]).toContain('text-rotation-alignment')
    expect(ws[0]).toContain('"viewport"')
    expect(ws[0]).not.toContain('not yet implemented')
  })

  it('an icon-only line-center layer gets no TEXT warning (its gap is icon-pitch-alignment)', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(
      {
        version: 8,
        sources: { v: { type: 'vector', url: 'x.pmtiles' } },
        layers: [
          {
            id: 'road_oneway',
            type: 'symbol',
            source: 'v',
            'source-layer': 'transportation',
            layout: { 'icon-image': 'oneway', 'symbol-placement': 'line-center' },
          },
        ],
      } as never,
      { coverage },
    )
    expect(coverage.warnings.filter((w) => w.includes('text-pitch-alignment'))).toEqual([])
  })

  it('invalid enum still warns with the existing enum-validation message', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle({ 'text-pitch-alignment': 'horizontal' }) as never, { coverage })
    expect(coverage.warnings.find((w) => w.includes('is not a valid enum'))).toBeDefined()
  })

  it('the v8 strict ["literal", …] wrap resolves the same way', () => {
    expect(pitchWarnings({ 'symbol-placement': ['literal', 'line'] })).toEqual([])
    expect(pitchWarnings({ 'symbol-placement': ['literal', 'line-center'] }).length).toBe(1)
  })
})

// ── The cross-authority gate ──────────────────────────────────────────────────
// The warning and the runtime read ONE model of what map/src ground-projects
// (ir/label-alignment.ts). This asserts they cannot drift: over the full
// (placement × rotation × pitch) cube the warning fires on EXACTLY the cells
// listed below. A widening (fire on a working label) and a narrowing (go silent
// on a real gap) are both caught, and neither is expressible as "the message
// changed".
//
// The oracle is a LITERAL LIST, and that is the whole point of this rewrite.
// The first cut of this test derived its expectation by calling the SAME two
// functions `pitchAlignmentGapWarning` itself calls:
//
//     gap = resolvePitchAlignment(…) === 'map' && !groundAlignsAtRuntime(…)
//
// Since the warning is exactly `text-field present && gap`, `warned === gap`
// held for ANY implementation of either authority — the assertion could not
// fail. MEASURED, not argued: with the `line` + rotation-`viewport` arm severed
// (`return true`) it reported PASS, and with the whole predicate forced to
// `return false` — the pre-#2166 fire-on-everything behaviour — it reported
// PASS again, directly contradicting the comment that claimed it would catch
// exactly that. Only the per-case tests above were holding the line.
//
// So the 23 warning cells are written out here by hand, from the spec chain and
// the wired-cell list, with no call into the code under test. Move either
// authority and this test names the cell that moved.
const PLACEMENTS = ['point', 'line', 'line-center', undefined] as const
const KNOBS = ['map', 'viewport', 'auto', undefined] as const

const cell = (p: unknown, rot: unknown, pitch: unknown): string =>
  `${String(p)}|${String(rot)}|${String(pitch)}`

/** Every (placement, rotation, pitch) the converter must warn on.
 *
 *  Derived by hand from two rules, NOT from the implementation:
 *  (a) the spec chain must reach pitch `map` — an explicit pitch wins, else it
 *      inherits rotation, whose own `auto`/absent is `map` for line and
 *      line-center and `viewport` for point;
 *  (b) map/src ground-projects exactly ONE cell of the tiled dispatch column —
 *      `line` placement whose rotation alignment is not `viewport`.
 *  Warn = (a) and not (b). */
const EXPECTED_WARN = new Set<string>([
  // POINT — never ground-projected on a tiled source, so every route the chain
  // takes to `map` warns. Rotation `map` carries pitch `auto`/absent with it.
  'point|map|map',
  'point|map|auto',
  'point|map|undefined',
  'point|viewport|map',
  'point|auto|map',
  'point|undefined|map',
  // Absent symbol-placement is point placement — the same six.
  'undefined|map|map',
  'undefined|map|auto',
  'undefined|map|undefined',
  'undefined|viewport|map',
  'undefined|auto|map',
  'undefined|undefined|map',
  // LINE — ground-projected on the curved branch, so ONLY the combination that
  // cannot reach it warns: rotation `viewport` with an explicit pitch `map`.
  'line|viewport|map',
  // LINE-CENTER — never ground-projected. Rotation map/auto/absent all resolve
  // to `map` for this placement, and each pairs with pitch map/auto/absent.
  'line-center|map|map',
  'line-center|map|auto',
  'line-center|map|undefined',
  'line-center|auto|map',
  'line-center|auto|auto',
  'line-center|auto|undefined',
  'line-center|undefined|map',
  'line-center|undefined|auto',
  'line-center|undefined|undefined',
  // …plus rotation `viewport` rescued into `map` by an explicit pitch.
  'line-center|viewport|map',
])

describe('#2166 — the warning fires on exactly the hand-listed residual cells', () => {
  it('matches the literal oracle cell for cell over the whole cube', () => {
    const fired = new Set<string>()
    for (const placement of PLACEMENTS) {
      for (const rot of KNOBS) {
        for (const pitch of KNOBS) {
          const layout: Record<string, unknown> = { 'text-field': '{name}' }
          if (placement !== undefined) layout['symbol-placement'] = placement
          if (rot !== undefined) layout['text-rotation-alignment'] = rot
          if (pitch !== undefined) layout['text-pitch-alignment'] = pitch
          if (pitchAlignmentGapWarning({ id: 'l' }, layout, placement, rot, pitch) !== null) {
            fired.add(cell(placement, rot, pitch))
          }
        }
      }
    }
    const unexpected = [...fired].filter((c) => !EXPECTED_WARN.has(c)).sort()
    const missing = [...EXPECTED_WARN].filter((c) => !fired.has(c)).sort()
    expect(
      unexpected,
      `the warning WIDENED — it now fires on cells the runtime ground-projects:\n  ${unexpected.join('\n  ')}`,
    ).toEqual([])
    expect(
      missing,
      `the warning NARROWED — it went silent on real gaps:\n  ${missing.join('\n  ')}`,
    ).toEqual([])
    // Belt and braces: the set size is pinned too, so a same-size swap of one
    // cell for another cannot slip through a mis-edited oracle.
    expect(fired.size).toBe(23)
  })

  it('stays a strict subset of what the spec asks for', () => {
    // The warning may only fire where the spec actually wants the ground plane;
    // firing where it resolves `viewport` would be pure noise. This is the one
    // rung that legitimately reads `resolvePitchAlignment` — it is asserting a
    // relation BETWEEN the two authorities, not re-deriving the predicate.
    for (const placement of PLACEMENTS) {
      for (const rot of KNOBS) {
        for (const pitch of KNOBS) {
          if (!EXPECTED_WARN.has(cell(placement, rot, pitch))) continue
          expect(
            resolvePitchAlignment(placement, rot, pitch),
            `${cell(placement, rot, pitch)} is listed as a warning cell but the spec resolves it to viewport`,
          ).toBe('map')
        }
      }
    }
  })

  it('the oracle and the shared predicate agree on which cells ground-project', () => {
    // Kept as a SEPARATE rung from the cell-for-cell test above, so a severed
    // predicate reddens here (naming the authority) rather than silently
    // greening the oracle comparison. Cause before effect: this is the cause.
    for (const placement of PLACEMENTS) {
      for (const rot of KNOBS) {
        for (const pitch of KNOBS) {
          const specWantsGround = resolvePitchAlignment(placement, rot, pitch) === 'map'
          if (!specWantsGround) continue
          const projected = groundAlignsAtRuntime(placement, rot, pitch)
          expect(
            projected,
            `${cell(placement, rot, pitch)}: groundAlignsAtRuntime says ${projected}, ` +
              `but the hand-written oracle ${EXPECTED_WARN.has(cell(placement, rot, pitch)) ? 'lists it as a GAP' : 'lists it as GROUND-PROJECTED'}`,
          ).toBe(!EXPECTED_WARN.has(cell(placement, rot, pitch)))
        }
      }
    }
  })

  it('a layer with no text-field never gets a TEXT warning, whatever the cube says', () => {
    for (const placement of PLACEMENTS) {
      for (const rot of KNOBS) {
        for (const pitch of KNOBS) {
          expect(
            pitchAlignmentGapWarning({ id: 'l' }, { 'icon-image': 'x' }, placement, rot, pitch),
          ).toBeNull()
        }
      }
    }
  })
})
