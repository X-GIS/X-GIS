// Pin source-throw recovery path: catch-block must sanitize source id
// + neutralise `*/` in the error message. Pre-fix a raw id with kebab
// shape ("road-major") produced an unparseable `source road-major {`
// placeholder, and a thrown message containing `*/` could close the
// emitted file's top-of-file warning-comments wrapper early.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('source throw recovery — id sanitize + message neutralisation', () => {
  function makePoisonSrc(msg: string): unknown {
    // Triggers a real throw on src.url access inside convertSource —
    // the first .url read at the typeof !== 'string' gate is the
    // top of the access chain. Object.defineProperty so the getter
    // is attached to the SAME object the source loop iterates.
    const src: Record<string, unknown> = { type: 'vector' }
    Object.defineProperty(src, 'url', {
      configurable: true,
      enumerable: true,
      get() { throw new Error(msg) },
    })
    return src
  }

  it('kebab-case id sanitizes in placeholder block', () => {
    const style = {
      version: 8,
      sources: { 'road-major': makePoisonSrc('boom') },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    // sanitised id replaces hyphen with underscore.
    expect(code).toMatch(/source road_major \{[\s\S]*SKIPPED/)
    // Raw kebab-form must NOT appear as a `source` identifier.
    expect(code).not.toMatch(/source road-major \{/)
  })

  it('error message containing `*/` is neutralised', () => {
    const style = {
      version: 8,
      sources: { s: makePoisonSrc('break out */ of comment') },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    // The trailing /* Conversion notes … */ block must not close
    // early due to a raw `*/` inside any warning text. Verify there
    // is EXACTLY ONE block-comment close in the file — placeholder
    // source uses // line comments, only the trailing notes block
    // uses /* */.
    const closes = (code.match(/\*\//g) ?? []).length
    expect(closes).toBe(1)
    // And the trailing notes block is well-formed (opens then closes).
    expect(code).toMatch(/\/\* Conversion notes[\s\S]*\*\/\s*$/)
  })
})
