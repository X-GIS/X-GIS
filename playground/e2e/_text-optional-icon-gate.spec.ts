import { test, expect } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { captureMapFrame } from './helpers/visual'

// #2440 §5 gate — `text-optional: true` keeps a rejected label's ICON.
//
// WHAT IS BEING MEASURED, and why it is the icon COUNT rather than a pixel
// ratio. One icon quad is 6 vertices, the scene has exactly two paired symbols,
// and the three states of this feature are therefore three distinct numbers:
//
//   0   both icons dropped with their labels — the bug (pre-#2440)
//   6   exactly one survived — the fix: `pair_optional` keeps its icon,
//       `pair_plain` still drops its own (the spec default, text+icon as one)
//   12  both survived — an OVER-BROAD fix that suppressed the drop cascade for
//       every paired symbol, which would silently undo #609's pairing contract
//
// A pixel-count gate distinguishes none of those three (CLAUDE.md §12: a count
// passes on broken images), and "the icon drew" alone passes on the phantom
// this issue is about — a surviving icon that participates in no collision.
//
// ARM A IS THE CONTROL AND IT IS NOT OPTIONAL. Without it, arm B's 6 is
// satisfied by a scene that only ever had one icon — the gate would be
// measuring its own fixture rather than the feature. Arm A pushes the same two
// paired symbols with NO blocker labels: both labels place, both icons draw, 12.
// So arm B's 6 means one of two possible icons was withheld, which is the claim.
//
// The collision is asserted as a PRECONDITION before the icon count is read:
// arm B's blockers must actually win, or the whole gate is vacuous (§12 — assert
// the CAUSE before the EFFECT, or a red run accuses the wrong half).
//
// WHAT THIS GATE DOES NOT SEE, measured rather than assumed. The fix has two
// halves reading one predicate: the cascade suppression (the icon survives) and
// the live-text-set exclusion (the surviving icon seeds its own obstacle box).
// Severing each half separately:
//
//   cut the CASCADE half      -> this gate REDDENS, naming it:
//                                "droppedPairKeys 2 ... the text-optional
//                                cascade suppression did not land"
//   cut the LIVE-SET half     -> this gate STAYS GREEN (icon count is still 6);
//                                `map/src/text/text-optional-obstacle.test.ts`
//                                reddens instead, on `expect(obstacles)
//                                .toHaveLength(1)` — the phantom
//
// So this gate covers the cascade half ONLY, and the obstacle-box half is
// gated at the unit level, which is the natural altitude for a question about
// the collision SET rather than the frame. Written down because a reader who
// assumed this gate covered both would be holding exactly the
// "assertion that failed either way" belief §12 was written for.
//
// THE §5 PIXEL EVIDENCE this gate's frames carry, measured on the arm-B frame
// with the cascade half cut vs restored (same scene, one behaviour different):
//
//   DC 0.2208% of 604x768 = 1024 px = EXACTLY the 32x32 icon quad
//   confined to 2 of 16 tiles (r1c2 + r2c2 — one column, adjacent rows: the
//   quad straddles the row boundary), every other tile 0.00%
//   diff structure: ONE SOLID BLOCK, not paired red/blue parallel edges (a
//   positional shift) and not red-on-both-sides (a width change) — content
//   ADDED, which is the claim
//   arm A near-white 9055 (two icons + labels) vs arm B 1024 (one icon),
//   white x-range 354..385 — the OPTIONAL anchor, 32 px wide
//
// There is no vs-MapLibre D0/D1 rung here and inventing one would be a lie: the
// fixture is synthetic and MapLibre has no counterpart scene to compare against.
// Before/after DC plus the localisation IS the right ladder for a change that
// ADDS content at a known place.
//
// Zero network: geometry via setSourceData, the icon via map.addImage — the
// host-atlas recipe `_host-atlas-icon-gate` documents. Headless SwiftShader.

test.describe.configure({ timeout: 180_000 })

interface Probe {
  ok: boolean
  iconVertexCount: number
  textVertexCount: number
  droppedPairCount: number
  backend?: string
  validation: string[]
}

/** Two paired symbols, far apart so neither arm's label can collide with the
 *  other's — the only collision in the scene is the one the blockers cause. */
const PLAIN = [-12, 0]
const OPTIONAL = [12, 0]

function fc(coords: number[][], name: string) {
  return {
    type: 'FeatureCollection',
    features: coords.map((c) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: c },
      properties: { name },
    })),
  }
}

