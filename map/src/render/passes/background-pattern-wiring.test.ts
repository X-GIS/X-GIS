// background-pattern → synthetic earth-surface show wiring (#777 I-E pivot),
// GPU-free.
//
// The first I-E landing drew the pattern in the background pass (bucket 0) —
// and the live probe proved that can never work: the synthetic earth-surface
// show draws AFTER it and repaints the whole world band with the flat
// background colour, hiding the pattern ("seamless" only holds for a COLOUR).
// The pivot: the pattern rides the synthetic show itself through the STANDARD
// fill-pattern path — render-loop `_resolveFillPatterns` fills
// fillPatternUV/fillPatternRepeatM and VTR routes the show to
// fillPipelinePatternGround — giving world-anchored (Mercator-metre) tiling,
// MapLibre background-pattern semantics, on flat AND globe.
//
// Pinned wires (each with its fail-before):
//   1. buildSyntheticEarthSurfaceShow carries the pattern name as fillPattern
//      and KEEPS resolvedFillRgba pre-set (the Stage-1 skip that preserves the
//      authored background colour under the pattern). Fail-before = the
//      builder ignores its pattern arg (the pre-pivot shape).
//   2. syntheticEarthSurfaceCarrier injects a default-black carrier for a
//      PATTERN-ONLY background (`background { pattern: X }` with no fill) —
//      fail-before = the injection gate is `if (_backgroundColor)` only, so a
//      pattern-only style never got a synthetic show.
//   3. ensureBackgroundPatternAtlas (label-pass) builds the REAL IconStage for
//      a label-less pattern style, and its onLanded both RE-ARMS the loop and
//      tags MORE THAN LABEL. #2128: the earlier version of this gate asserted
//      `invalidated === 1` on the stated grounds that markLabelDirty() alone
//      cannot re-arm an idle loop. That is false of XGISMap — `_markDirty`
//      (map.ts:979-982) sets `_needsRender` too — and was only true of this
//      file's own mock, whose markLabelDirty() incremented a counter and
//      nothing else. The mock below now mirrors `_markDirty` / `invalidate`,
//      so the gate measures the re-arm and the tagged domains rather than
//      which method name was called. Each half has its own fail-before:
//      dropping markLabelDirty() reddens the LABEL-tag assertion, dropping
//      invalidate() reddens the beyond-LABEL one.

import { describe, it, expect } from 'vitest'
import { DirtyDomain, DIRTY_ALL } from '../../state/dirty'
import {
  buildSyntheticEarthSurfaceShow,
  syntheticEarthSurfaceCarrier,
} from '../../synthetic-earth-surface-show'
import { ensureBackgroundPatternAtlas } from './background-pattern-atlas'

const BG: [number, number, number, number] = [0.13, 0.57, 0.42, 1]

describe('background-pattern rides the synthetic earth-surface show (#777 I-E)', () => {
  it('the builder carries the pattern as fillPattern (the standard fill-pattern route)', () => {
    const show = buildSyntheticEarthSurfaceShow(BG, null, 'pat')
    expect(show.fillPattern).toBe('pat')
    // Stage-1 skip: the pre-set resolvedFillRgba keeps the authored background
    // colour under the pattern (sprite centre-pixel never overwrites it).
    expect(show.resolvedFillRgba).toEqual(BG)
    // Stage 2 fields start unset — _resolveFillPatterns fills them at runtime.
    expect(show.fillPatternUV).toBeUndefined()
    expect(show.fillPatternRepeatM).toBeUndefined()
  })

  it('no pattern → the show is byte-identical to the pre-I-E shape (no fillPattern key)', () => {
    const show = buildSyntheticEarthSurfaceShow(BG, null, null)
    expect('fillPattern' in show).toBe(false)
    expect(show).toEqual(buildSyntheticEarthSurfaceShow(BG))
  })

  it('pattern-only background injects a default-black carrier (Mapbox background-color default)', () => {
    // With a fill: the fill is the carrier.
    expect(syntheticEarthSurfaceCarrier(BG, 'pat')).toEqual(BG)
    expect(syntheticEarthSurfaceCarrier(BG, null)).toEqual(BG)
    // Pattern-only: opaque black carries the pattern.
    expect(syntheticEarthSurfaceCarrier(null, 'pat')).toEqual([0, 0, 0, 1])
    // No background at all: no synthetic show.
    expect(syntheticEarthSurfaceCarrier(null, null)).toBeNull()
  })
})

