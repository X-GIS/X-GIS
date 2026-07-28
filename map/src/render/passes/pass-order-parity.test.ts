// ═══ Pass-order parity — both orchestrations answer to PASS_CHAIN_ORDER (#1004) ═══
//
// The full-frame pass sequence executes on TWO paths: the native pass-chain
// (buildRenderNodes → RenderNode[], the WebGPU authority) and the forced-WebGL2
// linear twin (render-loop.ts renderFrameViaRhi — LIVE: every frame on the
// webgl2 backend runs it). The twin's comments enumerate real past divergence
// bugs (vanishing point labels, missing strokes, double-paint). This gate makes
// order drift impossible to land silently:
//
//   1. the authority builds CONSTRUCTIVELY from PASS_CHAIN_ORDER (asserted
//      against the frozen pre-#1004 literal, so the rewire itself is proven
//      byte-order-identical);
//   2. the twin's SOURCE order is scanned (renderFrameViaRhi is a straight-line
//      method — each stage appears once, so source order IS execution order)
//      and must equal PASS_CHAIN_ORDER minus the documented RHI_TWIN_MISSING
//      set — the "twin = authority − declared-missing" identity. Reordering
//      either path fails; adding a pass without declaring its twin status
//      fails; porting a missing pass fails until RHI_TWIN_MISSING shrinks in
//      the same commit (locks the win).
//
// The full behavioral unification (running the RenderNode chain over RHI
// passes) is EPIC #991 P4/P5 and needs real-GPU verification — when it lands,
// RHI_TWIN_MISSING goes to [] and this gate's twin half retires with the twin.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { XGISMap } from '../../map'
import { buildRenderNodes } from './pass-chain'
import { PASS_CHAIN_ORDER, RHI_TWIN_MISSING, type PassLabel } from './pass-order'

// The pre-#1004 hand-written order, frozen VERBATIM — proves the constructive rewire
// reproduced the shipped sequence byte-for-byte. NEVER edit this list. A pass added later is
// NOT an edit to it: it is an entry in DOCUMENTED_INSERTIONS below, which is what keeps this
// literal a real witness. (Editing it in place is how the protection dies quietly — the list
// then merely restates whatever PASS_CHAIN_ORDER currently says, and the two agree by
// construction rather than by evidence. `hillshade` was inlined that way once; it is a
// declared insertion again here.)
const FROZEN_PRE_1004_ORDER = [
  'background',
  'opaque',
  'oit',
  'translucent',
  'points',
  'labels',
  'heatmap',
  'overdraw-compose',
  'graphics',
]

/** Passes inserted AFTER the freeze, each with the pass it was inserted immediately BEFORE.
 *  Deleting FROZEN_PRE_1004_ORDER's protection is now a visible act: a reorder of the frozen
 *  spine fails, an undeclared new pass fails, and an insertion that lands somewhere other than
 *  where it says it lands fails. A subset check would have caught none of the three. */
const DOCUMENTED_INSERTIONS: ReadonlyArray<{ label: PassLabel; before: PassLabel; why: string }> = [
  {
    label: 'hillshade',
    before: 'points',
    why: '#777 Phase II — relief over fills, under labels (design §4); real-GPU A/B verified (INC-6), and inert on every scene with no raster-dem layer',
  },
  {
    label: 'flow',
    before: 'opaque',
    why: '#1333 — IBFV advection is a PRODUCER; the coverage drape consumes it inside opaque, so a later slot would drape last frame’s field',
  },
  {
    label: 'scene-upscale',
    before: 'labels',
    why: '#1429 INC-2 — the scene→screen seam: it must run after every scene-attachment writer and before the first native-screen writer (labels), so the overlay composites onto the upscaled scene at native resolution',
  },
]

