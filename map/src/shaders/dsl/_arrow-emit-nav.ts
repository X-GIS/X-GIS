// ═══ Navigating the emitted arrow VS by SHAPE (test support, #1865) ═══
//
// Three arrow specs assert an invariant by finding its ARITHMETIC in the emitted
// WGSL — the arc length is `(glyph + phase)·spacing` (arrow-excursion-bound,
// arrow-retained-dsl), the drawn direction is the basis applied to a sampled flow
// (arrow-drift-direction). Picking the claim out by what it is MADE OF, rather
// than by where a line sits, is deliberate and is why those specs survive edits.
//
// What they must NOT depend on is how many `let`s the optimizer spends spelling
// it. Every member of the CSE family binds a repeat to its own name, so one
// authored expression legitimately arrives split — wiring `gvn` moved
//
//   let _lc4 = vec2<f32>(_v121, ((-_v122) * _v24)).x;   (the vec2 built twice)
//   let _v22 = ((_v2 + _v21) * _v5);
//
// to
//
//   let _gv11 = vec2<f32>(_v121, ((-_v122) * _v24));  let _lc4 = _gv11.x;
//   let _gv2 = (_v2 + _v21);  let _v22 = (_gv2 * _v5);
//
// — identical arithmetic, one more name. These helpers see through exactly that:
// they follow hops that add NO arithmetic, so nothing an assertion cares about
// can hide behind one, and a real change to the arithmetic still fails.

/** The right-hand side of `name`'s `let`/`var` binding, or undefined. */
function bindingOf(body: string, name: string): string | undefined {
  return new RegExp(`(?:let|var) ${name}(?:: [^=]+)? = ([^;]+);`).exec(body)?.[1]
}

/** `name`'s binding with pure-ALIAS hops resolved: a rebind (`let a = b;`) and a
 *  member access on one (`let a = b.x;` -> `<b's binding>.x`). Neither adds an
 *  operation, so resolving them cannot step over arithmetic — it only undoes the
 *  optimizer having named an intermediate. Bounded by a visited set, so a
 *  malformed body cannot loop. */
export function arithmeticOf(body: string, name: string): string | undefined {
  const seen = new Set<string>()
  let cur = name
  for (;;) {
    if (seen.has(cur)) return undefined
    seen.add(cur)
    const rhs = bindingOf(body, cur)?.trim()
    if (rhs === undefined) return undefined
    const alias = /^(\w+)((?:\.\w+)*)$/.exec(rhs)
    if (!alias) return rhs
    const inner = bindingOf(body, alias[1]!)
    if (inner === undefined) return rhs // a param / binding read — as far as it goes
    cur = alias[1]!
    if (alias[2]) return `${inner.trim()}${alias[2]}`
  }
}

/** The arc-length binding `arc = (glyph + phase) * spacing`, whether the sum is
 *  written inline or the optimizer bound it to its own name. Returns the four
 *  identifiers the callers then check the PROVENANCE of — finding the shape is
 *  only half of each assertion. */
export function matchArc(
  body: string,
): { arc: string; glyph: string; phase: string; spacing: string } | undefined {
  const inline = /let (\w+) = \(\((\w+) \+ (\w+)\) \* (\w+)\);/.exec(body)
  if (inline) return { arc: inline[1]!, glyph: inline[2]!, phase: inline[3]!, spacing: inline[4]! }
  for (const m of body.matchAll(/let (\w+) = \((\w+) \* (\w+)\);/g)) {
    const sum = /^\((\w+) \+ (\w+)\)$/.exec(bindingOf(body, m[2]!)?.trim() ?? '')
    if (sum) return { arc: m[1]!, glyph: sum[1]!, phase: sum[2]!, spacing: m[3]! }
  }
  return undefined
}
