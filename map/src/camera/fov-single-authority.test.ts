import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CAMERA_FOV_DEG, CAMERA_FOV_RAD } from '@xgis/shared'
import { Camera } from './camera'

// ═══════════════════════════════════════════════════════════════════
// The camera FOV has ONE authority (#1440).
// ═══════════════════════════════════════════════════════════════════
//
// `@xgis/map`'s camera builds its projection from the field of view;
// `@xgis/data`'s SSE tile selector re-derives the camera altitude and the
// screen-space error from it. The two packages cannot import each other, so
// the number lived as a literal in each — and they drifted. `tiles-sse.ts`
// carried
//
//   const FOV_DEG = 45 // Camera.FOV — fixed in this engine
//
// while `Camera.FOV` was 36.87 deg. The comment asserted they were the same
// value. They were not, and had not been since the camera moved to MapLibre's
// default: `tanHalfFov` was 0.41421 where the renderer used 0.33333, 24 % out,
// feeding a wrong altitude, ssePx, horizon distance and far-field ramp into
// every SSE selection.
//
// Both now read `CAMERA_FOV_RAD` from `@xgis/shared`, the zero-dep bedrock they
// already share, so there is nothing left to keep in sync. These are the gates
// that keep it that way.

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..')

describe('camera FOV — one constant, two packages (#1440)', () => {
  it('Camera.FOV is the shared constant, not a restatement of it', () => {
    expect(Camera.FOV).toBe(CAMERA_FOV_DEG)
  })

  it('keeps MapLibre default parity — 0.6435011087932844 rad', () => {
    // The value itself is load-bearing: a shared camera hash must frame the
    // same view in both engines, which is why it is MapLibre's
    // `_fovInRadians` exactly rather than a round 45 or 36.9.
    expect(CAMERA_FOV_RAD).toBe(0.6435011087932844)
    expect(CAMERA_FOV_DEG).toBeCloseTo(36.8699, 4)
  })

  it('degrees and radians describe the same angle', () => {
    expect((CAMERA_FOV_DEG * Math.PI) / 180).toBeCloseTo(CAMERA_FOV_RAD, 15)
  })

  it('no consumer restates the FOV as a literal', () => {
    // A source gate, and honest about being one: it cannot prove a consumer
    // USES the shared constant, only that it has not written its own. That is
    // exactly the failure that happened — a second literal with a comment
    // claiming it matched — so it is the failure worth gating.
    const files = [
      'data/src/tiles-sse.ts',
      'data/src/tile-select.ts',
      'map/src/camera/camera.ts',
      'map/src/camera/view-matrix.ts',
    ]
    for (const rel of files) {
      const src = readFileSync(join(REPO_ROOT, rel), 'utf8')
      // Strip comments — the history above is written in them on purpose.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      expect(code, `${rel} declares its own FOV`).not.toMatch(/\bFOV\w*\s*=\s*[\d.]/)
      expect(code, `${rel} hardcodes the FOV in radians`).not.toContain('0.6435011087932844')
    }
  })

  it('the selector and the renderer derive the SAME camera altitude', () => {
    // The consequence that actually mattered. `mvp[15]` is the camera's orbit
    // distance; `visibleTilesSSE` recomputes it as
    // `cssHeight * metresPerPixel / 2 / tan(fov/2)` to place its horizon and
    // score its screen-space error. Under the drift the selector believed the
    // camera sat 2030 m out where the renderer put it at 2523 m.
    const W = 639
    const H = 704
    const cam = new Camera(-0.11813, 51.50466, 16)
    cam.pitch = 72.4
    cam.bearing = 60
    cam.syncCenterLat()

    const mpp = 40075016.685578488 / 512 / 2 ** 16
    const selectorAltitude = (H * mpp) / 2 / Math.tan(CAMERA_FOV_RAD / 2)
    const rendererAltitude = cam.getFrameView(W, H, 1).matrix[15]!

    expect(selectorAltitude).toBeCloseTo(rendererAltitude, 3)
    // Witness the size of the bug this closes: the old 45 deg literal put the
    // selector ~20 % nearer the ground than the renderer.
    const driftedAltitude = (H * mpp) / 2 / Math.tan((45 * Math.PI) / 180 / 2)
    expect(driftedAltitude / rendererAltitude).toBeCloseTo(0.8047, 3)
  })
})
