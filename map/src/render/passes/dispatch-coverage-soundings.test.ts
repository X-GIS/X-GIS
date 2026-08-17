// ═══ `soundingUnprojector` — globe/azimuthal sounding numerals (#1435) ═══
//
// Every visible-range probe in `coverageSoundingAnchors` (coverage-sounding-anchors.ts)
// went through `Camera.unprojectToLonLat`, which describes the flat Mercator plane ONLY —
// `relToLonLat` (camera/unproject.ts) returns null unconditionally once `view.globeMode` is
// set, which is exactly the state the render loop puts the camera in for the true globe AND
// for a tilted azimuthal disc (promoted to projType 7). So every probe came back null, the
// walk's `visibleCellRange` returned null, and `coverageSoundingAnchors` returned `[]` — no
// sounding numerals ever drew on those projections. `soundingUnprojector` is the fix: the
// same globeMode fork the pointer path already takes (`interaction-controller.ts`
// `clientToLngLat`), pointed at the SAME ray↔sphere authority (`unprojectGlobeFromCamera`) —
// not a second grid-space selection path, per the issue's single-authority constraint.

import { describe, it, expect } from 'vitest'
import { coverageFromGrids, type CoverageHandle } from '@xgis/data'
import { Camera } from '../../camera'
import { coverageSoundingAnchors, SOUNDING_MAX_CANDIDATES } from '../../coverage-sounding-anchors'
import { soundingUnprojector } from './dispatch-coverage-soundings'

const W = 800
const H = 600
const DPR = 1

/** depth = col + 10·rowFromSouth, so a value names the cell it came from — same convention
 *  as coverage-sounding-filter.test.ts's fixture. Centred on (0,0) lon/lat so a pitch-0 globe
 *  camera aimed at (0,0) looks straight down its middle. */
function gridAtEquator(): CoverageHandle {
  const N = 11
  const v = new Float32Array(N * N)
  for (let rowS = 0; rowS < N; rowS++) {
    for (let col = 0; col < N; col++) v[(N - 1 - rowS) * N + col] = col + 10 * rowS
  }
  return coverageFromGrids({
    product: 's102',
    crs: null,
    origin: [-5, -5],
    spacing: [1, 1],
    size: [N, N],
    bands: [{ name: 'depth', unit: 'metres', kind: 'f32', nodata: 1e6, values: v }],
    vertical: { datumCode: 23, sign: 'down' },
  })
}

describe('soundingUnprojector — globe/azimuthal coverage soundings (#1435)', () => {
  it('a globe-mode camera at screen centre: OLD wiring (bare unprojectToLonLat) is null, soundingUnprojector recovers the true camera centre', () => {
    const cam = new Camera(0, 0, 2)
    cam.globeMode = true
    cam.projType = 7 // matches render-loop.ts: globeMode ⇒ projType 7

    // The exact old closure label-pass.ts wired in (line 1099, pre-fix): flat-plane-only,
    // returns null unconditionally once globeMode is set (unproject.ts relToLonLat:99).
    const oldWiring = cam.unprojectToLonLat(W / 2, H / 2, W, H, DPR)
    expect(oldWiring).toBeNull()

    // soundingUnprojector forks on globeMode to the ray↔sphere authority instead.
    const fixed = soundingUnprojector(cam, W, H, DPR)(W / 2, H / 2)
    expect(fixed).not.toBeNull()
    // pitch 0 / bearing 0 ⇒ the screen-centre ray looks straight down the surface normal
    // at the camera's own centre, so the recovered point IS (0,0) to sub-mm precision.
    expect(fixed![0]).toBeCloseTo(0, 6)
    expect(fixed![1]).toBeCloseTo(0, 6)
  })

  it('FAIL-BEFORE mechanism: the old wiring starves the whole sounding walk on a globe camera, soundingUnprojector feeds it', () => {
    const handle = gridAtEquator()
    const cam = new Camera(0, 0, 2)
    cam.globeMode = true
    cam.projType = 7
    const opts = { width: W, height: H, spacingPx: 56 * DPR }

    // OLD wiring: every probe in visibleCellRange is null (globeMode short-circuits
    // relToLonLat), so the range is null and the walk returns [] — reproduces the bug.
    const before = coverageSoundingAnchors(
      handle,
      (px, py) => cam.unprojectToLonLat(px, py, W, H, DPR),
      opts,
    )
    expect(before).toEqual([])

    // NEW wiring: soundingUnprojector's globe branch lands probes on the sphere, so the
    // walk finds cells and emits numerals.
    const after = coverageSoundingAnchors(handle, soundingUnprojector(cam, W, H, DPR), opts)
    expect(after.length).toBeGreaterThan(0)
    expect(after.length).toBeLessThanOrEqual(SOUNDING_MAX_CANDIDATES)
    // Non-vacuous: the selected cells actually carry the fixture's values, not placeholders.
    for (const a of after) expect(a.values.depth).toBe(a.col + 10 * a.rowFromSouth)
  })

  it('flat (non-globe) camera: soundingUnprojector is byte-identical to the pre-fix direct call — the mercator path is untouched', () => {
    const handle = gridAtEquator()
    const cam = new Camera(0, 0, 2)
    expect(cam.globeMode).toBe(false)
    const opts = { width: W, height: H, spacingPx: 56 * DPR }

    const direct = coverageSoundingAnchors(
      handle,
      (px, py) => cam.unprojectToLonLat(px, py, W, H, DPR),
      opts,
    )
    const viaHelper = coverageSoundingAnchors(handle, soundingUnprojector(cam, W, H, DPR), opts)
    // Non-vacuous: both sides must actually select something, or an "equal" result could be
    // two empty arrays agreeing on nothing.
    expect(direct.length).toBeGreaterThan(0)
    expect(viaHelper).toEqual(direct)
  })
})
