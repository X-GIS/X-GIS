// The `X-GIS<NNNN>` registry is a hand-maintained ID allocator with two
// authorities in one file — the doc table at the top of `diagnostic.ts`
// (where an author reads "the highest number so far") and the `export const`
// bindings below it. Nothing else in the repo looks at either as a SET, so a
// duplicate is well-typed, passes vitest, and merges clean: two branches cut
// from the same base each take the next free number, and because the table row
// and the export land next to different neighbours, git aligns neither half.
//
// That happened (#2594): two branches both allocated `X-GIS0029`, caught by
// hand while reading the second diff. Codes are permanent by the registry's own
// rule ("allocated once, here, and never re-used for a different meaning";
// `X-GIS0004` is retired and reserved forever), so a landed collision cannot be
// renumbered away — it has to be prevented.
//
// This is CLAUDE.md §12's double-delta trap with the counter replaced by an ID
// allocator, and strictly worse: a wrong ratchet number reds a test the same
// day, a duplicate code is silent until someone filters on `code` and gets the
// other diagnostic.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'diagnostic.ts'), 'utf8')

/** `export const NAME = 'X-GIS0001'` → [name, code]. */
const exported = [...SOURCE.matchAll(/export const (\w+) = '(X-GIS\d{4})'/g)].map((m) => ({
  name: m[1],
  code: m[2],
}))

/** A registry row: `//   X-GIS0001  warn   lower     …`. Continuation lines of a
 *  wrapped description are indented past the code column and do not match. */
const tableCodes = [...SOURCE.matchAll(/^\/\/ {3}(X-GIS\d{4}) /gm)].map((m) => m[1])

describe('X-GIS diagnostic code registry (#2594)', () => {
  it('exports at least the codes this test was written against', () => {
    // Guards the two regexes above: if the file's shape changes so they stop
    // matching, every assertion below passes over an EMPTY set — a blind
    // instrument reporting zero, which reads as a clean registry.
    expect(exported.length).toBeGreaterThanOrEqual(19)
    expect(tableCodes.length).toBeGreaterThanOrEqual(28)
  })

  it('no two exported constants share a code', () => {
    const byCode = new Map<string, string[]>()
    for (const { name, code } of exported) {
      byCode.set(code, [...(byCode.get(code) ?? []), name])
    }
    const collisions = [...byCode].filter(([, names]) => names.length > 1)
    expect(collisions.map(([code, names]) => `${code} is bound by ${names.join(' and ')}`)).toEqual(
      [],
    )
  })

  it('no code appears twice in the registry table', () => {
    const seen = new Set<string>()
    const twice = tableCodes.filter((c) => (seen.has(c) ? true : (seen.add(c), false)))
    expect(twice).toEqual([])
  })

  it('every exported code has a row in the registry table', () => {
    // One direction only. The reverse does NOT hold and must not be asserted:
    // X-GIS0001–X-GIS0009 predate the exported constants and are still raised
    // as string literals, plus X-GIS0004 is a retired reservation with no
    // meaning to bind. The table is a superset of the exports by construction.
    const rows = new Set(tableCodes)
    expect(exported.filter((e) => !rows.has(e.code)).map((e) => `${e.name} (${e.code})`)).toEqual(
      [],
    )
  })
})
