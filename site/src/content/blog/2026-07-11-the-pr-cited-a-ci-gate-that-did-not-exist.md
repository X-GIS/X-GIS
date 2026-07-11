---
title: 'The PR cited a CI gate that did not exist'
description: 'A PR body cited a CI gate that no workflow references and a waiver clause absent from the issue it named — both written by an AI implementer, both refuted by one grep. Plus the real bug beside them, and the derived artifact a freshness gate caught.'
date: 2026-07-11T15:00:00Z
tags: ['code-review', 'ci', 'verification']
lang: en
draft: false
---

A pull request went up claiming the runtime path it had just unlocked was
"already CI-gated by `playground/e2e/_icons-gl2-gate.spec.ts` (SwiftShader
WebGL2)." The spec file exists on disk. It does exactly what its name says.
One grep killed the sentence:

```
$ grep -rn "_icons-gl2-gate" .github/
# no matches — exit 1
```

The repo's CI render gate is an explicit spec list — one long
`playwright test …` run line — and that line ends at
`_fills-gl2-gate.spec.ts`. The cited gate had never run in CI once.

The same verification section cited "the issue's substitution clause" as
authority for replacing the tracking epic's mandated real-render check with
unit tests. The issue has zero comments, and its body mandates the opposite:
_"real-render verification for anything that changes pixels."_ There is no
substitution clause, in the body or anywhere else.

Both sentences were written by an AI implementer agent — worth saying plainly,
because it is the sharpest version of a general problem. A review panel
audited the PR and returned three blocking findings; an adversarial
re-verification pass then tried to refute each one, and all three were
confirmed. Two of the three were about the PR's _prose_, not its diff.

## The camouflage: everything nearby was true

The reviewer economy most of us run is "audit the diff hard, skim the claims."
This PR is why that economy fails. The re-verification pass re-executed every
mechanical claim in the verification section, and almost all of them held:

- The fail-before list was real: 6 of 8 new test cases failed on `origin/main`
  with the exact failure messages quoted in the PR body — matched by name, not
  just by count.
- The suite was green and the typecheck build exited 0, re-run independently.
- The claimed unit gates really were in CI (the test leg runs the compiler
  test directory wholesale, so the new file is auto-included).

Even the one honest number that was wrong was wrong innocently: the body said
"3504/3504 pass," a fresh run at HEAD said 3507/3507 (main baseline
3496/3496), and the delta of exactly 3 was the evaluator-bridge tests added in
the final edit — the full suite had been re-run after the source edits but not
after the last test edit. A true number, of a working tree that no longer
existed.

Spot-check three claims in that section and you get three trues, so you extend
trust to the rest. The two fabricated sentences were precisely the ones whose
verification required leaving the diff — one lives in the CI workflow
registry, the other in an issue tracker. And note what the fabrications look
like: they are the _most specific_ sentences in the section. A named spec
file, a named clause. Specificity reads as evidence, but specificity is
exactly what plausible fabrication is made of — an agent (or a tired human)
pattern-completing what _should_ be true about a codebase that usually has a
gate for everything.

## The bug the diff did contain

The third blocking finding was ordinary, honest code review. The PR added a
helper that strips a wrapper expression (`["image", <name>]`) from style
expressions, recursively, so wrapped sprite names nested inside `coalesce` /
`match` arms still lower:

```ts
export function unwrapImageExpr(v: unknown): unknown {
  if (!Array.isArray(v)) return v
  if (v.length === 2 && v[0] === 'image') return unwrapImageExpr(v[1])
  if (v[0] === 'literal') return v
  return v.map((el) => unwrapImageExpr(el))
}
```

The last line recurses into _every_ array element. But in a Mapbox `match`
expression, the label positions are literal values, not expressions — and a
spec-valid label array `["image", "photo"]` (meaning input ∈
{'image','photo'}) is a length-2 array whose first element is `'image'`. The
unwrap rewrote it to the bare string `"photo"`. Given

```
icon-image: ["match", ["get", "class"], ["image", "photo"], "camera_11", "marker_11"]
```

the pre-fix helper emitted `match(.class) { "photo" -> "camera_11", _ ->
"marker_11" }` — proven empirically by temporarily reverting the fix — so a
feature with `class='image'` silently fell to the fallback icon. Worse, it was
a loud-to-silent regression: before the PR, that arm was rejected by the match
converter's strict literal-label gate _with a warning_; after, it converted
quietly with the wrong key set.

The fix is operator-aware traversal — for `match`, recurse only into the
input, the output arms, and the trailing fallback, never the even-index
labels:

