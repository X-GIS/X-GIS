import { test, expect } from '@playwright/test'

// #2166 RESIDUAL GATE — the corrected text-pitch-alignment record, made checkable.
//
// The coverage row and the converter warning now claim something CI could not
// otherwise verify: that `line` placement IS ground-projected and `line-center`
// is NOT. A claim in a note is invisible to every existing gate
// (spec-coverage-drift.test.ts matches row PRESENCE, not correctness), which is
// exactly how the falsehood this issue removes survived three shipped
// increments. So the two halves of the claim are measured here, in ONE spec,
// against two fixtures that differ in the placement utility and in nothing else:
// same six roads, same embedded geometry, same camera, same zoom, same pitch.
//
// `labels.groundAligned` is counted at the single place draws are handed to the
// renderer (text-renderer.ts, `setDraws`), the same instrument the two sibling
// gates use and for the same reason they use it: an ink-area measurement on this
// scene reproduces its own numbers with the producer pinned to `undefined`
// (see the note at the head of _label-pitch-alignment-gate.spec.ts).
//
//   fixture_curved_label_ground     (label-along-path) pitch 60 ⇒ groundAligned > 0
//   fixture_label_linecenter_ground (label-line-center) pitch 60 ⇒ groundAligned === 0
//
// z14, not the sibling gates' z16.7, and the `drawn > 0` rungs below are why:
// MEASURED, the line-center arm submits ZERO labels at z16.7 on this scene —
// forEachLineLabelFeature collapses each feature to its longest segment PER
// TILE, and at that zoom the roads are split across tiles the collapse leaves
// nothing placeable in. A gate that read `groundAligned === 0` there would be
// measuring a silence, which is precisely the vacuity CLAUDE.md §12 warns about.
// At z14 both arms are live (line 12 submitted / 3 drawn, line-center 14 / 6).
//
// The second arm is only meaningful next to the first: a gate that asserted 0
// alone would pass on a tree where the whole feature is dead. Asserting the pair
// in one run is what makes the 0 a RESIDUAL rather than a silence.
//
// Headless SwiftShader (HEADED=0 XGIS_SOFTWARE_GPU=1), `?forcegl2=1`, backend
// asserted so a silent fallback cannot green it. `?adaptive=0` pins the
// wall-clock-driven quality controller out of the tile selector (#2120).

interface Labels {
  submitted: number
  drawn: number
  groundAligned: number
}

async function frameAt(
  page: import('@playwright/test').Page,
  id: string,
  pitch: number,
): Promise<{ labels: Labels; backend: string; livePitch: number }> {
  await page.setViewportSize({ width: 1200, height: 800 })
  await page.goto(`/demo.html?id=${id}&forcegl2=1&e2e=1&adaptive=0`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 60_000 },
  )
  await page.evaluate(
    (cam) => {
      // Driven through the map, not the URL hash — the hash form left pitch at 0
      // in the sibling gates and both frames came back identical. `livePitch`
      // below pins that it took.
      const R = 6378137
      const RAD = Math.PI / 180
      const m = (
        window as unknown as {
          __xgisMap: {
            getCamera(): {
              zoom: number
              centerX: number
              centerY: number
              bearing: number
              pitch: number
            }
            markCameraPositioned(): void
            invalidate?(): void
          }
        }
      ).__xgisMap
      const c = m.getCamera()
      c.zoom = 14
      c.centerX = 126.79102 * RAD * R
      c.centerY = Math.log(Math.tan(Math.PI / 4 + (37.79172 * RAD) / 2)) * R
      c.bearing = 0
      c.pitch = cam.pitch
      m.markCameraPositioned()
      m.invalidate?.()
    },
    { pitch },
  )
  await page.waitForTimeout(8000)
  return await page.evaluate(() => {
    const w = window as unknown as {
      __xgisMap: {
        inspectPipeline(): { labels: Labels }
        ctx?: { rhi?: { backend?: string } }
        getCamera(): { pitch: number }
      }
    }
    return {
      labels: w.__xgisMap.inspectPipeline().labels,
      backend: w.__xgisMap.ctx?.rhi?.backend ?? 'unknown',
      livePitch: w.__xgisMap.getCamera().pitch,
    }
  })
}

test.describe.configure({ mode: 'serial', timeout: 300_000 })

test('#2166 — `line` ground-projects and `line-center` does not, on one camera', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))

  const curved = await frameAt(page, 'fixture_curved_label_ground', 60)
  const center = await frameAt(page, 'fixture_label_linecenter_ground', 60)

  console.log(
    `\n  line        pitch 60: ${JSON.stringify(curved.labels)}` +
      `\n  line-center pitch 60: ${JSON.stringify(center.labels)}` +
      `\n  backend=${curved.backend}\n`,
  )

  expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([])
  expect(curved.backend).toBe('webgl2')
  expect(center.backend).toBe('webgl2')
  expect(curved.livePitch).toBeCloseTo(60, 3)
  expect(center.livePitch).toBeCloseTo(60, 3)

  // Both frames must be drawing labels, or every count below is vacuous.
  expect(curved.labels.drawn, 'the line fixture drew no labels').toBeGreaterThan(0)
  expect(center.labels.drawn, 'the line-center fixture drew no labels').toBeGreaterThan(0)

  // HALF ONE — the claim the corrected note makes about `line`. This is also
  // what makes the second assertion a residual rather than a dead feature: if
  // ground projection were broken outright, this fails first.
  expect(
    curved.labels.groundAligned,
    `no drawn label carried a ground basis on the LINE fixture at pitch 60 ` +
      `(drawn ${curved.labels.drawn}) — the coverage note claims line placement is ` +
      `ground-projected, and on this tree it is not`,
  ).toBeGreaterThan(0)

  // HALF TWO — the residual the corrected note and the narrowed converter
  // warning both name. line-center takes the non-curved fallback
  // (place-labels-along-line.ts emitLabelAlongSegment), which calls addLabel
  // with no basis argument at all, EVEN with an explicit
  // label-pitch-alignment-map on the layer.
  expect(
    center.labels.groundAligned,
    `a ground basis reached ${center.labels.groundAligned} of ${center.labels.drawn} ` +
      `line-center draws — the residual named in the text-pitch-alignment coverage note ` +
      `and in the converter warning is no longer true, so BOTH must be re-written`,
  ).toBe(0)
})
