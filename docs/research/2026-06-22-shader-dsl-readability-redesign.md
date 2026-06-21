# shader-dsl readability redesign (complex-code authoring)

**Date:** 2026-06-22
**Owner complaint:** "현재 DSL은 복잡한 코드는 읽기 너무 어려워집니다. TSL이나 다른 DSL 라이브러리를 참고."
**Inputs:** 5-DSL readability study (TSL · gpu.js/Shadeup/TypeGPU · tagged-template WGSL · Slang/WGSL baseline ·
builder-ergonomics) + synthesis + adversarial critic, adjudicated by prove-or-refute.

---

## Diagnosis — 3 readability killers (grounded in the actual builder)

1. **String-named locals** — `Builder.let(name, value)` (builder.ts:21) takes a `name: string`, so every local is
   written twice: the JS `const offM` the author reads + the `'off_m'` string the IR stores. Pure noise per line, can drift.
2. **`.add().mul().sub()` chains** — JS has no operator overloading (node.ts:72-87), so `(k+dk)*s + start` reads as
   `k.add(toF32(dk)).mul(s).add(start)`, left-to-right, precedence flattened. The worst anchor line:
   `arcOnSegK.lt(halfS.mul(-2)).or(arcOnSegK.gt(segLen.add(halfS.mul(2))))` for `arc < -2*half || arc > seg_len + 2*half`.
3. **Closure-nested control flow + a fresh `Builder` per level** — `subBody` (builder.ts:109) does `new Builder()` per
   if/for/switch body, so the callbacks each get their own builder param (`cb → d → cb2 → e`). **This caused a real,
   in-tree-documented bug** (line.ts:721-726): `cb.continue()` on the wrong builder put an unconditional `continue;`
   at the loop top → all pattern code dead, line patterns silently dropped. tsc can't catch it (all are `Builder`).

## Verdict (prove-or-refute adjudicated): SHIP C2 · CUT C1 · helpers for #2 · DROP the transpiler

| Change | Fixes | Byte-identity | Verdict |
|---|---|---|---|
| **C2 — ambient current-builder stack** | killer 3 + the bug | **YES** (same Stmt[] order; routing-only change) | **SHIP** |
| C1 — auto-named locals | killer 1 | **NO — breaks it** (proven) | **CUT** (optional later golden-rebake PR) |
| Named composite helpers (`madd`, `outsideRange`…) | killer 2 (the line that reads worst) | YES (just more builder calls) | **ADOPT** |
| Approach-1 TS→WGSL transpiler | all 3 | only if it byte-matches the builder's exact lift/promote quirks | **DROP** (multi-month trap) |

### Proof — C1 breaks byte-identity (∃, by construction)
`emit.ts:42` emits `be.localLet(s.name, …)` → the WGSL local identifier IS the literal `s.name`. The polygon snapshots
are content-hash-keyed full-WGSL goldens with **622 `.let` names baked in verbatim**. Witness: `cb.let('off_m', e)`
emits `let off_m = …`; C1 auto-naming emits `let _v37 = …`. `off_m ≠ _v37` ⇒ golden mismatch ⇒ guard RED. ∎
The proposal's "choose deterministic auto-names that match" is a non-solution (it cannot reverse-engineer `off_m`).
C1 is therefore either INERT (keep the name → removes nothing) or a deliberate **golden-rebake PR** vouched by the GPU
differential (names don't affect semantics) — NOT a byte-identity-safe change. Its gain is the smallest (one string/line),
its cost the highest (loses debug-name fidelity — reading 25KB goldens during render-bug bisect is the dominant debugging
activity here). → CUT now; revisit as an explicit rebake PR only if wanted.

### Proof — C2 is byte-identical (∀, 귀류법)
Assume C2 changes the emit. Emit is a pure function of the Stmt[] tree. C2 changes only the statement SINK (an ambient
push/pop stack vs a passed `Builder` param) — the same `b.let`/`If`/`assign` calls in the author's closure push the same
statements in the same order to the innermost pushed scope, exactly as the passed builder did. So Stmt[] is identical ⇒
emit identical ⇒ contradiction. ∎ Caveat (the one new invariant): the push/pop must be **exception-safe (try/finally)**
so an authoring-time throw mid-`If` body cannot leak the stack into the next shader.

## Before / after — the anchor (line.ts:704-727), C2 only

**BEFORE** — `cb`/`d`/`cb2`/`e` proliferation, string names:
```ts
cb.if(anchor.eq(u32(0)), (d) => {
  const kCenter = d.let('k_center', floor(arcPos.sub(startM).div(spacingM).add(0.5)))
  d.forRange('dk', i32(-1), (idk) => idk.le(i32(1)), (cb2, dk) => {
    const arcOnSegK = cb2.let('arc_on_seg_k', /* … */)
    cb2.if(arcOnSegK.lt(halfS.mul(-2)).or(arcOnSegK.gt(segLen.add(halfS.mul(2)))), (e) => { e.continue() })
    cb2.assign(patDm, min(patDm, /* … */))
  })
  d.continue()
})
```
**AFTER** — ambient `b`; `If`/`Loop`/`Continue`/`assign` are free functions over the current scope; no builder params:
```ts
If(anchor.eq(u32(0)), () => {
  const kCenter = b.let('k_center', floor(arcPos.sub(startM).div(spacingM).add(0.5)))
  Loop(i32(-1), (dk) => dk.le(i32(1)), () => {
    const arcOnSegK = b.let('arc_on_seg_k', /* … */)
    If(arcOnSegK.lt(halfS.mul(-2)).or(arcOnSegK.gt(segLen.add(halfS.mul(2)))), () => Continue())
    assign(patDm, min(patDm, /* … */))
  })
  Continue()
})
```
Gone: every `cb`/`d`/`cb2`/`e` param; `Continue()` unambiguously targets the innermost loop — the line.ts:721-726 bug is
**unrepresentable** (no second builder to address). String names kept (C1 cut) so the emit stays byte-identical. The
arithmetic chains remain — addressed by composite helpers (`outsideRange(arc, -2*half, segLen + 2*half)`), not a transpiler.

## Migration — additive, byte-identity-guarded (no big-bang)
1. Land C2 in builder.ts ADDITIVELY (ambient stack + free `If`/`Loop`/`Continue`/`Break`/`assign`); keep the old
   `cb.let('name',…)` + `(b)=>…` callbacks working (both push the same Stmt[]). Exception-safe push/pop + a test that a
   throw mid-`If` leaves the stack clean. **Byte-identity guard stays green (no shader changed yet).**
2. Migrate ONE fn (the line.ts anchor) as the canary → byte-identity green + GPU differential green.
3. Roll the remaining shaders fn-by-fn, each guarded. Old + new APIs coexist (additive).
4. Remove the old passed-Builder callbacks after all migrate (a committed final cleanup, not "opportunistic" — else two
   APIs live forever = a readability regression). Surface: 622 `.let`, 170 `.if`, 13 `.forRange`, 4 `.switch`.
5. Composite arithmetic helpers (`madd`, `outsideRange`, …) added as pure builder calls — byte-stable, no parser.

**Exit proof for C2:** polygon-variant-diff byte-equal (emit unchanged) + the shadowing-bug-unrepresentable +
exception-safe-stack test. NOT in scope: C1 auto-naming, the transpiler.