type GateHost = Parameters<typeof ensureBackgroundPatternAtlas>[0]

/** A REAL IconStage is constructed by the gate: the only device surface its
 *  ctor touches eagerly is `rhi.createBuffer` (IconRenderer's 16-byte uniform;
 *  everything else is lazy per #834 S6), so a one-method rhi stub suffices —
 *  no GPU, no mocks. Under vitest/node the relative sprite URL's fetch
 *  rejects, so the atlas reaches the terminal 'failed' state and fires the
 *  gate's REAL `onLanded` — awaited via whenReady() (onLanded runs in the same
 *  synchronous finally block, before the await resumes). */
function gateHost(over: Partial<GateHost>): GateHost & {
  dirtied: number
  invalidated: number
  needsRender: boolean
  domains: number
} {
  const h = {
    iconStage: null,
    spriteUrl: '/fixture-sprite',
    _backgroundPattern: 'pat',
    ctx: { device: {}, rhi: { createBuffer: () => ({}) }, format: 'bgra8unorm' },
    dirtied: 0,
    invalidated: 0,
    // #2128 — `needsRender` + `domains` mirror the real map's state, so the
    // assertions below can be about the LOOP and the DOMAINS instead of about
    // which method was called. A counter-only mock cannot tell those apart.
    needsRender: false,
    domains: 0,
    markLabelDirty() {
      // XGISMap.markLabelDirty → _markDirty(LABEL) (map.ts:1000, 979-982):
      // re-arms the frame AND tags LABEL.
      this.dirtied++
      this.needsRender = true
      this.domains |= DirtyDomain.LABEL
    },
    invalidate() {
      // XGISMap.invalidate (map.ts:964-978): re-arms the frame AND tags every
      // domain (the explicit 8-way OR there === DIRTY_ALL).
      this.invalidated++
      this.needsRender = true
      this.domains |= DIRTY_ALL
    },
    ...over,
  }
  return h as unknown as GateHost & {
    dirtied: number
    invalidated: number
    needsRender: boolean
    domains: number
  }
}

describe('ensureBackgroundPatternAtlas — the label-less atlas gate (#777 I-E)', () => {
  it('builds the IconStage for a pattern style; onLanded re-arms the loop and tags beyond LABEL', async () => {
    const host = gateHost({})
    ensureBackgroundPatternAtlas(host, 2, 4)
    expect(host.iconStage).not.toBeNull()
    // Wait for the atlas's terminal state (failed here — node fetch rejects the
    // relative URL): the gate's onLanded fires with it.
    await (host.iconStage as unknown as { whenReady(): Promise<void> }).whenReady()
    // Root cause B: a label-less style has no other path back to _needsRender.
    // Either call satisfies this one — it reddens only if onLanded does neither.
    expect(host.needsRender, 'onLanded must re-arm the render loop').toBe(true)
    // LABEL half — the glyph-parity re-prep convention.
    expect(host.dirtied, 'onLanded must tag LABEL (markLabelDirty)').toBe(1)
    // Beyond-LABEL half — what landed is the SPRITE atlas, whose consumer is
    // _resolveFillPatterns on the synthetic earth-surface show, not a label.
    expect(
      host.domains & ~DirtyDomain.LABEL,
      'onLanded must tag more than LABEL — the landed sprite feeds the synthetic show fill-pattern, which is not a LABEL consumer (invalidate)',
    ).not.toBe(0)
  })

  it.each([
    ['no pattern', { _backgroundPattern: null }],
    ['no sprite URL', { spriteUrl: null }],
    ['stage already built', { iconStage: {} as never }],
  ])('no-op when %s', (_name, over) => {
    const host = gateHost(over as Partial<GateHost>)
    const before = host.iconStage
    ensureBackgroundPatternAtlas(host, 1, 1)
    expect(host.iconStage).toBe(before)
    expect(host.invalidated).toBe(0)
    expect(host.dirtied).toBe(0)
    expect(host.needsRender).toBe(false)
    expect(host.domains).toBe(0)
  })
})
