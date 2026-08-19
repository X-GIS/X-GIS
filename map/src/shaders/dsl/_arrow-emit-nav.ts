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

/** The argument a `return <Struct>(…)` exit supplies for one FIELD, found by NAME.
 *
 *  The entry's output used to be assembled field-by-field (`o.tint = …`), which let
 *  these specs navigate to a field by its name. `structCtor` (#1867) collapses that
 *  write-once assembly into a constructor, and a constructor's arguments are
 *  POSITIONAL — so a spec that still wants "the tint argument" has to map the name to
 *  an index itself. Doing that here, from the struct DECL in the same emitted text,
 *  keeps the assertions name-based: a field reordered in the IR moves the index too,
 *  and a field renamed fails loudly instead of silently reading its neighbour.
 *
 *  Splits on TOP-LEVEL commas only — every argument here is itself a call or a
 *  constructor, so a naive split would cut through `vec4<f32>(a, b, c, d)`. Depth
 *  counts `()` and `[]` and deliberately NOT `<>`: WGSL spells a comparison with the
 *  same glyph as a generic close, and this emit really does contain one
 *  (`select(-1.0, 1.0, (_v18.z > 0.5))`), which a `>`-aware scanner mis-reads as
 *  leaving a nesting level. Generic brackets carry no top-level comma in any type
 *  these entries return, so ignoring them is exact here. */
export function returnCtorArg(
  emitted: string,
  structName: string,
  fieldName: string,
): string | undefined {
  const decl = new RegExp(`struct ${structName} \\{([^}]*)\\}`).exec(emitted)
  if (!decl) return undefined
  const fields = [...decl[1]!.matchAll(/(?:@[\w()]+(?:\([^)]*\))?\s+)*(\w+)\s*:/g)].map(
    (m) => m[1]!,
  )
  const idx = fields.indexOf(fieldName)
  if (idx < 0) return undefined

  const open = emitted.indexOf(`return ${structName}(`)
  if (open < 0) return undefined
  let depth = 0
  let start = open + `return ${structName}(`.length
  const args: string[] = []
  for (let i = start; i < emitted.length; i++) {
    const c = emitted[i]!
    if (c === '(' || c === '[') depth++
    else if (c === ')' && depth === 0) {
      args.push(emitted.slice(start, i))
      break
    } else if (c === ')' || c === ']') depth--
    else if (c === ',' && depth === 0) {
      args.push(emitted.slice(start, i))
      start = i + 1
    }
  }
  return args[idx]?.trim()
}
