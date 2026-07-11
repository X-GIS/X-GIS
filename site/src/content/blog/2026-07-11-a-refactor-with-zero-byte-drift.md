---
title: 'The mathematically wrong constant survived a single-authority refactor on purpose'
description: 'Routing Earth constants out of GPU shader source through one planetary Body authority, under a hard bar: emitted bytes must not change. Goldens captured from pre-change code, a literal ratchet, a 211-hit census — and a "wrong" eccentricity kept on purpose.'
date: '2026-07-11T14:30:00Z'
tags: ['refactoring', 'verification', 'gpu']
lang: en
draft: false
---

Earth's first eccentricity squared has two values in our engine. The CPU
derives it from the WGS84 flattening — $e^2 = f(2-f)$ with
$f = 1/298.257223563$ — giving `0.0066943799901413165`. The GPU shaders carry
a literal: `0.0066943799901975955`. The two agree through the eleventh
significant digit, then diverge; both round to the same f32; and every
emitted shader that does ellipsoid math has only ever been compiled with the
second one.

This session's refactor routed that literal — and the rest of the
`6378137`-family Earth constants sitting in GPU shader constant
declarations — through a single planetary `Body` authority, so a Moon or Mars
globe can inject its own radius and eccentricity. The bar we set was harsher
than "renders the same": the emitted WGSL and GLSL must be **byte-identical**
to what shipped. That bar is what forced the interesting call. Where the
authority and the shipped shader disagreed about $e^2$, the authority lost.

## The migration the repo itself prescribed

A single-authority gate already existed — an "earth-literal ratchet" that
scans every non-test source file, comments stripped, for
`/6378137|40075016|298\.257223563|0\.00669437/` and fails CI when a literal
appears outside a three-file allowlist. Its own comment described this
refactor's endgame:

```ts
// GPU-side ConstDecls (wgslValue/cpuValue pairs). P1 is zero-GPU-edits;
// routing these through EARTH is P3 (#798) — delete on migration.
```

"Delete on migration": replace the shader literals with imports from the
authority, shrink the allowlist. That is the move every single-authority
playbook prescribes, and here it is wrong. This is the declaration it would
delete:

```ts
export const ECEF_CONSTS: ConstDecl[] = [
  { name: 'WGS84_A', type: f32T, wgslValue: 6378137.0, cpuValue: 6378137.0 },
  {
    name: 'WGS84_E2',
    type: f32T,
    wgslValue: 0.0066943799901975955,
    cpuValue: 0.0066943799901975955,
  },
]
```

Deriving `WGS84_E2` from the authority rewrites the emitted shader text from
`0.006694379990197595` to `0.0066943799901413165`. Review verified that both
values round to the same f32 — not one pixel would move — and that is exactly
what makes the drift insidious: no render test on any backend would ever
catch it, and the "nothing changed" claim would silently become false. Worse,
once you accept "harmless" byte drift, proving the harmlessness becomes your
job — per constant, per backend, per driver, with a real-GPU pixel-diff
campaign. Byte-identity is cheaper and total: identical compiler input is
identical output, with nothing to run. The import would also have coupled the
deliberately body-blind shader modules to the geodesy package.

Nobody wrote the import version and reverted it; the golden that forbids it
was captured before the seam existed, so the collision was visible before the
first edit. But the stale comment is now a hazard rather than a plan: two
reviewers independently flagged that a future contributor reading "delete on
migration" would "complete" the migration and break the byte goldens. That
danger has not fired; correcting the comment is a follow-up.

## Mutate at a seam instead of importing

What shipped instead: the shader modules keep their literals as shipped
defaults, and a small seam at the integration layer overwrites the constant
_values_ from the active body at map construction, before the first shader
emit:

```ts
export function configureBodyConsts(body: Body): void {
  if (body === EARTH) {
    setConst(EARTH_R_C, EARTH_EARTH_R)
    setConst(WGS84_A_C, EARTH_WGS84_A)
    setConst(WGS84_E2_C, EARTH_WGS84_E2)
    return
  }
  setConst(EARTH_R_C, body.sphereR)
  setConst(WGS84_A_C, body.a)
  setConst(WGS84_E2_C, body.e2)
}
```

Two details carry the design. The Earth branch restores values captured from
the shipped declarations at module load — never re-spelled:

```ts
const EARTH_EARTH_R = EARTH_R_C.wgslValue
const EARTH_WGS84_A = WGS84_A_C.wgslValue
const EARTH_WGS84_E2 = WGS84_E2_C.wgslValue
```

so the ratchet's invariant — only the authority file and the two shader files
spell the numbers — holds without adding an allowlist entry. And the
`=== EARTH` identity guard is what preserves the divergence: for Earth, the
seam restores the shipped GPU literal verbatim instead of assigning
`body.e2`, which would be the correct value and the wrong bytes.

## Capture the baseline from the world before the change

The procedural core of the whole PR is one ordering decision. Before the seam
existed, a throwaway test ran against `origin/main` and recorded what the
constant emitter actually printed. That output became the committed golden:

```ts
// ── Goldens captured from origin/main (pre-seam) emitConst output. ──
const GOLDEN_ECEF = 'const WGS84_A: f32 = 6378137.0;\nconst WGS84_E2: f32 = 0.006694379990197595;'
```

