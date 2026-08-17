// ═══ Shader DSL — pruning redundant GLSL forward prototypes ═══
//
// The GLSL ES 3.00 backend emits a forward prototype for EVERY helper before the
// definitions, because it cannot promise the function section is in dependency
// order: collected callees are prepended and may precede the extern-bodied
// projection fns they call, so an unconditional prototype block makes the
// section order-free. That is the right default for an emitter.
//
// It is also, in a shipped shader, mostly dead weight — and it is invisible in a
// toy example. Measured on the REAL baked corpus (972 KB of map shaders, where a
// module drags in the df64 library and the projection graph, ~40 helpers rather
// than four): 965 prototype lines, 71_011 chars, 9.5% of the production-
// transformed text. The example corpus shows almost none of it, which is why
// this was missed until the real payload was measured.
//
// A prototype is redundant exactly when the DEFINITION already declares the
// function everywhere it is used — i.e. the definition precedes every reference.
// That is decidable from the token stream, and this pass decides it per function
// rather than assuming the order is fine. Anything it cannot classify, it keeps:
// no definition in this text (an extern body spliced by the host), a reference
// before the definition, a declarator shape it does not recognise.
//
// GLSL only. WGSL resolves module-scope declarations out of order and has no
// prototype syntax at all, so there is nothing to prune.

import { lexShader, type Token } from './shader-lex'

/** A top-level `type name(params)` header — the part both a prototype and a
 *  definition share. */
interface Declarator {
  readonly name: string
  /** Token index of the NAME. */
  readonly at: number
  /** Token index range of the whole header, inclusive of the closing paren. */
  readonly from: number
  readonly to: number
  readonly isDefinition: boolean
  /** Source offsets of the whole prototype, `;` included (definitions: unused). */
  readonly start: number
  readonly end: number
}

/** Scan top-level declarators. A declarator may only START at a statement
 *  boundary — otherwise `const float x=f(1.);` would read its initializer's call
 *  as a prototype for `f`. */
function declarators(toks: readonly Token[]): Declarator[] {
  const out: Declarator[] = []
  let depth = 0
  let boundary = true
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!
    if (t.text === '{') {
      depth++
      boundary = true
      continue
    }
    if (t.text === '}') {
      depth--
      boundary = true
      continue
    }
    if (t.text === ';' || t.kind === 'directive') {
      boundary = true
      continue
    }
    if (depth > 0 || !boundary || t.kind !== 'word') {
      boundary = false
      continue
    }
    // A run of words (qualifiers + return type + name) then `(`.
    let j = i
    while (toks[j]?.kind === 'word') j++
    if (j - i < 2 || toks[j]?.text !== '(') {
      boundary = false
      i = j - 1
      continue
    }
    let paren = 0
    let k = j
    for (; k < toks.length; k++) {
      if (toks[k]!.text === '(') paren++
      else if (toks[k]!.text === ')' && --paren === 0) break
    }
    const after = toks[k + 1]
    if (after === undefined || (after.text !== ';' && after.text !== '{')) {
      boundary = false
      i = j - 1
      continue
    }
    out.push({
      name: toks[j - 1]!.text,
      at: j - 1,
      from: i,
      to: k,
      isDefinition: after.text === '{',
      start: t.start,
      end: after.end,
    })
    i = k
    boundary = false
  }
  return out
}

/** Drop every forward prototype whose definition already declares the function
 *  at each of its uses. Identity on WGSL and on any GLSL text where the order
 *  genuinely needs the prototypes. */
export function pruneRedundantPrototypes(src: string): string {
  const toks = lexShader(src)
  if (toks[0]?.kind !== 'directive') return src // WGSL — no prototypes exist

  const decls = declarators(toks)
  const protos = decls.filter((d) => !d.isDefinition)
  if (protos.length === 0) return src

  const defAt = new Map<string, number>()
  for (const d of decls) if (d.isDefinition && !defAt.has(d.name)) defAt.set(d.name, d.at)

  // A reference is any occurrence of the name outside every declarator HEADER.
  // Counting a same-named parameter in some other header as a reference would
  // only make us keep a prototype — the safe direction.
  const inHeader = new Uint8Array(toks.length)
  for (const d of decls) for (let i = d.from; i <= d.to; i++) inHeader[i] = 1
  const firstUse = new Map<string, number>()
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!
    if (t.kind !== 'word' || inHeader[i] === 1 || !defAt.has(t.text)) continue
    if (!firstUse.has(t.text)) firstUse.set(t.text, i)
  }

  const cuts = protos.filter((p) => {
    const def = defAt.get(p.name)
    if (def === undefined) return false // declared here, defined elsewhere — keep
    const use = firstUse.get(p.name)
    return use === undefined || use > def
  })
  if (cuts.length === 0) return src

  // Splice back-to-front, taking the line's newline with it when nothing else
  // shared the line, so the pass does not leave a blank behind.
  let out = src
  for (let i = cuts.length - 1; i >= 0; i--) {
    const c = cuts[i]!
    let end = c.end
    const nl = out.indexOf('\n', end)
    if (nl !== -1 && out.slice(end, nl).trim() === '') end = nl + 1
    out = out.slice(0, c.start) + out.slice(end)
  }
  return out
}
