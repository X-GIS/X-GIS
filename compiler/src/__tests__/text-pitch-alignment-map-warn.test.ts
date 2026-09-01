// text-pitch-alignment — the runtime-gap warning, and the set it may fire on.
//
// #2166. The warning used to fire on EVERY label the spec resolves to `map`,
// which was correct when nothing in map/src consumed `LabelDef.pitchAlignment`
// and is now false on almost all of it: #2060 / #2092 / #2106 shipped the ground
// basis for the POINT path (dispatch-point-labels.ts makeGroundBasisFor) and for
// the CURVED line branch (label-pass.ts → dispatch-curved-line-labels.ts). In
// the shipped conversion-report snapshot every single occurrence of the old
// message was a `symbol-placement: line` layer — i.e. 100 % of what it fired on
// was working behaviour, telling authors to avoid a feature that works.
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
  it('POINT placement with an explicit "map" does NOT warn (the basis is built there)', () => {
    // FAIL-BEFORE: the authored-"map" arm fired unconditionally, so this warned
    // about `makeGroundBasisFor`, which has honoured it since #2060.
    expect(pitchWarnings({ 'text-pitch-alignment': 'map' })).toEqual([])
  })

  it('POINT placement with an explicit rotation "map" does NOT warn', () => {
    expect(pitchWarnings({ 'text-rotation-alignment': 'map' })).toEqual([])
  })

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
// (placement × rotation × pitch) cube the warning fires on EXACTLY the labels the
// spec routes to `map` that the runtime nevertheless billboards. A widening
// (fire on a working label) and a narrowing (go silent on a real gap) are both
// caught, and neither is expressible as "the message changed".
const PLACEMENTS = ['point', 'line', 'line-center', undefined] as const
const KNOBS = ['map', 'viewport', 'auto', undefined] as const

describe('#2166 — warning ⇔ !groundAlignsAtRuntime, over the whole cube', () => {
  it('fires exactly where the spec asks for the ground plane and map/src billboards', () => {
    const mismatches: string[] = []
    let fired = 0
    for (const placement of PLACEMENTS) {
      for (const rot of KNOBS) {
        for (const pitch of KNOBS) {
          const layout: Record<string, unknown> = { 'text-field': '{name}' }
          if (placement !== undefined) layout['symbol-placement'] = placement
          if (rot !== undefined) layout['text-rotation-alignment'] = rot
          if (pitch !== undefined) layout['text-pitch-alignment'] = pitch
          const warned =
            pitchAlignmentGapWarning({ id: 'l' }, layout, placement, rot, pitch) !== null
          const gap =
            resolvePitchAlignment(placement, rot, pitch) === 'map' &&
            !groundAlignsAtRuntime(placement, rot, pitch)
          if (warned) fired++
          if (warned !== gap) {
            mismatches.push(
              `placement=${String(placement)} rot=${String(rot)} pitch=${String(pitch)}: ` +
                `warning=${warned} but runtime-gap=${gap}`,
            )
          }
        }
      }
    }
    expect(mismatches, mismatches.join('\n')).toEqual([])
    // Non-vacuity in both directions: the residual exists (so a warning that
    // always returned null would fail) and it is not the whole cube (so the old
    // fire-on-everything warning would fail too).
    expect(fired).toBeGreaterThan(0)
    expect(fired).toBeLessThan(PLACEMENTS.length * KNOBS.length * KNOBS.length)
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
