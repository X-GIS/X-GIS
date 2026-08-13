// ═══ shader-dsl examples — minifier token-preservation gate ═══
//
// emit-minify.test.ts pins the minifier's rules as hand-written STRINGS. This
// gate proves the property those strings are examples of, over every shipped
// example's real emitted WGSL and both GLSL stages:
//
//   • TOKEN PRESERVATION — the lexed token sequence is identical before and
//     after minification (numeric literals compared by VALUE, since they are
//     deliberately re-spelled, and TRAILING commas dropped from the "before"
//     side, the one token the minifier is allowed to remove). A merged token
//     (`a/ /b` → `a//b`), a swallowed directive, or a dropped separator all
//     break this, and none of them are visible in a byte-count assertion.
//   • VALUE PRESERVATION — every numeric literal's `parseFloat` is unchanged,
//     checked with a plain regex over the raw text, INDEPENDENT of the lexer
//     the minifier itself uses (a lexer bug must not be able to green its own
//     gate).
//   • IDEMPOTENCE — minify(minify(x)) === minify(x).
//
// The independent authority above these is _emit-obfuscate-gate.spec.ts, which
// compiles the minified output on real Tint + ANGLE.

import { describe, it, expect } from 'vitest'
import { examples } from './index.ts'
import { emitModule, emitGlslModule } from '../src/index.ts'
import { minifyShaderText } from '../src/emit-prod.ts'
import { shaderTokens } from '../src/core/emit-minify.ts'

interface Corpus {
  readonly name: string
  readonly code: string
}

const corpus: Corpus[] = []
for (const ex of examples) {
  corpus.push({ name: `${ex.id}.wgsl`, code: emitModule(ex.module) })
  if (ex.renderable) {
    corpus.push({ name: `${ex.id}.vertex.glsl`, code: emitGlslModule(ex.module, 'vertex') })
    corpus.push({ name: `${ex.id}.fragment.glsl`, code: emitGlslModule(ex.module, 'fragment') })
  }
}

/** Token comparison key: a numeric literal collapses to its VALUE, so the
 *  canonicalisation (`1.0` → `1.`) is not read as a token change; every other
 *  token must match byte-for-byte. */
const key = (t: string): string => {
  if (!/^[.\d]/.test(t)) return t
  const n = Number.parseFloat(t)
  return Number.isNaN(n) ? t : `#${n}${t.replace(/^[\d.eE+-]+/, '')}`
}

/** Drop trailing commas, the one token removal minification is allowed to make,
 *  so the "before" stream is comparable to the "after" one. */
const dropTrailingCommas = (toks: string[]): string[] => {
  const out: string[] = []
  for (const t of toks) {
    if ((t === ')' || t === '}' || t === ']') && out[out.length - 1] === ',') out.pop()
    out.push(t)
  }
  return out
}

/** Numeric literals as the raw text sees them — no shared lexer. */
const numbersOf = (src: string): number[] =>
  [...src.matchAll(/(?<![\w.])(?:\d[\d.]*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/g)]
    .map((m) => Number.parseFloat(m[0]))
    .filter((n) => !Number.isNaN(n))

describe('minifyShaderText over the whole example corpus', () => {
  it('has a corpus worth gating', () => {
    expect(corpus.length).toBeGreaterThan(20)
  })

  for (const { name, code } of corpus) {
    it(`${name}: preserves the token stream, the literal values, and is idempotent`, () => {
      const min = minifyShaderText(code)
      expect(shaderTokens(min).map(key)).toEqual(dropTrailingCommas(shaderTokens(code)).map(key))
      expect(numbersOf(min)).toEqual(numbersOf(code))
      expect(minifyShaderText(min)).toBe(min)
      expect(min.length).toBeLessThan(code.length)
    })
  }

  it('removes the operator spacing the structural-only rule had to keep', () => {
    // A property of the token-level emitter, not of any one shader: with the
    // corpus joined, no ` = `, ` + `, `; ` or `) -> ` survives anywhere.
    const all = corpus.map((c) => minifyShaderText(c.code)).join('\n')
    for (const kept of [' = ', ' + ', ' * ', '; ', ', ', ') -> ']) {
      expect(all.includes(kept), `minified corpus still contains ${JSON.stringify(kept)}`).toBe(
        false,
      )
    }
  })

  it('shrinks the corpus past what the structural-punctuation rule could reach', () => {
    // Measured: plain 186_527 chars → 150_220 (80.5%). The predecessor rule,
    // which kept every space that did not touch `(){}[];,:?`, bottomed out at
    // 87.5% — so this ceiling distinguishes the token-level emitter from a
    // regression back to it, and is not a byte-exact ratchet that churns on
    // every example edit.
    const plain = corpus.reduce((n, c) => n + c.code.length, 0)
    const min = corpus.reduce((n, c) => n + minifyShaderText(c.code).length, 0)
    expect(min / plain).toBeLessThan(0.82)
  })
})
