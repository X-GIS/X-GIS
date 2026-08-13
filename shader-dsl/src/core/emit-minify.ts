// ═══ Shader DSL — emitted-text minifier ═══
//
// Whitespace/comment compaction of an ALREADY-EMITTED WGSL / GLSL ES 3.00
// string, over the shared lexer (`shader-lex.ts`). Provably token-safe because
// of two language facts:
//   • neither language has string literals — a `//` always starts a comment,
//     and whitespace is never significant inside any token;
//   • a newline is ordinary whitespace EXCEPT around GLSL preprocessor
//     directives (`#version`, `#extension`), which must sit on their own line
//     — directive lines pass through verbatim (internal runs collapsed to one
//     space).
//
// The minifier LEXES the text and re-emits the token stream, so it does not
// have to be conservative about which characters a space may sit between: a
// separator is written iff omitting it would MERGE the boundary, decided by
// re-lexing `prev + next` and checking the first token is still `prev` — the
// same maximal-munch rule the real compilers use. That is one rule covering
// every operator pair (`- -x`, `a / /b`, `<< =`, `1.0 f32`), and it removes the
// spaces the previous structural-punctuation-only rule had to keep (`a=b`,
// `)->f32`, `return -x` stays spaced only where it must).
//
// Three further LOSSLESS shrinks ride on the token stream:
//   • block comments (`/* … */`) join `//` as removable — the DSL does not emit
//     them today, but hand-written `raw`/`rawGlsl` text can;
//   • numeric literals are canonicalised WITHOUT changing their value:
//     `0.500` → `.5`, `1.0` → `1.`, `1.0e-07` → `1e-7`. Never a digit dropped
//     from the significand (`0.800000011920929` is an f32-exact printout — a
//     rounded one is a different number), and never a `.` dropped from a float
//     with no exponent (that would retype it to an integer in WGSL);
//   • a TRAILING comma before `)` / `}` / `]` is dropped — the one token this
//     pass REMOVES rather than re-spells (see CLOSERS for why it is optional).
//
// Idempotent; no semantic change — the compile gates run the minified output on
// real Tint + ANGLE (playground/e2e/_emit-obfuscate-gate.spec.ts).

import { lexShader, needsSpace, type Token } from './shader-lex'

// ── Numeric literals ──

const NUMBER_RE = /^(\d*)(?:\.(\d*))?(?:[eE]([+-]?)0*(\d+))?([fhiu]?)$/

/** Canonicalise a numeric literal without changing its value or its type.
 *  Decimal only — a hex/binary literal, or anything the shape below does not
 *  match exactly, is returned untouched.
 *
 *  Value preservation: only leading zeros of the integer part, trailing zeros
 *  of the FRACTION, a `+` and leading zeros in the exponent, and a
 *  now-redundant `.` (exponent present, fraction empty) are removed — each a
 *  no-op on the decimal value. Type preservation: a float with no exponent
 *  always keeps its `.`, so `1.0` → `1.` and never `1` (an integer in WGSL),
 *  and a literal with no `.`/exponent at all is left alone. */
function shortenNumber(text: string): string {
  const m = NUMBER_RE.exec(text)
  if (m === null) return text
  const [, rawInt = '', rawFrac, expSign, expDigits, suffix = ''] = m
  const hasDot = rawFrac !== undefined
  const hasExp = expDigits !== undefined
  if (!hasDot && !hasExp) return text // plain integer (`0`, `7u`) — nothing to win

  const int = rawInt.replace(/^0+(?=\d)/, '')
  const frac = (rawFrac ?? '').replace(/0+$/, '')
  const exp = hasExp ? `e${expSign === '-' ? '-' : ''}${expDigits.replace(/^0+(?=\d)/, '')}` : ''

  // Mantissa: drop a bare `0` integer part (`.5`) only when a fraction digit
  // survives to carry the literal, and drop the `.` only when an exponent
  // already marks it as a float.
  let mantissa: string
  if (frac !== '') mantissa = `${int === '0' ? '' : int}.${frac}`
  else if (hasExp) mantissa = int === '' ? '0' : int
  else mantissa = `${int === '' ? '0' : int}.`

  const short = `${mantissa}${exp}${suffix}`
  return short.length < text.length ? short : text
}

// ── Public API ──

/** Lex a shader into its token texts, comments dropped (a directive line is one
 *  token). Exported so the token-PRESERVATION gate is reachable: minification is
 *  correct iff this sequence is unchanged across it, modulo the numeric
 *  canonicalisation — asserting that is what makes "token-safe by construction"
 *  a checked claim rather than a comment.
 *  See `shader-dsl/examples/minify-safety.test.ts`. */
export function shaderTokens(src: string): string[] {
  return lexShader(src).map((t) => t.text)
}

export interface MinifyOptions {
  /** Canonicalise numeric literals (`0.500` → `.5`, `1.0e-07` → `1e-7`).
   *  Lossless — no significand digit is ever dropped. Default `true`; turn it
   *  off when the emitted text is diffed against a hand-checked baseline. */
  readonly numbers?: boolean
}

/** Closes a comma list — a `,` immediately before one of these is TRAILING, and
 *  carries nothing. WGSL makes it optional everywhere the backend emits one
 *  (`struct S{a:f32,b:f32,}`); GLSL never produces the sequence at all, since
 *  its struct members end in `;` and its lists have no optional trailing form.
 *  The only token this pass removes — everything else is spelling. */
const CLOSERS = new Set([')', '}', ']'])

/** Minify an emitted WGSL / GLSL shader string: strip comments and blank lines,
 *  keep `#` directive lines verbatim on their own line, canonicalise numeric
 *  literals, drop trailing commas, and join everything between the directives
 *  into one compact line with a separator only where maximal munch would
 *  otherwise merge two tokens. */
export function minifyShaderText(src: string, opts?: MinifyOptions): string {
  const shortenNumbers = opts?.numbers ?? true
  const toks = lexShader(src)

  // Spell every token, then drop the trailing commas — as a separate pass, so
  // the separator decision below always sees the token that really precedes it.
  // Offsets are dropped here: this pass RE-SPELLS the shader rather than
  // splicing it, so a token's position in the input stops meaning anything.
  const kept: Array<Pick<Token, 'kind' | 'text'>> = []
  for (const tok of toks) {
    const text = tok.kind === 'number' && shortenNumbers ? shortenNumber(tok.text) : tok.text
    if (CLOSERS.has(text) && kept[kept.length - 1]?.text === ',') kept.pop()
    kept.push({ kind: tok.kind, text })
  }

  let out = ''
  let prev: string | null = null
  for (const tok of kept) {
    if (tok.kind === 'directive') {
      if (out !== '' && !out.endsWith('\n')) out += '\n'
      out += `${tok.text}\n`
      prev = null
      continue
    }
    if (prev !== null && needsSpace(prev, tok.text)) out += ' '
    out += tok.text
    prev = tok.text
  }
  return out.endsWith('\n') ? out : `${out}\n`
}
