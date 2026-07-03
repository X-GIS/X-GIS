// BUG 14 — readString captured startCol at the opening quote but pushed
// the token with `line: this.line`, which has already been advanced past
// embedded newlines by the time the closing quote is reached. The result
// was a self-inconsistent position (closing line + opening col). Every
// other token records the position of its first character.

import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { TokenType } from '../lexer/tokens'

describe('BUG 14 — multi-line string token reports its opening line', () => {
  it('a string spanning two physical lines reports line 1 (its start)', () => {
    const tokens = new Lexer('"line1\nline2"').tokenize()
    const str = tokens.find((t) => t.type === TokenType.String)
    expect(str).toBeDefined()
    // Pre-fix: this.line was bumped to 2 by the embedded newline.
    expect(str!.line).toBe(1)
    // col was already taken at the opening quote and is unchanged.
    expect(str!.col).toBe(1)
  })

  it('a single-line string is unaffected', () => {
    const tokens = new Lexer('"hello"').tokenize()
    const str = tokens.find((t) => t.type === TokenType.String)
    expect(str!.line).toBe(1)
    expect(str!.col).toBe(1)
  })
})
