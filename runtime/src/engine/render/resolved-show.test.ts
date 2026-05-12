// Unit tests for the Phase 4a ResolvedShow snapshot — verifies the
// per-frame resolver collapses every PaintShapes axis to the same
// scalar / RGBA the in-place classifier (bucket-scheduler.ts) writes.

import { describe, it, expect } from 'vitest'
import { resolveShow } from './resolved-show'

interface PartialPaintShapes {
  fill?: unknown
  stroke?: unknown
  opacity?: unknown
  strokeWidth?: unknown
  size?: unknown
}

// Build a ShowCommand-shaped stub. The resolver only reads `paintShapes`
// + a few legacy scalars; everything else is irrelevant for these tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function show(ps: PartialPaintShapes, extras: Record<string, unknown> = {}): any {
  return {
    targetName: 'src',
    layerName: 'L1',
    paintShapes: {
      opacity: ps.opacity ?? { kind: 'constant', value: 1 },
      strokeWidth: ps.strokeWidth ?? { kind: 'constant', value: 1 },
      size: ps.size ?? null,
      fill: ps.fill ?? null,
      stroke: ps.stroke ?? null,
    },
    ...extras,
  }
}

const env = { cameraZoom: 5, elapsedMs: 0 }

describe('resolveShow — constant paint shapes', () => {
  it('passes a constant opacity through unchanged', () => {
    const r = resolveShow(show({ opacity: { kind: 'constant', value: 0.5 } }), env)
    expect(r.opacity).toBe(0.5)
  })

  it('passes a constant strokeWidth through unchanged', () => {
    const r = resolveShow(show({ strokeWidth: { kind: 'constant', value: 3 } }), env)
    expect(r.strokeWidth).toBe(3)
  })

  it('emits null fill / stroke when the shape is absent', () => {
    const r = resolveShow(show({}), env)
    expect(r.fill).toBeNull()
    expect(r.stroke).toBeNull()
  })

  it('emits null fill when shape is constant — caller reads static hex', () => {
    // constant colour shapes return null from the resolver because
    // the static `show.fill` hex is authoritative downstream. The
    // resolver propagates that null unless `show.resolvedFillRgba`
    // (bake-time staging) exists.
    const r = resolveShow(show({
      fill: { kind: 'constant', value: [1, 0, 0, 1] },
    }), env)
    expect(r.fill).toBeNull()
  })
})

describe('resolveShow — zoom-interpolated', () => {
  it('interpolates opacity across zoom stops', () => {
    const r = resolveShow(show({
      opacity: { kind: 'zoom-interpolated', base: 1, stops: [
        { zoom: 0, value: 0 },
        { zoom: 10, value: 1 },
      ] },
    }), { cameraZoom: 5, elapsedMs: 0 })
    expect(r.opacity).toBeCloseTo(0.5, 3)
  })

  it('interpolates strokeWidth across zoom stops', () => {
    const r = resolveShow(show({
      strokeWidth: { kind: 'zoom-interpolated', base: 1, stops: [
        { zoom: 0, value: 1 },
        { zoom: 10, value: 5 },
      ] },
    }), { cameraZoom: 5, elapsedMs: 0 })
    expect(r.strokeWidth).toBeCloseTo(3, 3)
  })

  it('interpolates RGBA fill across zoom stops', () => {
    const r = resolveShow(show({
      fill: { kind: 'zoom-interpolated', base: 1, stops: [
        { zoom: 0, value: [1, 0, 0, 1] },
        { zoom: 10, value: [0, 0, 1, 1] },
      ] },
    }), { cameraZoom: 5, elapsedMs: 0 })
    expect(r.fill).not.toBeNull()
    expect(r.fill![0]).toBeCloseTo(0.5, 2)
    expect(r.fill![2]).toBeCloseTo(0.5, 2)
  })
})

describe('resolveShow — zoom × time composition', () => {
  it('composes opacity = zoomFactor × timeFactor for the zoom-time shape', () => {
    // The classifier's legacy `zoomOpa * timeOpa` rule is replayed
    // by resolveNumberShape on the `zoom-time` kind.
    const r = resolveShow(show({
      opacity: {
        kind: 'zoom-time',
        zoomStops: [{ zoom: 0, value: 0 }, { zoom: 10, value: 1 }],
        timeStops: [{ timeMs: 0, value: 1 }, { timeMs: 1000, value: 0.5 }],
        loop: false, easing: 'linear', delayMs: 0,
      },
    }), { cameraZoom: 5, elapsedMs: 1000 })
    expect(r.opacity).toBeCloseTo(0.5 * 0.5, 3)
  })
})

describe('resolveShow — layerName tag', () => {
  it('prefers DSL layerName when present', () => {
    const r = resolveShow(show({}, { layerName: 'roads', sourceLayer: 'transportation' }), env)
    expect(r.layerName).toBe('roads')
  })

  it('falls back to sourceLayer when DSL layerName is missing', () => {
    const r = resolveShow(show({}, { layerName: undefined, sourceLayer: 'transportation' }), env)
    expect(r.layerName).toBe('transportation')
  })

  it('falls back to targetName when both DSL and source are missing', () => {
    const r = resolveShow(show({}, { layerName: undefined, sourceLayer: undefined, targetName: 'src' }), env)
    expect(r.layerName).toBe('src')
  })
})

describe('resolveShow — readonly output (sanity)', () => {
  it('returns an object literal — runtime mutation is allowed (TS readonly only)', () => {
    // The `readonly` keywords are TypeScript-level; runtime stays
    // mutable. The TS gate is what catches the regression (callers
    // can no longer write `resolved.opacity = …`). This test just
    // pins the contract.
    const r = resolveShow(show({}), env)
    expect(typeof r.opacity).toBe('number')
    expect(typeof r.strokeWidth).toBe('number')
    expect(typeof r.layerName).toBe('string')
  })
})
