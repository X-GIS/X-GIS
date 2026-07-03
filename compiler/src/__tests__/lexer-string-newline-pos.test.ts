// FIX 2 — readString() did not advance line/col on embedded newlines.
// A multi-line string literal left `line` unchanged, so EVERY token
// after the string reported a line number too low by the embedded-
// newline count (AGENTS.md:24 line/col invariant). tokenize() (newline
// branch) and skipBlockComment() handle `\n` correctly; readString did
// not. This pins the line of a token that follows a multi-line string.

import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { TokenType } from '../lexer/tokens'

describe('FIX 2 — lexer tracks newlines inside string literals', () => {
  it('token after a multi-line string reports its true physical line', () => {
    // The string spans physical lines 1→3 (two embedded newlines).
    // `after` sits on physical line 4 (1-indexed).
    const src = '"line one\nline two\nline three"\nafter'
    const tokens = new Lexer(src).tokenize()
    const after = tokens.find((t) => t.type === TokenType.Identifier && t.value === 'after')
    expect(after).toBeDefined()
    // Pre-fix: readString never did line++, so `after` reported line 2
    // (only the trailing real newline counted). True line = 4.
    expect(after!.line).toBe(4)
  })

  it('escaped \\n in a string also advances the physical line counter only on real newlines', () => {
    // `\n` here is the two source chars backslash+n (NOT a real newline),
    // so it must NOT bump the line counter. Only the real newline after
    // the closing quote counts.
    const src = '"esc\\nstill-line-1"\nafter'
    const tokens = new Lexer(src).tokenize()
    const after = tokens.find((t) => t.type === TokenType.Identifier && t.value === 'after')
    expect(after).toBeDefined()
    expect(after!.line).toBe(2)
  })

  it('column resets correctly after an embedded newline', () => {
    // After "ab\nQ" the closing quote is on physical line 2; the next
    // token `x` follows the real newline so it sits at line 3, col 1.
    const src = '"ab\nQ"\nx'
    const tokens = new Lexer(src).tokenize()
    const x = tokens.find((t) => t.type === TokenType.Identifier && t.value === 'x')
    expect(x).toBeDefined()
    expect(x!.line).toBe(3)
    expect(x!.col).toBe(1)
  })
})
