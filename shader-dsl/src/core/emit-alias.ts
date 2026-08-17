// ═══ Shader DSL — type-name aliasing ═══
//
// After mangle has renamed the authored vocabulary and minify has removed the
// whitespace, the heaviest identifiers left in the shipped text are the TYPE
// NAMES — and they are the one heavy thing neither pass may touch, because both
// languages reserve them. Measured over the example corpus at that point:
// `vec2<f32>` × 655 (11.0% of all WGSL bytes), `f32` × 1241 (7.0%),
// `float` × 1026 (8.8% of GLSL), `vec2` × 1187 (8.1%).
//
// Both targets can give a type a shorter name, and both accept that name
// everywhere the type was spelled — including CONSTRUCTOR position, which is
// where most of the occurrences are:
//   • WGSL   `alias A=vec2<f32>;`   … `A(1.,2.)`
//   • GLSL   `#define A vec2`        … `A(1.,2.)`
// (Verified on real Tint and real ANGLE before this pass was written; the
// obfuscate() e2e gate keeps verifying it.)
//
// The pass SPLICES the source by token offset rather than re-spelling it, so it
// composes in either order with minify and leaves formatting otherwise byte-
// identical — a plain emit run through aliasTypes() alone is still indented.
//
// What it deliberately does NOT do:
//   • alias a type that does not pay for its own declaration (the saving is
//     computed per spelling, and a one-use `mat4x3<f32>` is left alone);
//   • touch a type token carrying a GLSL precision qualifier (`precision highp
//     float;`) — macro expansion inside a `precision` statement is a corner the
//     probe did not cover, and the two lines it costs are not worth the risk;
//   • invent a name: alias names are drawn from spellings that appear NOWHERE
//     in the text, so a `#define` (which is textual and module-wide) cannot
//     capture an identifier that already exists.

import { lexShader, type Token } from './shader-lex'

/** Which target's alias syntax to write. Determined from the text, not guessed:
 *  a GLSL ES 3.00 shader MUST begin with `#version 300 es` (the spec requires
 *  the directive on the first line), and WGSL has no `#` directives at all. */
type Target = 'wgsl' | 'glsl'

/** WGSL parameterised types — spelled `base<scalar>`, four tokens. */
const WGSL_BASE = new Set([
  'vec2',
  'vec3',
  'vec4',
  'mat2x2',
  'mat2x3',
  'mat2x4',
  'mat3x2',
  'mat3x3',
  'mat3x4',
  'mat4x2',
  'mat4x3',
  'mat4x4',
])
/** WGSL scalars — a type on their own, and the parameter of the above. */
const WGSL_SCALAR = new Set(['f32', 'f16', 'i32', 'u32', 'bool'])

/** GLSL ES 3.00 type keywords. Opaque/sampler types are absent on purpose: they
 *  appear once each in a binding declaration and never pay for an alias. */
const GLSL_TYPES = new Set([
  'float',
  'int',
  'uint',
  'bool',
  'vec2',
  'vec3',
  'vec4',
  'ivec2',
  'ivec3',
  'ivec4',
  'uvec2',
  'uvec3',
  'uvec4',
  'bvec2',
  'bvec3',
  'bvec4',
  'mat2',
  'mat3',
  'mat4',
  'mat2x2',
  'mat2x3',
  'mat2x4',
  'mat3x2',
  'mat3x3',
  'mat3x4',
  'mat4x2',
  'mat4x3',
  'mat4x4',
])

const PRECISION = new Set(['highp', 'mediump', 'lowp'])

/** One matched type spelling in the source. */
interface Site {
  readonly spelling: string
  readonly start: number
  readonly end: number
}

/** Every type spelling in the token stream, longest-match first so the `f32`
 *  inside `vec2<f32>` is not counted (or replaced) separately. */
