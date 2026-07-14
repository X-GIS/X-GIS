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
//      a label-less pattern style, and its onLanded GUARANTEES a frame:
//      markLabelDirty() alone never re-arms a label-less idle loop (the
//      probe's root cause B — the canvas froze on the pre-atlas frame), so it
//      must also call invalidate(). Fail-before = onLanded without
//      invalidate().

import { describe, it, expect } from 'vitest'
import {
  buildSyntheticEarthSurfaceShow,
  syntheticEarthSurfaceCarrier,
} from '../../synthetic-earth-surface-show'
import { ensureBackgroundPatternAtlas } from './label-pass'

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
} {
  const h = {
    iconStage: null,
    spriteUrl: '/fixture-sprite',
    _backgroundPattern: 'pat',
    ctx: { device: {}, rhi: { createBuffer: () => ({}) }, format: 'bgra8unorm' },
    dirtied: 0,
    invalidated: 0,
    markLabelDirty() {
      this.dirtied++
    },
    invalidate() {
      this.invalidated++
    },
    ...over,
  }
  return h as unknown as GateHost & { dirtied: number; invalidated: number }
}

describe('ensureBackgroundPatternAtlas — the label-less atlas gate (#777 I-E)', () => {
  it('builds the IconStage for a pattern style; onLanded guarantees a frame (invalidate + markLabelDirty)', async () => {
    const host = gateHost({})
    ensureBackgroundPatternAtlas(host, 2, 4)
    expect(host.iconStage).not.toBeNull()
    // Wait for the atlas's terminal state (failed here — node fetch rejects the
    // relative URL): the gate's onLanded fires with it. Root cause B demands it
    // RE-ARM the loop — a label-less style has no other path back to
    // _needsRender — so invalidate() must have been called, not just
    // markLabelDirty().
    await (host.iconStage as unknown as { whenReady(): Promise<void> }).whenReady()
    expect(host.invalidated).toBe(1)
    expect(host.dirtied).toBe(1)
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
  })
})
