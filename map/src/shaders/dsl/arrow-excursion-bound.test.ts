// ═══ An arrow never travels more than the distance to the next drawn one (#1546) ═══
//
// THIS REPLACES A RENDER GATE THAT HAD BEEN STRANDED. `playground/e2e/_s111-arrow-lattice-gate.spec`
// asserted the same property by measuring how much the painted mask decorrelated between two pinned
// clocks (`moved = xor / ink`), with an upper bound of 1.15 calibrated against `ARROW_SMEAR_SLOTS` —
// the excursion cap the per-cell generator used. #1520 step 2 deleted that generator AND its cap,
// and left the assertion behind. Measured, on the real WebGL2 render, at the commits either side:
//
//     8ec2b9d  before #1526 (per-cell generator + ARROW_SMEAR_SLOTS)   moved = 0.670   ← the
//     24a5b25  #1526, the screen lattice                              moved = 1.996     spec's
//     f541a5d  main, before the ground lattice                        moved = 1.997     own
//     bca19e9  main, ground-lattice enumeration (#1545)               moved = 1.770     baseline
//
// So the spec was red from the moment the mechanism it watched was removed, and nobody saw it
// because it was never added to CI's render-gate list. Its bound could not be re-tuned into meaning
// anything either: `moved` measures pixel-set decorrelation, and a dense field of 34 px glyphs each
// sliding ~17 px along its own streamline decorrelates almost completely no matter how well behaved
// the excursion is. The metric cannot distinguish the states of the thing it tests (§12), which is
// the definition of an assertion carrying no information.
//
// THE PROPERTY IS STILL WORTH HOLDING — it is what keeps the field a lattice instead of a Poisson
// scatter, and #1333 rejected moving glyphs over exactly the kind of jump it forbids. So it is
// asserted here on THE QUANTITY THE MECHANISM MOVES rather than on a pixel proxy downstream of it
// (§12 again): the arc length a glyph is placed at. No GPU needed, and it runs in CI, which the
// render spec never did.

import { describe, it, expect } from 'vitest'
import { emitArrowRetainedAdvectedWgsl } from './arrow-advected'
import { ARROW_TRAIN_GLYPHS, ARROW_TRAIN_TAPS_PER_SPACING } from './arrow-drift'
import { matchArc } from './_arrow-emit-nav'

const all = emitArrowRetainedAdvectedWgsl()
const vs = all.slice(all.indexOf('fn vs_arrow_retained_advected'))
const body = vs.slice(0, vs.indexOf('\n}'))
const letOf = (name: string): string => {
  const m = new RegExp(`(?:let|var) ${name}(?:: [^=]+)? = ([^;]+);`).exec(body)
  expect(m, `${name} must be bound in the emitted VS`).not.toBeNull()
  return m![1]!
}