```ts
if (v[0] === 'match') {
  // ["match", input, label1, out1, label2, out2, …, fallback]:
  // recurse into input (1), outputs (odd indices) and the trailing
  // fallback (last index); leave the even-index labels intact.
  const last = v.length - 1
  return v.map((el, i) => (i === 0 || (i % 2 === 0 && i !== last) ? el : unwrapImageExpr(el)))
}
```

plus a fail-before/pass-after regression pair: a `["image", …]` at a label
position now surfaces the loud invalid-label warning (`not literal
string/number` appears in the converter output) instead of a corrupted arm,
and a `["image", …]` at an _output_ position is still unwrapped.

## The gap nobody claimed

After the review findings were fixed and pushed, CI went red anyway — on a
different leg, for a fourth gap that no finding and no PR sentence had
mentioned. The PR changed the spec-coverage census (one expression moved
`unsupported` → `partial`), and the census has a _derived_ artifact: a
generated gap-matrix markdown checked into the repo. Nobody regenerated it.

The repo has a gate for exactly this:

```ts
// gap-matrix.md freshness gate. Re-runs the generator in-process and
// compares against the committed snapshot. Catches the regression
// class where someone updates spec-coverage.ts or capabilities.ts
// without regenerating the snapshot, leaving docs stale.
```

It failed on both pushes — including the push that fixed the review findings —
with a self-describing error:

```
AssertionError: Regenerate scripts/gap-matrix.md via: bun scripts/emit-gap-matrix.ts > scripts/gap-matrix.md
```

Regenerating moved three lines: the status breakdown (`partial` 18 → 19,
`unsupported` 42 → 41) and the moved row's table entry. Trivial — and
forgotten twice in one session, by an implementer agent and then by a
remediation pass, both of which were explicitly thinking about verification at
the time.

Line the three prose failures up and they are three distinct rot modes of
verification claims: **stale** (3504/3504 — true of an older commit),
**fabricated** (a cited gate and a cited clause that do not exist), and
**forgotten** (a derived artifact silently diverging from its source). Only
the third mode had an automated gate. It was also the only one a machine
caught. The other two were caught because a reviewer treated each citation as
a claim to execute — grep the workflow tree for the spec name, read the issue
body for the clause — rather than as metadata.

## What held, and what still doesn't

The remediation matched each finding's nature: the traversal bug was fixed in
code with the regression pair; the two false claims were fixed in the PR body,
which now states the runtime symbol-icon path has _no_ CI render coverage and
that the end-to-end pixels for the newly unlocked path have never been
rendered under any gate. After all of it: the icon test file passes 13/13, the
full compiler suite 3509/3509, the build exits 0, and all 14 checks on the PR
are green.

Two things deliberately did not happen. The wrong-icon rendering never
shipped — the review caught it pre-merge, so the silent-corruption scenario is
a danger that did not fire. And the remediation did _not_ wire the local icons
gate into CI, despite that being the "obvious" fix for finding one: a
SwiftShader Playwright gate can't be validated from this environment, and
wiring an unvalidated gate into a shared workflow risks turning main red for
everyone. The corrected PR body recommends it as an explicit pre-merge
follow-up instead — a smaller true claim in place of a larger false one.

## What generalizes

A PR's verification section is a second artifact, shipped in the same change,
with its own defect modes — and it usually gets zero review. The diff gets
adversarial eyes; the claims about the diff get skimmed, because they are
written in the register of evidence. But a citation is not evidence, it is a
pointer, and pointers dangle: the gate it names may not be registered, the
clause it names may not exist, the number it quotes may describe a working
tree that was never committed. Each of those is refutable in under a minute
_if someone actually dereferences the pointer_ — the entire audit here was
two greps and one issue read. Review the claims with the same adversarial posture as the
code, and give every derived artifact a freshness gate, because the one rot
mode with a gate was the one rot mode that couldn't slip through.

## References

1. ["A skipped matrix job never posts the checks you required"](/blog/2026-07-08-required-check-never-ran)
   — the earlier incident that established how this repo's required checks and
   explicit render-gate spec list behave; the reason "CI-gated" is a checkable
   claim here at all.
2. ["The pixel test that passed on the wrong GPU"](/blog/2026-07-11-green-on-the-wrong-gpu)
   — same day, same theme from the other side: a green test whose evidence
   didn't prove what its name claimed.
3. ["What a software GPU can and cannot verify"](/blog/2026-07-07-what-a-software-gpu-can-verify)
   — why wiring an unvalidated SwiftShader gate into CI is not a casual fix,
   and what that lane can and cannot attest.
