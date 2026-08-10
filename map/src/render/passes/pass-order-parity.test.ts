// ═══ Pass-order parity — the authority builds exactly PASS_CHAIN_ORDER (#1004) ═══
//
// ONE orchestration now. This gate used to compare two: the pass-chain authority
// (buildRenderNodes → RenderNode[]) and the forced-WebGL2 linear twin, whose
// SOURCE order was scanned and required to equal PASS_CHAIN_ORDER minus a
// declared `RHI_TWIN_MISSING` set. The twin was deleted in #1046 Inc-F3a, so the
// comparison has no second side and both twin halves retired with it — along with
// the constant, which was NOT emptied: a `[]` would have left its own vacuity
// guard (`length < PASS_CHAIN_ORDER.length`) passing forever on a claim nothing
// could make any more.
//
// What survives is the constructive half, and it is the load-bearing one: the
// authority is built FROM PASS_CHAIN_ORDER and asserted against the frozen
// pre-#1004 literal plus its documented insertions, so a reorder or an undeclared
// insertion still cannot land silently.

import { describe, it, expect } from 'vitest'
import type { XGISMap } from '../../map'
import { buildRenderNodes } from './pass-chain'
import { PASS_CHAIN_ORDER, type PassLabel } from './pass-order'

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
})
