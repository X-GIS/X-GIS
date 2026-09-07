// Unit tests for buildLabelShapes. Pins the precedence rule
// (data-driven > zoom-stops > constant) on each of the eight
// shape-able label paint properties.
//
// #2534 folded eight copies of that ladder into one `pickShape`, and four
// of the eight had no test at all — the ones this file did not cover could
// have been rewritten wrongly and every gate would still have been green.
// The icon / opacity axes below close that, and they are not symmetric:
// `opacity` deliberately has NO constant arm (a constant text-opacity is
// folded into color.a upstream) while `iconOpacity` does, so a helper that
// treated the two alike would pass one and fail the other.

import { describe, it, expect } from 'vitest'
import { buildLabelShapes } from '../ir/render-node'
import type { ZoomStop, DataExpr } from '../ir/render-node'

const FAKE_EXPR: DataExpr = { ast: { kind: 'NumberLiteral', value: 0, unit: null } as never }
const SIZE_STOPS: ZoomStop<number>[] = [
  { zoom: 4, value: 10 },
  { zoom: 16, value: 22 },
]
const COLOR_STOPS: ZoomStop<[number, number, number, number]>[] = [
  { zoom: 4, value: [1, 0, 0, 1] },
  { zoom: 16, value: [0, 0, 1, 1] },
]
const RED: [number, number, number, number] = [1, 0, 0, 1]
const BLACK: [number, number, number, number] = [0, 0, 0, 1]

describe('buildLabelShapes — size precedence', () => {
  it('uses constant when no stops and no expr', () => {
    const shapes = buildLabelShapes({ size: 14 })
    expect(shapes.textLayout.size).toEqual({ kind: 'constant', value: 14 })
  })

  it('uses zoom-interpolated when sizeZoomStops set', () => {
    const shapes = buildLabelShapes({ size: 14, sizeZoomStops: SIZE_STOPS })
    expect(shapes.textLayout.size.kind).toBe('zoom-interpolated')
    if (shapes.textLayout.size.kind === 'zoom-interpolated') {
      expect(shapes.textLayout.size.stops).toBe(SIZE_STOPS)
    }
  })

  it('carries sizeZoomStopsBase through', () => {
    const shapes = buildLabelShapes({
      size: 14,
      sizeZoomStops: SIZE_STOPS,
      sizeZoomStopsBase: 1.5,
    })
    if (shapes.textLayout.size.kind === 'zoom-interpolated') {
      expect(shapes.textLayout.size.base).toBe(1.5)
    }
  })

  it('data-driven wins over both zoom-stops and constant', () => {
    const shapes = buildLabelShapes({
      size: 14,
      sizeZoomStops: SIZE_STOPS,
      sizeExpr: FAKE_EXPR,
    })
    expect(shapes.textLayout.size.kind).toBe('data-driven')
  })
})

describe('buildLabelShapes — color precedence', () => {
  it('null when no color authored', () => {
    const shapes = buildLabelShapes({ size: 14 })
    expect(shapes.textPaint.color).toBeNull()
  })

  it('constant when only `color` set', () => {
    const shapes = buildLabelShapes({ size: 14, color: RED })
    expect(shapes.textPaint.color).toEqual({ kind: 'constant', value: RED })
  })

  it('zoom-interpolated when colorZoomStops set', () => {
    const shapes = buildLabelShapes({ size: 14, color: RED, colorZoomStops: COLOR_STOPS })
    expect(shapes.textPaint.color?.kind).toBe('zoom-interpolated')
  })

  it('data-driven wins', () => {
    const shapes = buildLabelShapes({
      size: 14,
      color: RED,
      colorZoomStops: COLOR_STOPS,
      colorExpr: FAKE_EXPR,
    })
    expect(shapes.textPaint.color?.kind).toBe('data-driven')
  })
})

describe('buildLabelShapes — halo width', () => {
  it('null when no halo authored', () => {
    const shapes = buildLabelShapes({ size: 14 })
    expect(shapes.textPaint.haloWidth).toBeNull()
  })

  it('constant from halo.width', () => {
    const shapes = buildLabelShapes({ size: 14, halo: { color: BLACK, width: 2 } })
    expect(shapes.textPaint.haloWidth).toEqual({ kind: 'constant', value: 2 })
  })

  it('zoom-interpolated wins over constant', () => {
    const stops: ZoomStop<number>[] = [
      { zoom: 4, value: 1 },
      { zoom: 12, value: 3 },
    ]
    const shapes = buildLabelShapes({
      size: 14,
      halo: { color: BLACK, width: 2 },
      haloWidthZoomStops: stops,
      haloWidthZoomStopsBase: 2,
    })
    expect(shapes.textPaint.haloWidth?.kind).toBe('zoom-interpolated')
    if (shapes.textPaint.haloWidth?.kind === 'zoom-interpolated') {
      expect(shapes.textPaint.haloWidth.base).toBe(2)
    }
  })
})