describe('pass-order parity: one authority, two orchestrations (#1004)', () => {
  it('authority: buildRenderNodes emits exactly PASS_CHAIN_ORDER', () => {
    // Safe without a real map: nodes only dereference map members at render
    // time (pass-chain.ts contract) — building the list is pure.
    const labels = buildRenderNodes({} as XGISMap).map((n) => n.label)
    expect(labels).toEqual([...PASS_CHAIN_ORDER])
  })

  it('authority: PASS_CHAIN_ORDER === the frozen literal + exactly the DECLARED insertions', () => {
    // Remove the declared insertions and what remains must be the pre-#1004 sequence,
    // element-for-element. Reordering the spine fails; adding a pass without declaring it
    // fails (it survives the filter and lands in the wrong place); deleting one fails too.
    const inserted = new Set<string>(DOCUMENTED_INSERTIONS.map((i) => i.label))
    expect(PASS_CHAIN_ORDER.filter((l) => !inserted.has(l))).toEqual(FROZEN_PRE_1004_ORDER)
  })

  it('authority: each documented insertion sits exactly where it says it sits', () => {
    // The label alone is not the claim — the POSITION is, and it is the part that changes
    // behaviour. flow before opaque is the producer/consumer order; hillshade before points
    // is the relief-under-labels order. Either drifting is a render bug this catches.
    for (const { label, before, why } of DOCUMENTED_INSERTIONS) {
      const at = PASS_CHAIN_ORDER.indexOf(label)
      const anchor = PASS_CHAIN_ORDER.indexOf(before)
      expect(at, `'${label}' is not in PASS_CHAIN_ORDER — stale declaration`).toBeGreaterThan(-1)
      expect(
        anchor,
        `'${before}' (anchor for '${label}') is not in PASS_CHAIN_ORDER`,
      ).toBeGreaterThan(-1)
      expect(at, `'${label}' must run immediately before '${before}': ${why}`).toBe(anchor - 1)
    }
  })

  it('twin: renderFrameViaRhi source order === PASS_CHAIN_ORDER − RHI_TWIN_MISSING', () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'render-loop.ts'),
      'utf8',
    )
    // Slice the twin's body: from its declaration to the next private member.
    // Slicing FIRST keeps look-alike call sites outside the twin (e.g. the
    // pick pass's renderFillsRhi at ~:805) out of the scan.
    const start = src.indexOf('private renderFrameViaRhi(')
    expect(
      start,
      'renderFrameViaRhi not found — the twin was renamed/removed; retire or repoint this gate',
    ).toBeGreaterThan(-1)
    const rest = src.slice(start + 1)
    const end = rest.search(/\n {2}private /)
    expect(end, 'could not find the end of renderFrameViaRhi').toBeGreaterThan(-1)
    const body = rest
      .slice(0, end)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')

    // One load-bearing marker per twin stage, in the label vocabulary of the
    // authority. Raster (rasterRenderer.render/renderRhiChecker) is opaque's
    // synthetic first sub-pass (opaque-pass.ts) — renderFillsRhi marks opaque.
    const MARKERS: ReadonlyArray<readonly [PassLabel, string]> = [
      ['background', 'backgroundClearValue('],
      // #1333 — the advection step, PORTED to the twin (not deferred): the coverage draw it
      // feeds already runs here, so a twin without it would render a different map.
      ['flow', 'flowRenderer?.step('],
      ['opaque', 'renderFillsRhi('],
      ['translucent', 'beginTranslucentPassRhi('],
      // #777 Phase II — hillshade ported to the twin (after translucent, before
      // labels); applyHillshadePaint marks the block that precedes the render.
      ['hillshade', 'applyHillshadePaint('],
      ['points', 'pointRenderer.renderRhi('],
      ['labels', 'labelPass.execute('],
      ['heatmap', 'heatmapRenderer.renderRhi('],
      ['graphics', 'graphics.renderRetained('],
    ]

    // Vacuity guard: every marker must exist in the twin body (a rename fails
    // loudly here instead of silently emptying the scan — the #996 lesson).
    const found = MARKERS.map(([label, marker]) => {
      const idx = body.indexOf(marker)
      expect(
        idx,
        `marker '${marker}' (${label}) not found in renderFrameViaRhi — renamed? repoint this gate`,
      ).toBeGreaterThan(-1)
      return { label, idx }
    })

    // Straight-line method ⇒ source order is execution order.
    for (let i = 1; i < found.length; i++) {
      expect(
        found[i]!.idx,
        `twin stage order drifted: '${found[i]!.label}' appears before '${found[i - 1]!.label}'`,
      ).toBeGreaterThan(found[i - 1]!.idx)
    }

    // The identity: twin sequence === authority minus the declared-missing set.
    const expected = PASS_CHAIN_ORDER.filter((l) => !RHI_TWIN_MISSING.includes(l))
    expect(
      found.map((f) => f.label),
      'twin ≠ authority − RHI_TWIN_MISSING: either a pass was ported (shrink ' +
        'RHI_TWIN_MISSING in this commit — lock the win) or a new pass was added ' +
        'without declaring its twin status in pass-order.ts',
    ).toEqual(expected)
  })

  it('RHI_TWIN_MISSING is a subset of the authority (no phantom entries — vacuity guard)', () => {
    for (const l of RHI_TWIN_MISSING) {
      expect(
        (PASS_CHAIN_ORDER as readonly string[]).includes(l),
        `RHI_TWIN_MISSING entry '${l}' is not in PASS_CHAIN_ORDER — stale; delete it`,
      ).toBe(true)
    }
    // And it must stay a strict subset — an empty twin would make the parity vacuous.
    expect(RHI_TWIN_MISSING.length).toBeLessThan(PASS_CHAIN_ORDER.length)
  })
})
