import { describe, expect, it } from 'vitest'
import { labelsHaveTimeAnimation } from './map-geo-helpers'

// S16 fix — the label-prepare skip omits the animation clock from its
// signature, so a time-driven label must keep re-collating on a static-camera
// frame. labelsHaveTimeAnimation flags exactly that case (and NOT zoom-interp,
// which the signature's zoom term already covers).

// Minimal PropertyShape stand-ins (only `.kind` is read).
const constant = { kind: 'constant' } as never
const zoom = { kind: 'zoom-interpolated' } as never
const time = { kind: 'time-interpolated' } as never
const zoomTime = { kind: 'zoom-time' } as never

function show(shapes: Record<string, unknown> | null) {
  return { label: shapes === null ? null : { shapes: shapes as never } }
}

describe('labelsHaveTimeAnimation', () => {
  it('false for a scene with no labels', () => {
    expect(labelsHaveTimeAnimation([{}, show(null)])).toBe(false)
  })

  it('false when every label shape is constant or zoom-interpolated', () => {
    expect(labelsHaveTimeAnimation([
      show({ size: constant, color: zoom, haloWidth: null, opacity: zoom }),
    ])).toBe(false)
  })

  it('true when a label size is time-interpolated', () => {
    expect(labelsHaveTimeAnimation([show({ size: time, color: null })])).toBe(true)
  })

  it('true when a label color is zoom-time (carries the time bit)', () => {
    expect(labelsHaveTimeAnimation([show({ size: constant, color: zoomTime })])).toBe(true)
  })

  it('true when ANY show in the scene has a time-driven label', () => {
    expect(labelsHaveTimeAnimation([
      show({ size: constant, color: zoom }),
      show({ size: constant, iconOpacity: time }),
    ])).toBe(true)
  })

  it('checks icon-driven shapes (iconSize/iconColor) too', () => {
    expect(labelsHaveTimeAnimation([show({ size: constant, iconColor: time })])).toBe(true)
    expect(labelsHaveTimeAnimation([show({ size: constant, iconSize: zoomTime })])).toBe(true)
  })
})
