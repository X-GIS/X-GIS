// ═══ Shader DSL — emitted-text minifier ═══
//
// Whitespace/comment compaction of an ALREADY-EMITTED WGSL / GLSL ES 3.00
// string. Provably token-safe because of two language facts:
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
// Two further LOSSLESS shrinks ride on the token stream:
//   • block comments (`/* … */`) join `//` as removable — the DSL does not emit
//     them today, but hand-written `raw`/`rawGlsl` text can;
//   • numeric literals are canonicalised WITHOUT changing their value:
//     `0.500` → `.5`, `1.0` → `1.`, `1.0e-07` → `1e-7`. Never a digit dropped
//     from the significand (`0.800000011920929` is an f32-exact printout — a
//     rounded one is a different number), and never a `.` dropped from a float
//     with no exponent (that would retype it to an integer in WGSL).
//
// Idempotent; no semantic change — the compile gates run the minified output on
// real Tint + ANGLE (playground/e2e/_emit-obfuscate-gate.spec.ts).

// ── Lexer ──
//
// Coarse by design: the only questions the minifier asks of a token are "may it
// touch its neighbour" and "is it a number I can shorten". Keywords, types and
// identifiers are all `word`; every punctuation token is `punct`.

type TokenKind = 'word' | 'number' | 'punct' | 'comment' | 'directive'

interface Token {
  readonly kind: TokenKind
  readonly text: string
}

/** Multi-character tokens, longest first — maximal munch scans this in order.
 *  `//` and `/*` are here as tokens so the merge check below rejects a `/` `/`
 *  boundary that would otherwise comment out the rest of the shader. */
const MULTI = [
  '<<=',
  '>>=',
  '//',
  '/*',
  '->',
  '&&',
  '||',
  '<<',
  '>>',
  '==',
  '!=',
  '<=',
  '>=',
  '++',
  '--',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
]

const isDigit = (c: string): boolean => c >= '0' && c <= '9'
const isWordChar = (c: string): boolean =>
  c === '_' || isDigit(c) || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')

/** Lex the single token starting at `i` (which must not be whitespace).
 *  A number munches every following word char, `.`, and a sign directly after
 *  an exponent marker — so a malformed suffix (`1.0f32`) lexes as ONE token,
 *  which is what makes the merge check below conservative in the safe
 *  direction. Comments are returned whole — a line comment to the newline, a
 *  block comment to its terminator. */
function lexAt(src: string, i: number): Token {
  const c = src[i]!

  if (src.startsWith('//', i)) {
    const nl = src.indexOf('\n', i)
    return { kind: 'comment', text: src.slice(i, nl === -1 ? src.length : nl) }
  }
  if (src.startsWith('/*', i)) {
    const end = src.indexOf('*/', i + 2)
    return { kind: 'comment', text: src.slice(i, end === -1 ? src.length : end + 2) }
  }

  if (isDigit(c) || (c === '.' && isDigit(src[i + 1] ?? ''))) {
    let j = i
    while (j < src.length) {
      const ch = src[j]!
      const prev = src[j - 1]
      if (isWordChar(ch) || ch === '.') j++
      else if ((ch === '+' || ch === '-') && (prev === 'e' || prev === 'E' || prev === 'p')) j++
      else break
    }
    return { kind: 'number', text: src.slice(i, j) }
  }

  if (isWordChar(c)) {
    let j = i
    while (j < src.length && isWordChar(src[j]!)) j++
    return { kind: 'word', text: src.slice(i, j) }
  }

  for (const op of MULTI) if (src.startsWith(op, i)) return { kind: 'punct', text: op }
  return { kind: 'punct', text: c }
}

/** Tokenize a whole shader. Comments are dropped; a `#` at the start of a
 *  (trimmed) line takes the rest of that line as one `directive` token, with
 *  its trailing `//` comment stripped and internal whitespace runs collapsed. */
function tokenize(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  let atLineStart = true
  while (i < src.length) {
    const c = src[i]!
    if (c === '\n') {
      atLineStart = true
      i++
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++
      continue
    }
    if (c === '#' && atLineStart) {
      const nl = src.indexOf('\n', i)
      const raw = src.slice(i, nl === -1 ? src.length : nl)
      const cut = raw.indexOf('//')
      const text = (cut === -1 ? raw : raw.slice(0, cut)).trim().replace(/\s+/g, ' ')
      out.push({ kind: 'directive', text })
      i += raw.length
      continue
    }
    atLineStart = false
    const tok = lexAt(src, i)
    i += tok.text.length
    if (tok.kind !== 'comment') out.push(tok)
  }
  return out
}

/** True when `a` and `b` may NOT be written adjacently: re-lex the join and see
 *  whether maximal munch swallows past the end of `a`. Covers word/word
 *  (`return x`), number/word (`1.0 f32`), and every operator pair that has a
 *  longer form (`- -`, `/ /`, `<< =`, `> =`). */
function needsSpace(a: string, b: string): boolean {
  return lexAt(a + b, 0).text.length !== a.length
}

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
  return tokenize(src).map((t) => t.text)
}

export interface MinifyOptions {
  /** Canonicalise numeric literals (`0.500` → `.5`, `1.0e-07` → `1e-7`).
   *  Lossless — no significand digit is ever dropped. Default `true`; turn it
   *  off when the emitted text is diffed against a hand-checked baseline. */
  readonly numbers?: boolean
}

/** Minify an emitted WGSL / GLSL shader string: strip comments and blank lines,
 *  keep `#` directive lines verbatim on their own line, canonicalise numeric
 *  literals, and join everything between the directives into one compact line
 *  with a separator only where maximal munch would otherwise merge two tokens. */
export function minifyShaderText(src: string, opts?: MinifyOptions): string {
  const shortenNumbers = opts?.numbers ?? true
  let out = ''
  let prev: string | null = null
  for (const tok of tokenize(src)) {
    if (tok.kind === 'directive') {
      if (out !== '' && !out.endsWith('\n')) out += '\n'
      out += `${tok.text}\n`
      prev = null
      continue
    }
    const text = tok.kind === 'number' && shortenNumbers ? shortenNumber(tok.text) : tok.text
    if (prev !== null && needsSpace(prev, text)) out += ' '
    out += text
    prev = text
  }
  return out.endsWith('\n') ? out : `${out}\n`
}
