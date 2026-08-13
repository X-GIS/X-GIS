// ═══ Shader DSL — the emitted-text lexer ═══
//
// ONE lexer over already-emitted WGSL / GLSL ES 3.00, shared by every text-stage
// production pass (`emit-minify.ts`, `emit-alias.ts`). It exists because both
// passes need the SAME two answers and must not answer them differently:
//   • where does each token start and end (so a pass can splice text by offset
//     instead of re-spelling the whole shader and destroying its formatting);
//   • may two tokens be written adjacently, or would maximal munch merge them.
//
// Coarse by design: keywords, type names and identifiers are all `word`, and
// every punctuation token is `punct`. The passes on top classify further; the
// lexer only has to agree with a real compiler about token BOUNDARIES.
//
// Provably safe on these two languages because neither has string literals — a
// `//` always starts a comment, and whitespace is never significant inside a
// token. A newline is ordinary whitespace EXCEPT around GLSL preprocessor
// directives, which must own their line; those lex as one `directive` token.

export type TokenKind = 'word' | 'number' | 'punct' | 'comment' | 'directive'

export interface Token {
  readonly kind: TokenKind
  readonly text: string
  /** Offset of the token's first character in the source it was lexed from. */
  readonly start: number
  /** Offset one past its last character. */
  readonly end: number
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
export function lexAt(src: string, i: number): Token {
  const tok = (kind: TokenKind, text: string): Token => ({
    kind,
    text,
    start: i,
    end: i + text.length,
  })
  const c = src[i]!

  if (src.startsWith('//', i)) {
    const nl = src.indexOf('\n', i)
    return tok('comment', src.slice(i, nl === -1 ? src.length : nl))
  }
  if (src.startsWith('/*', i)) {
    const end = src.indexOf('*/', i + 2)
    return tok('comment', src.slice(i, end === -1 ? src.length : end + 2))
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
    return tok('number', src.slice(i, j))
  }

  if (isWordChar(c)) {
    let j = i
    while (j < src.length && isWordChar(src[j]!)) j++
    return tok('word', src.slice(i, j))
  }

  for (const op of MULTI) if (src.startsWith(op, i)) return tok('punct', op)
  return tok('punct', c)
}

/** Tokenize a whole shader. Comments are dropped; a `#` at the start of a
 *  (trimmed) line takes the rest of that line as one `directive` token, whose
 *  `text` is normalised (trailing `//` comment stripped, whitespace runs
 *  collapsed) while `start`/`end` still span the raw line. */
export function lexShader(src: string): Token[] {
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
      out.push({ kind: 'directive', text, start: i, end: i + raw.length })
      i += raw.length
      continue
    }
    atLineStart = false
    const tok = lexAt(src, i)
    i = tok.end
    if (tok.kind !== 'comment') out.push(tok)
  }
  return out
}

/** True when `a` and `b` may NOT be written adjacently: re-lex the join and see
 *  whether maximal munch swallows past the end of `a`. Covers word/word
 *  (`return x`), number/word (`1.0 f32`), and every operator pair that has a
 *  longer form (`- -`, `/ /`, `<< =`, `> =`). */
export function needsSpace(a: string, b: string): boolean {
  return lexAt(a + b, 0).text.length !== a.length
}
