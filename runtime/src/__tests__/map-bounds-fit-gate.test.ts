import { describe, expect, it, vi } from 'vitest'
import { XGISMap } from '../engine/map'

// CPU regression: demos with deep-link hash URLs like
// `#19.80/21.55/108.05/75/64.2` used to snap back to whole-world view
// as soon as the GeoJSON worker compile resolved — the inline
// bounds-fit branch unconditionally recentered the camera to the
// data extent. The fix introduces an explicit-positioning flag that
// the demo runner flips via `markCameraPositioned()` after
// applyHashToCamera, suppressing the next bounds-fit.
//
// This test exercises the flag's state machine directly via a test-
// seam (`_runBoundsFitGate`) that wraps the fit effect, without
// requiring a GPU device or a worker pool. The invariants:
//   1. Fresh XGISMap → flag false → gate OPEN (fit runs).
//   2. After markCameraPositioned() → flag true → gate CLOSED.
//   3. `run()` resets the flag so the next source gets the default
//      bounds-fit behaviour.

function mockCanvas(): HTMLCanvasElement {
  // Minimum surface XGISMap's constructor touches (no GPU work).
  return { width: 1200, height: 800 } as unknown as HTMLCanvasElement
}

describe('XGISMap bounds-fit gate', () => {
  it('opens by default on a fresh instance', () => {
    const map = new XGISMap(mockCanvas())
    expect(map._cameraPositionedFlag).toBe(false)

    const apply = vi.fn()
    const ran = map._runBoundsFitGate(apply)
    expect(ran).toBe(true)
    expect(apply).toHaveBeenCalledOnce()
  })

  it('closes after markCameraPositioned() — hash apply suppresses the fit', () => {
    const map = new XGISMap(mockCanvas())
    map.markCameraPositioned()
    expect(map._cameraPositionedFlag).toBe(true)

    const apply = vi.fn()
    const ran = map._runBoundsFitGate(apply)
    expect(ran).toBe(false)
    expect(apply).not.toHaveBeenCalled()
  })

  it('the gate is idempotent — repeated markCameraPositioned calls stay closed', () => {
    const map = new XGISMap(mockCanvas())
    map.markCameraPositioned()
    map.markCameraPositioned()
    map.markCameraPositioned()

    const apply = vi.fn()
    expect(map._runBoundsFitGate(apply)).toBe(false)
    expect(apply).not.toHaveBeenCalled()
  })

  it('gate state is independent of the camera object — setting camera directly does NOT close the gate', () => {
    // markCameraPositioned is an EXPLICIT signal. Mutating the Camera
    // instance (e.g. via getCamera().centerX = …) without calling the
    // flag-setter intentionally doesn't count as explicit positioning
    // — keeps the door open for internal consumers that want to
    // pre-populate the camera but still defer to bounds-fit.
    const map = new XGISMap(mockCanvas())
    const cam = map.getCamera()
    cam.centerX = 12345
    cam.centerY = 67890
    cam.zoom = 15

    const apply = vi.fn()
    expect(map._runBoundsFitGate(apply)).toBe(true)
    expect(apply).toHaveBeenCalledOnce()
  })
})