function findSites(toks: readonly Token[], target: Target): Site[] {
  const sites: Site[] = []
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!
    if (t.kind !== 'word') continue
    if (target === 'wgsl') {
      if (
        WGSL_BASE.has(t.text) &&
        toks[i + 1]?.text === '<' &&
        WGSL_SCALAR.has(toks[i + 2]?.text ?? '') &&
        toks[i + 3]?.text === '>'
      ) {
        const close = toks[i + 3]!
        sites.push({
          spelling: `${t.text}<${toks[i + 2]!.text}>`,
          start: t.start,
          end: close.end,
        })
        i += 3
        continue
      }
      if (WGSL_SCALAR.has(t.text)) sites.push({ spelling: t.text, start: t.start, end: t.end })
      continue
    }
    // GLSL — bare keywords, minus the ones a precision qualifier introduces.
    if (!GLSL_TYPES.has(t.text)) continue
    if (PRECISION.has(toks[i - 1]?.text ?? '')) continue
    sites.push({ spelling: t.text, start: t.start, end: t.end })
  }
  return sites
}

const ALPHA = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** The i-th short name in bijective base-52: a, b, … Z, aa, ab, … */
function nthName(i: number): string {
  let out = ''
  let n = i
  do {
    out = ALPHA[n % 52]! + out
    n = Math.floor(n / 52) - 1
  } while (n >= 0)
  return out
}

/** Bytes a declaration costs, including the newline it needs. */
const declCost = (target: Target, spelling: string, name: string): number =>
  target === 'wgsl'
    ? `alias ${name}=${spelling};`.length + 1
    : `#define ${name} ${spelling}`.length + 1

/** Give a type a one- or two-character name wherever that is a net win.
 *  Idempotent: a second run finds no spelling left that pays.
 *  `renames` receives `typeSpelling -> aliasName`, the same authored → emitted
 *  direction `mangleModule` reports, so ONE map can carry both and feed
 *  `decodeShaderLog`. A type spelling can never collide with a mangle key —
 *  both languages reserve type names, so no authored identifier spells one. */
export function aliasShaderTypes(src: string, renames?: Map<string, string>): string {
  const toks = lexShader(src)
  const target: Target = toks[0]?.kind === 'directive' ? 'glsl' : 'wgsl'

  const sites = findSites(toks, target)
  if (sites.length === 0) return src

  const counts = new Map<string, number>()
  for (const s of sites) counts.set(s.spelling, (counts.get(s.spelling) ?? 0) + 1)

  // A `#define` is module-wide and TEXTUAL, so a name that already occurs
  // anywhere — an identifier, a keyword, a type — is not available.
  const occupied = new Set<string>()
  for (const t of toks) {
    if (t.kind === 'word') occupied.add(t.text)
    else if (t.kind === 'directive') for (const w of t.text.split(/\W+/)) if (w) occupied.add(w)
  }

  // Assign in descending occurrence order (ties by spelling) so the shortest
  // names go to the heaviest types; deterministic, which the GLSL two-stage
  // link relies on the same way mangle does.
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  const alias = new Map<string, string>()
  const decls: string[] = []
  let next = 0
  for (const [spelling, count] of ranked) {
    let name = nthName(next)
    while (occupied.has(name)) name = nthName(++next)
    const saving = count * (spelling.length - name.length) - declCost(target, spelling, name)
    if (saving <= 0) continue
    alias.set(spelling, name)
    occupied.add(name)
    next++
    renames?.set(spelling, name)
    decls.push(target === 'wgsl' ? `alias ${name}=${spelling};` : `#define ${name} ${spelling}`)
  }
  if (alias.size === 0) return src

  // Splice back-to-front so earlier offsets stay valid.
  let out = src
  for (let i = sites.length - 1; i >= 0; i--) {
    const s = sites[i]!
    const to = alias.get(s.spelling)
    if (to !== undefined) out = out.slice(0, s.start) + to + out.slice(s.end)
  }

  // The declarations go AFTER the header: GLSL requires `#version` first, WGSL
  // requires its `enable`/`requires` directives before any declaration.
  const lines = out.split('\n')
  let at = 0
  while (at < lines.length && /^\s*(#|enable\b|requires\b|diagnostic\b)/.test(lines[at]!)) at++
  lines.splice(at, 0, ...decls)
  return lines.join('\n')
}