describe('buildLabelShapes — halo color', () => {
  it('null when no halo authored', () => {
    const shapes = buildLabelShapes({ size: 14 })
    expect(shapes.textPaint.haloColor).toBeNull()
  })

  it('constant from halo.color', () => {
    const shapes = buildLabelShapes({ size: 14, halo: { color: BLACK, width: 1 } })
    expect(shapes.textPaint.haloColor).toEqual({ kind: 'constant', value: BLACK })
  })

  it('zoom-interpolated wins over constant', () => {
    const shapes = buildLabelShapes({
      size: 14,
      halo: { color: BLACK, width: 1 },
      haloColorZoomStops: COLOR_STOPS,
    })
    expect(shapes.textPaint.haloColor?.kind).toBe('zoom-interpolated')
  })
})

describe('buildLabelShapes — icon size precedence', () => {
  it('null when no icon size authored', () => {
    expect(buildLabelShapes({ size: 14 }).icon.iconSize).toBeNull()
  })

  it('constant from iconSize', () => {
    expect(buildLabelShapes({ size: 14, iconSize: 2 }).icon.iconSize).toEqual({
      kind: 'constant',
      value: 2,
    })
  })

  it('zoom-interpolated wins over constant', () => {
    const shapes = buildLabelShapes({ size: 14, iconSize: 2, iconSizeZoomStops: SIZE_STOPS })
    expect(shapes.icon.iconSize?.kind).toBe('zoom-interpolated')
  })

  it('data-driven wins over both', () => {
    const shapes = buildLabelShapes({
      size: 14,
      iconSize: 2,
      iconSizeZoomStops: SIZE_STOPS,
      iconSizeExpr: FAKE_EXPR,
    })
    expect(shapes.icon.iconSize?.kind).toBe('data-driven')
  })
})

describe('buildLabelShapes — text opacity has NO constant arm', () => {
  it('null when only a constant colour is authored', () => {
    expect(buildLabelShapes({ size: 14, color: RED }).textPaint.opacity).toBeNull()
  })

  it('zoom-interpolated when stops are authored', () => {
    const shapes = buildLabelShapes({ size: 14, opacityZoomStops: SIZE_STOPS })
    expect(shapes.textPaint.opacity?.kind).toBe('zoom-interpolated')
  })

  it('data-driven wins over stops', () => {
    const shapes = buildLabelShapes({
      size: 14,
      opacityZoomStops: SIZE_STOPS,
      opacityExpr: FAKE_EXPR,
    })
    expect(shapes.textPaint.opacity?.kind).toBe('data-driven')
  })
})

describe('buildLabelShapes — icon opacity DOES carry its constant', () => {
  it('null when nothing authored', () => {
    expect(buildLabelShapes({ size: 14 }).icon.iconOpacity).toBeNull()
  })

  it('constant from iconOpacity — the asymmetry with text-opacity', () => {
    expect(buildLabelShapes({ size: 14, iconOpacity: 0.5 }).icon.iconOpacity).toEqual({
      kind: 'constant',
      value: 0.5,
    })
  })

  it('data-driven wins over stops and constant', () => {
    const shapes = buildLabelShapes({
      size: 14,
      iconOpacity: 0.5,
      iconOpacityZoomStops: SIZE_STOPS,
      iconOpacityExpr: FAKE_EXPR,
    })
    expect(shapes.icon.iconOpacity?.kind).toBe('data-driven')
  })
})

describe('buildLabelShapes — icon colour precedence', () => {
  it('null when nothing authored', () => {
    expect(buildLabelShapes({ size: 14 }).icon.iconColor).toBeNull()
  })

  it('constant from iconColor', () => {
    expect(buildLabelShapes({ size: 14, iconColor: RED }).icon.iconColor).toEqual({
      kind: 'constant',
      value: RED,
    })
  })

  it('data-driven wins over stops and constant', () => {
    const shapes = buildLabelShapes({
      size: 14,
      iconColor: RED,
      iconColorZoomStops: COLOR_STOPS,
      iconColorExpr: FAKE_EXPR,
    })
    expect(shapes.icon.iconColor?.kind).toBe('data-driven')
  })
})

describe('buildLabelShapes — the exponential base rides along, and only when given', () => {
  it('carries the base onto the zoom-interpolated shape', () => {
    const shapes = buildLabelShapes({ size: 14, sizeZoomStops: SIZE_STOPS, sizeZoomStopsBase: 2 })
    expect(shapes.textLayout.size).toEqual({
      kind: 'zoom-interpolated',
      stops: SIZE_STOPS,
      base: 2,
    })
  })

  it('omits the KEY entirely when no base was authored (not `base: undefined`)', () => {
    const shapes = buildLabelShapes({ size: 14, sizeZoomStops: SIZE_STOPS })
    expect(shapes.textLayout.size).not.toHaveProperty('base')
  })
})
