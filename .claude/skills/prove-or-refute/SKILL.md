---
name: prove-or-refute
description: >
  Adjudicate a CLAIM about code — a bug hypothesis, a suspected regression, "does
  this fix actually work", a finder's candidate, a reviewer's finding — by PROVING
  it real or false with a rigorous MATHEMATICAL argument (induction, proof-by-
  construction with a witness, invariant-violation, or exhaustive-case), NOT a
  single-shot empirical run or a confident static read. Use whenever the user
  demands inductive/mathematical/rigorous proof; when you have many candidates from
  a "generate freely" phase that need adversarial verification before acting; or
  whenever a plausible-but-unproven claim could waste a fix (or a refutation could
  hide a real bug). Honed in X-GIS: confident static traces were repeatedly WRONG
  and "I ran it once" proved nothing about untested inputs — only a construction /
  invariant / induction settled it. Pairs with visual-artifact-bisect (the real-GPU
  judge for claims that are inherently visual).
---

# Prove or refute — rigorous adjudication of code claims

A claim ("X is a bug", "this fix works", "Y is a regression") is worth NOTHING
until it is PROVEN. The two failure modes this skill kills:

1. **Confident static traces that are wrong.** A plausible code read ≠ proof.
2. **Single-shot empirical "proof".** A passing run says nothing about the inputs
   you didn't run. The 4-fixture SHA gate passed while a byte-exact extraction
   _could_ have drifted on a 5th input; only a differential/construction proof
   covers ALL inputs.

For every claim, output exactly one verdict — **CONFIRMED-REAL**, **REFUTED**, or
**NEEDS-PROBE** (genuinely undecidable statically, e.g. a pixel artifact → hand to
`visual-artifact-bisect`; a perf claim → measure) — each backed by the matching
artifact below.

## Q.E.D. discipline (mandatory form)

Present every verdict as a formal proof in the Q.E.D. tradition. No prose
hand-waving — a theorem, then a chain of justified steps, then the box.

1. **State the claim as a PROPOSITION**, quantified and precise. Confirm a bug ⇒
   prove the existential `∃ input I : output(I) = wrong O`. Refute a bug ⇒ prove
   the universal `∀ input : output is correct` (equivalently: the negation of the
   bug claim).
2. **PROOF.** Each step is justified by exactly one of: a file:line fact, an
   already-established lemma, a case split that is exhaustive, or an induction
   hypothesis. No step may rest on "probably" / "should" / "I ran it once". Use
   `Lemma:` for a reusable sub-fact, `Case i:` for branches, `Base/Step:` for
   induction.
3. **Terminate in `∎` (Q.E.D.).** The box is earned ONLY when every step is
   justified and nothing is assumed. If you cannot reach `∎` without a gap, the
   verdict is **NEEDS-PROBE**, not a confident guess — name the unproven step.
4. **Proof by counterexample is a complete disproof.** A claim of the form "no
   bug / always correct / the invariant holds" is refuted by ONE constructed
   witness that violates it — exhibit it, derive the violation, `∎`. Symmetrically,
   a single guard/precondition that makes the bug-witness unreachable disproves a
   "bug exists" claim. One counterexample ends the argument.