The shipped test asserts two things against it: the unconfigured default emit
equals the golden, and `configureBodyConsts(EARTH)` restores the golden after
a Mars perturbation. Written test-first, it failed for the honest reason
before the seam existed:

```
FAIL map/src/body-consts.test.ts
Error: Cannot find module './body-consts' imported from '.../map/src/body-consts.test.ts'
 Test Files  1 failed (1)
      Tests  no tests
```

Why capture from `origin/main` at all, instead of from the new tree once the
work compiles? Because a golden captured _after_ the change can only prove
the new world agrees with itself. If the refactor had subtly altered the emit
path, a post-change snapshot would have faithfully enshrined the regression
and gone green. One reviewer pushed back on this framing, correctly: in this
particular diff the two shader files were never touched, so the pre-change
golden trivially equals the shipped defaults — the capture order proved the
procedure more than this diff. The order matters the moment a diff does touch
the emit path, which is precisely when you can no longer tell.

One thing did fire while committing the golden: ESLint's
`no-loss-of-precision` rejected the constant as spelled in the source file —
`0.0066943799901975955` carries a final digit below f64 precision. The golden
pins the canonical spelling `0.006694379990197595`, the identical double,
which is also what the emitter prints into WGSL. Even copying a shipped
constant "verbatim" has a spelling question in it.

## The proof stack

Byte-identity was one gate among four, each covering a hole the others leave:

1. **Byte-identity on the seam** — the golden test above, 6/6, including
   "restore after Mars" and "$e^2$ divergence preserved
   (`e2 !== EARTH.e2`)".
2. **Emit-snapshot invariance on whole modules** — 19/19 full-module WGSL
   emits byte-equal against committed `.wgsl` snapshots, plus a
   CPU-oracle/WGSL/GLSL three-way consistency test. The snapshots themselves
   contain `const EARTH_R: f32 = 6378137.0;` — emitted _output_ that must
   keep the literal, and therefore shows up in any naive grep as eight
   "violations".
3. **The ratchet** — 3/3, allowlist unchanged at exactly three files, with a
   shrink-only rule: a stale allowlist entry is itself a failure.
4. **An exhaustive census** — `git grep -nE "6378137|40075016|20037508"`
   returned 211 hits, every one classified: 6 in the authority, 2 shader
   defaults, 8 comment-only survivors next to code that already reads the
   authority, 8 emitted-WGSL goldens, 4 in the new test, 46 test fixtures
   that re-derive expected values from first principles (importing the value
   under test would be circular), 119 in ratchet-exempt workspaces, 2 in a
   render-verify oracle that deliberately perturbs the world circumference by
   ×1.01 to prove the pixel gate catches a projection-constant perturbation, 6
   in docs, 10 in tooling. Zero unexplained.

The census and the ratchet are not redundant. The census is a one-time proof
of full coverage — a grep is only evidence when every hit is classified, not
counted. The ratchet is the standing gate that keeps the census true next
month, mechanically, without anyone re-running it.

The full suite came back 7718 passed, 3 skipped, with two failures — both
isolated as pre-existing rather than assumed away: a property test that timed
out under parallel-agent host contention (two `[vitest-worker]: Timeout
calling "onTaskUpdate"` RPC timeouts in the log; 15/15 in isolation, the
offending case in 13 s), and a diagnostics test that fails identically on the
clean tree. Neither file is touched or imported by the change.

## What we did not verify

No headed real-GPU pixel diff was run, deliberately. For the Earth path,
byte-identical shader source is the stronger claim — a pixel diff would test
a consequence of a fact already proven at the source level. The non-Earth
injection, though, is verified only at the values-and-emit level: Mars
injects `3396190`, the Moon injects `1737400` with $e^2 = 0$, and nothing was
rendered. A Moon globe today would draw at the correct scale but framed by an
Earth-tuned camera, because the CPU camera path still reads a fixed Earth
radius — which is why the user-facing "body" constructor option was
deliberately not exposed. Shipping the knob would advertise a render the
camera mis-frames.

One more danger that did not fire but was caught in review: `=== EARTH` is
reference identity. In a context that loads two copies of the shared package,
the active body can be the _other_ copy's `EARTH` object, the guard misses,
and the seam assigns the derived $e^2$ — same f32, zero pixel change, but
every emit byte-gate in that context goes red. A structural
equality check is the suggested fix, queued behind the comment correction.

## What generalizes

For a refactor whose contract is "nothing changes," the test is only as
honest as the world its baseline came from — capture it from the code before
the change, or you are testing the new world against itself. And a constant
that has shipped is an interface, not a math problem: the derived $e^2$ here
is better geodesy and worse engineering, because the only observable thing it
buys is a diff. Byte-identity beat mathematical purity, and it was the right
call both times it came up.

## References

1. ["The split constant was never the bug"](/blog/2026-07-08-the-split-constant-was-never-the-bug)
   — the same lesson approached from the other side: a shipped magic constant
   that looks wrong and turns out to be load-bearing.
2. ["The boundary audit missed an edge because a regex ate a digit"](/blog/2026-07-10-the-audit-grep-that-ate-a-digit)
   — why a census grep is only trustworthy when a machine-checked gate is
   built from it, not when a human reads the hit list.