test('text-optional keeps exactly one of two paired icons (#2440)', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push(m.text().slice(0, 300))
  })

  await page.setViewportSize({ width: 1024, height: 768 })
  // ?adaptive=0 pins the quality controller: it samples wall-clock frame
  // intervals and moves the tile selector's error ceiling, which is a render
  // input a hash-free but count-based gate still should not inherit (#2120).
  // ?proj=mercator pins the PROJECTION, and that is not boilerplate: without it
  // the demo's default put the anchors somewhere this spec's lon/lat -> screen
  // reasoning did not predict, and the frames came back with 258 lit pixels
  // clipped against the right edge. A gate that measures a frame has to pin
  // every input that decides where the frame's content lands.
  await page.goto('/demo.html?id=fixture_text_optional&e2e=1&adaptive=0&proj=mercator#2/0/0', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 45_000 },
  )

  const seed = (withBlockers: boolean) =>
    page.evaluate(
      ({ plain, optional, blockers }) => {
        const map = (
          window as unknown as {
            __xgisMap?: {
              addImage?: (name: string, image: ImageData) => void
              setSourceData?: (id: string, fc: unknown) => void
              invalidate?: () => void
            }
          }
        ).__xgisMap
        const px = new Uint8ClampedArray(32 * 32 * 4)
        for (let i = 0; i < px.length; i += 4) {
          px[i] = 255
          px[i + 1] = 255
          px[i + 2] = 255
          px[i + 3] = 255
        }
        map?.addImage?.('e2e-marker', new ImageData(px, 32, 32))
        map?.setSourceData?.('plain_pins', plain)
        map?.setSourceData?.('optional_pins', optional)
        map?.setSourceData?.('blocker_pins', blockers)
        map?.invalidate?.()
      },
      {
        plain: fc([PLAIN], 'Plain'),
        optional: fc([OPTIONAL], 'Optional'),
        // A blocker sits on each paired anchor and carries the SAME 3.5em text
        // offset, so it collides in the TEXT band while both icons stay in the
        // clear icon band above it — see the fixture header for why that
        // separation is load-bearing rather than cosmetic.
        blockers: withBlockers
          ? fc([PLAIN, OPTIONAL], 'BLOCKERBLOCK')
          : { type: 'FeatureCollection', features: [] },
      },
    )

  const probe = (): Promise<Probe> =>
    page.evaluate(() => {
      const m = (
        window as unknown as {
          __xgisMap?: {
            invalidate?: () => void
            iconStage?: { renderer?: { vertexCount?: number } } | null
            textStage?: {
              renderer?: { vertexCount?: number }
              getDroppedPairKeys?: () => ReadonlySet<string>
            } | null
            ctx?: { rhi?: { backend?: string }; _validationErrors?: { message: string }[] }
          }
        }
      ).__xgisMap
      m?.invalidate?.()
      return {
        ok: m != null,
        iconVertexCount: m?.iconStage?.renderer?.vertexCount ?? 0,
        textVertexCount: m?.textStage?.renderer?.vertexCount ?? 0,
        droppedPairCount: m?.textStage?.getDroppedPairKeys?.().size ?? 0,
        backend: m?.ctx?.rhi?.backend,
        validation: (m?.ctx?._validationErrors ?? []).map((e) => e.message).slice(0, 5),
      }
    })

  /** Poll the engine's own counters to a stable value — never a sleep budget
   *  (capture-canvas skill). A `predicate` that never holds FAILS the spec. */
  async function settle(predicate: (p: Probe) => boolean, what: string): Promise<Probe> {
    const deadline = Date.now() + 60_000
    let r = await probe()
    while (Date.now() < deadline && !predicate(r)) {
      await page.waitForTimeout(1000) // deliberate poll gap between engine reads
      r = await probe()
    }
    expect(predicate(r), `${what} — last probe ${JSON.stringify(r)}`).toBe(true)
    return r
  }

  // ── ARM A (control): no blockers → both labels place, BOTH icons draw ──
  await seed(false)
  const a = await settle((p) => p.ok && p.iconVertexCount > 0, 'arm A: icons dispatched')
  writeFileSync(test.info().outputPath('arm-a-no-blockers.png'), await captureMapFrame(page))

  expect(errors, 'no page/console errors').toEqual([])
  expect(a.validation, 'no validation errors').toEqual([])
  // The fixture really does hold TWO paired icons, and both CAN draw. Without
  // this, arm B's 6 would be indistinguishable from a one-icon fixture.
  expect(a.iconVertexCount, `arm A icon vertexCount ${a.iconVertexCount} (2 quads = 12)`).toBe(12)
  expect(a.droppedPairCount, 'arm A: nothing collides, so nothing is dropped').toBe(0)

  // ── ARM B: blockers land on both anchors → both paired labels lose ──
  await seed(true)
  // PRECONDITION FIRST (§12: cause before effect). The blockers must actually
  // win, or a red icon count below would accuse the wrong half. Exactly one
  // pairKey is stamped: the PLAIN arm's. The optional arm's is deliberately not
  // stamped — that suppression is half the fix — so this number is 1, and a 2
  // here would mean the fix's cascade half never landed.
  const b = await settle((p) => p.ok && p.droppedPairCount >= 1, 'arm B: a pair was rejected')
  writeFileSync(test.info().outputPath('arm-b-blockers.png'), await captureMapFrame(page))

  expect(errors, 'no page/console errors').toEqual([])
  expect(b.validation, 'no validation errors').toEqual([])
  expect(
    b.droppedPairCount,
    `arm B droppedPairKeys ${b.droppedPairCount} — the plain arm only; 2 means the ` +
      `text-optional cascade suppression did not land, 0 means the blockers never won`,
  ).toBe(1)
  // Labels still drew — the blockers. A zero here would mean the frame is empty
  // and the icon count below is measuring nothing.
  expect(b.textVertexCount, 'arm B still draws the blocker labels').toBeGreaterThan(0)

  // THE ASSERTION. 0 = the bug, 12 = an over-broad fix that unpaired every
  // symbol, 6 = exactly one icon survived, which is the property.
  expect(
    b.iconVertexCount,
    `arm B icon vertexCount ${b.iconVertexCount} — 0 means both icons dropped (pre-#2440), ` +
      `12 means the drop cascade was suppressed for the PLAIN pair too`,
  ).toBe(6)
})