5. **Direct, contrapositive, or contradiction** are all admissible (e.g. "assume
   the OOB read occurs; then feat_id ∉ keys; but feat_id = array index ∈ keys by
   construction; contradiction ∎"). Pick the shortest sound route.

A proof that does not close with `∎` is not a proof — it is a hypothesis, and a
hypothesis does not change code.

## The proof bar (pick the technique that fits; rigor is non-negotiable)

- **Proof by construction (witness) — the workhorse.** Exhibit the EXACT input
  that triggers the defect, then DERIVE the wrong output by stepping the code's
  logic line by line (file:line), not by running it. The witness must be precise
  enough to drop straight into a fail-before test. Example (R8/R1): "fillPatternUV
  = [0.1,0.2,0.3,0.4]; render() packs uf[19]=v1=0.4 at :2295; the per-tile loop at
  :3534 unconditionally writes uf[19]=baseFillA=1.0; stageUniformSlot at :3737
  stages it AFTER → the GPU reads 1.0, not 0.4." That IS the test.

- **Induction.** Prove a property for ALL inputs of a class by induction on a
  count (holes / workers / glyphs / tiles / world-copies) or recursion depth.
  Example (R8/D2): "dispatch assigns job j to worker j mod N; `pending` has no
  job→worker inverse, so on worker-i error the handler cannot compute the preimage
  {j : j mod N == i} and rejects the whole domain. For N≥2 with ≥1 job on a worker
  ≠ i, that job is spuriously rejected. QED."

- **Invariant-violation.** Name the invariant the code/data maintains; show the
  claim either VIOLATES it (→ real) or is PRECLUDED by it (→ refuted). Example
  (R8/R3, refuted): "the MVT decoder ALWAYS builds a properties object keyed by
  array index, and feat_id == that index, so vertex feat_id ⊆ props keys by
  construction → the OOB read the claim needs is unreachable."

- **Exhaustive-case.** Enumerate every case (AST node kinds, all branches, all
  enum values) and show each is handled or safe. Example (R8/V4, refuted):
  "walkStrict has a case for every Expr kind that recurses into all sub-exprs, and
  the `default` returns false → null → full-props fallback; MatchBlock has only
  `arms` (subject is in the walked parent); MatchArm.pattern is a `string` not an
  Expr → no field read. Complete-or-safe by construction."

## Refute by contradiction (귀류법) — "assume the bug, derive ⊥"

The canonical way to prove a bug **cannot exist**. Logic first: an existence
claim `∃ I : bug(I)` is NOT disproved by a single no-bug example — you must prove
the universal `∀ I : correct(I)`, and the cleanest route is reductio: assume the
bug, reach a contradiction.

```
PROPOSITION:  ∃ I : code produces wrong output O on input I        (the bug)
PROOF (귀류 / by contradiction):
  1. Assume    such an I exists (the bug fires).
  2. Necessary condition: back out the condition C(I) that reaching the
     wrong branch REQUIRES (e.g. feat_id ∉ keys / asin-arg > 1 / two
     translucent fills overlap).
  3. Invariant: prove an Inv the code/data always maintains (file:line),
     with  Inv ⟹ ¬C   (the invariant forbids that necessary condition).
  4. Contradiction:  assumption ⟹ C(I);  Inv ⟹ ¬C(I);  so C ∧ ¬C  ⊥.
  5. Therefore  ∄ I : bug(I)  — the bug cannot exist.  ∎
VERDICT:   REFUTED
INVARIANT: Inv, and why it holds for ALL inputs.
```

**Where the "counterexample" really sits.** Not a counterexample to the bug
(impossible for an ∃-claim) — a counterexample to the bug's _necessary condition_
C: you try to construct an input where C holds, and the invariant makes it
unconstructible. By contrapositive, `Inv ⟹ ¬C  ≡  C ⟹ ¬Inv`; since Inv is always
true, C is never true.

**Worked (R8/R3, feat_data OOB miscolor):** Assume ∃ tile whose vertex feat_id is
absent from props → GPU reads feat_data[feat_id] OOB → fallback color (the bug).
Necessary C ≡ feat_id > max(props keys). Invariant: the MVT decoder ALWAYS builds
a properties object and the default resolver sets feat_id = the array index = that
very props key (mvt-decoder.ts:55-58), so ∀ vertex : feat_id ∈ keys ⟹ ¬C.
Assumption gives feat_id ∉ keys; invariant gives feat_id ∈ keys; ⊥. Bug cannot
exist. ∎ REFUTED.

**The adversarial step is non-optional — and it is where bugs hide.** Reductio is
only as sound as Inv. After step 5, ATTACK Inv: is it truly `∀`, or does some
input break it (a filter bypass, an edge value, a dynamic/data-driven path)? If
you construct an input that breaks Inv, then `¬Inv ⟹ C is reachable ⟹ the bug is
CONFIRMED` — the proof flips to a witness. So "prove the bug is impossible" and
"hunt the bug" are the same act: you refute by failing to break the invariant, and
you confirm the moment you break it.

## Method

1. **State the claim as falsifiable.** "Bug B occurs when input I, producing wrong
   output O." If it can't be stated this way, it isn't ready — sharpen it first.

2. **Pick the technique and BUILD the proof** (above). Ground every step in
   file:line of the ACTUAL current code (read it; line numbers drift).

3. **Be adversarial in BOTH directions.** After a CONFIRM, try your hardest to
   REFUTE it — find the precondition/invariant that makes the witness unreachable
   (a guard, an upstream filter, a single-caller fact, a `default` bail). After a
   REFUTE, try your hardest to BREAK the invariant — find the input that violates
   it. A claim survives only if it withstands the opposite attack.

4. **Confirmed ⇒ produce a WITNESS** precise enough to become a fail-before test
   (and then write that test: it must FAIL before the fix, PASS after, and assert
   the RIGHT thing — a test that only checks the already-true case is vacuous and
   proves nothing).

5. **Refuted ⇒ state the governing INVARIANT** and prove it holds (the reason the
   defect cannot occur).

6. **Confirmed ⇒ Realist Check the severity.** Worst realistic case, then the
   MITIGATIONS that bound it. Rigor catches inflation: R8/D4 looked like an
   unbounded OOM but a byte-blind 256-tile count cap bounds resident memory to ~2×
   → MAJOR, not CRITICAL. Also check **reachability**: a real defect with no
   production trigger is LATENT/test-only (R8/D1: real rAF leak, but no prod caller
   disposes the shared pool → latent).

7. **Correct the premise if the claim is sloppy.** A candidate can be real while
   its write-up is wrong (R8/D3 cited a non-existent symbol/wrong file; the bug was
   real, the cap just lived elsewhere). Fix the premise in the bug's favour, don't
   reject the bug.

## Output schema (per claim) — Q.E.D. form

```
PROPOSITION: the claim, quantified — ∃ input : wrong output   (confirm)
                                   |  ∀ input : correct        (refute)
PROOF:       <technique: construction | induction | invariant | exhaustive-case>
             justified steps (file:line / Lemma / Case i / Base+Step),
             no unjustified leaps, closing with  ∎ (Q.E.D.)
VERDICT:     CONFIRMED-REAL | REFUTED | NEEDS-PROBE(<real-GPU / measure / runtime>)
WITNESS:     (confirmed) exact input + derived wrong output, test-ready
INVARIANT:   (refuted) the precondition that precludes the defect, + why it holds
SEVERITY:    (confirmed) worst case + bounding mitigations (Realist Check) + reachability
```

If the PROOF cannot close with `∎`, the VERDICT is NEEDS-PROBE — never dress a
gap as a conclusion.

## Orchestration at scale (the R8 shape)

For a sweep of many claims: fan OUT (parallel read-only finders GENERATE
falsifiable candidates with file:line + a refutation path), then fan out again
(parallel adversarial refuters, ONE cluster each, apply this skill's bar). Finders
mass-generate; refuters prove-or-kill. This out-performs one confident pass — in
R8 it turned ~45 candidates into 8 confirmed (each fail-before-tested) + 7 refuted
(each with an invariant), and the rigor bar de-inflated 2 severities and corrected
2 premises. Keep finders and refuters as SEPARATE passes (a finder must not grade
its own candidate), and keep the author of a fix separate from its reviewer.

## Hard-won notes

- **"It compiles / a test passes" is not proof of correctness for all inputs.** A
  differential test (re-implement the original behaviour, assert deep-equality
  across constructed cases incl. edge branches) IS a constructive proof; a
  golden/empty-equals-empty assertion is vacuous.
- **Mock devices don't validate** binding sizes / alignment / OOB / lifecycle — a
  passing mock-unit test is invisible to that whole bug class. Derive the
  constraint from the emitted artifact (the WGSL struct, the buffer layout).
- **Static diagnosis of RENDER artifacts is unreliable here** — for an inherently
  visual claim the verdict is NEEDS-PROBE → `visual-artifact-bisect` (the pixels
  are the judge), not a static "proof".
- **CI conclusion ≠ watch exit code.** `gh run watch --exit-status` has returned 0
  on a flake-FAILED run; verify `gh pr checks` / `gh run view --json conclusion`
  before trusting green.