describe('the excursion is bounded by the inter-glyph spacing, BY CONSTRUCTION (#1546)', () => {
  it('the arc length is AFFINE in the phase, with the spacing as its slope', () => {
    // `arc = (glyph + phase)·δ`. Affine in φ with slope exactly δ is the whole proof: as the clock
    // advances the phase by Δφ, every glyph moves Δφ·δ along its own streamline, so between any two
    // frames no glyph outruns one inter-glyph spacing — and at Δφ = 1 it lands exactly where its
    // neighbour was, which is the free wrap.
    //
    // A slope that is NOT δ is the failure: the predecessor's leash was an independent length, so
    // `phase·L` with `L > δ` let a glyph pass the next drawn one, and the field read as a clumped
    // scatter. That is the state `ARROW_SMEAR_SLOTS` capped, and it is unreachable now — there is
    // no second length to disagree with δ.
    // The emitter renumbers locals, so the arc is found by its SHAPE and then confirmed by what
    // its operands are made of — a test of the claim rather than of where a line happens to sit.
    // …and by shape ALONE, not by spelling: the optimizer may bind the sum to its own
    // name (gvn does, #1865), which is the same arithmetic with one more `let`.
    const m = matchArc(body)
    expect(m, 'the arc must be bound as (glyph + phase) · spacing').not.toBeUndefined()
    const { glyph, phase, spacing } = m!
    // …and the three operands have to BE those things, or the shape above proves nothing. The
    // first is the index WITHIN the train — `instance − seed·G` for `seed = floor(instance/G)` —
    // so it is bounded by G−1 and the arc is bounded by G·δ. An unreduced instance index here
    // would make the arc grow without bound across the draw.
    const g = new RegExp(`^\\((\\w+) - \\((\\w+) \\* ${ARROW_TRAIN_GLYPHS}\\.0\\)\\)$`).exec(
      letOf(glyph).trim(),
    )
    expect(
      g,
      `the first operand must be the within-train index, got: ${letOf(glyph)}`,
    ).not.toBeNull()
    expect(letOf(g![2]!), '…reduced by the seed, which is the instance over G').toMatch(
      new RegExp(`floor\\(\\(\\w+ / ${ARROW_TRAIN_GLYPHS}\\.0\\)\\)`),
    )
    expect(letOf(phase), 'the second is the wrapped phase').toContain('fract(')
    expect(letOf(spacing), 'the third is the inter-glyph spacing from the view block').toContain(
      '.ray_tl.w',
    )
  })

  it('the walk spends a BUDGET that starts at the arc and only decreases', () => {
    // The bound above is on where a glyph is ASKED to go; this is what stops the walk overshooting
    // it. `remain` starts at `arc`, each step takes `min(remain, h)`, and `remain` decreases by
    // exactly that — so the summed path length is ≤ arc, with the last step shortened to land on it
    // rather than past it. An unshortened final step would put the glyph up to `h` beyond its own
    // arc length, which is where a train starts overlapping the next.
    const arcName = matchArc(body)!.arc
    const budget = new RegExp(`var (\\w+): f32 = ${arcName};`).exec(body)
    expect(budget, 'the budget is a mutable that starts at the arc length').not.toBeNull()
    const rem = budget![1]!
    const steps = [...body.matchAll(new RegExp(`let (\\w+) = min\\(${rem}, (\\w+)\\);`, 'g'))]
    expect(steps.length, 'one capped step per integration tap').toBe(
      ARROW_TRAIN_GLYPHS * ARROW_TRAIN_TAPS_PER_SPACING,
    )
    const spends = [
      ...body.matchAll(new RegExp(`${rem} = max\\(\\(${rem} - (\\w+)\\), 0\\.0\\);`, 'g')),
    ]
    expect(spends.length, 'and each step is spent from the budget').toBe(steps.length)
    // …spending exactly what it took, so the budget cannot be underspent into an overshoot.
    expect(
      spends.map((x) => x[1]),
      'each spend is that step',
    ).toEqual(steps.map((x) => x[1]))
  })

  it('…and the arithmetic that follows: no glyph passes the next drawn one', () => {
    // The two structural facts above, played forward exhaustively over the states a frame can be
    // in. This is the claim the retired render spec was making, on the quantity that carries it.
    const D = 34 // δ, any positive value — the bound is a multiple of it
    const arcOf = (glyph: number, phase: number): number => (glyph + phase) * D
    let worst = 0
    for (let g = 0; g < ARROW_TRAIN_GLYPHS; g++) {
      for (let i = 0; i <= 200; i++) {
        for (let j = 0; j <= 200; j++) {
          worst = Math.max(worst, Math.abs(arcOf(g, i / 200) - arcOf(g, j / 200)))
        }
      }
    }
    expect(worst, 'the excursion over a whole cycle is exactly one spacing').toBeCloseTo(D, 9)

    // FAIL-BEFORE, and it is the rejected mechanism rather than a made-up one: an independent leash
    // length `L`. At `L = 3δ` — well inside what the per-cell generator's `ARROW_DRIFT_UV` allowed —
    // a glyph travels three spacings per cycle and passes the two drawn ahead of it.
    const leashed = (phase: number, L: number): number => phase * L
    expect(Math.abs(leashed(1, 3 * D) - leashed(0, 3 * D)), 'a leash breaches it').toBeGreaterThan(
      D,
    )
  })

  it('the wrap lands a glyph exactly where its neighbour was — the seam does not exist', () => {
    // The corollary that makes the bound tight rather than merely satisfied: at φ = 1 the set of
    // occupied arc lengths is the set at φ = 0 shifted by one index. If the bound held only loosely
    // the train would breathe, and #1333 rejected moving glyphs for exactly that.
    const at = (g: number, phase: number): number => g + phase
    for (let g = 0; g < ARROW_TRAIN_GLYPHS - 1; g++) {
      expect(at(g, 1)).toBeCloseTo(at(g + 1, 0), 12)
    }
  })
})
