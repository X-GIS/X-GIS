// ═══ #2534 — the four edit-distance kernels are one kernel ═══
//
// `compiler/src/ir` held FOUR private Levenshtein implementations —
// validate-fncalls.ts and validate-schema-fields.ts (byte-identical two-row,
// a fresh row per iteration), utility-registry.ts (two-row with a buffer swap,
// named `editDistance`), preset-expand.ts (one row updated in place). Folding
// them into `edit-distance.ts` is only safe if they all computed the SAME
// function, and "I read all four and they look like Levenshtein" is not that
// proof: three different loop shapes is exactly where an off-by-one hides.
//
// So the retired shapes are re-implemented below verbatim and asserted equal
// to the survivor across a corpus that reaches every branch each of them has —
// the differential form CLAUDE.md §12 calls a constructive proof, as opposed
// to a golden that only pins today's output.

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { editDistance, nearestByEditDistance } from './edit-distance'

// ── The three retired shapes, exactly as they were deleted ────────────────

/** validate-fncalls.ts / validate-schema-fields.ts — two rows, fresh each row. */
function retiredFreshRow(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = new Array<number>(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    const cur = new Array<number>(n + 1)
    cur[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost)
    }
    prev = cur
  }
  return prev[n]!
}

/** utility-registry.ts — two rows, swapped rather than reallocated. */
function retiredSwapRow(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  let cur = new Array<number>(n + 1)
  for (let i = 1; i <= m; i++) {
    cur[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost)
    }
    ;[prev, cur] = [cur, prev]
  }
  return prev[n]!
}

/** preset-expand.ts — one row updated in place, carrying the diagonal by hand. */
function retiredInPlace(a: string, b: string): number {
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!
    dp[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j]!, dp[j - 1]!)
      prev = tmp
    }
  }
  return dp[b.length]!
}

// ── The corpus ────────────────────────────────────────────────────────────

/** Pairs the real call sites actually pass — a helper's own vocabulary is not
 *  evidence about its callers (§12: stand at least one case on a real literal). */
const CALL_SITE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['sqrrt', 'sqrt'], // validate-fncalls.ts — the #1066 motivating typo
  ['speeed', 'speed'], // validate-schema-fields.ts — the #1537 motivating typo
  ['opacty', 'opacity'], // utility-registry.ts — asserted in utility-registry.test.ts
  ['colr', 'fill'], // utility-registry.ts — a head that matches nothing closely
  ['frobnicate', 'floor'], // the noise case every threshold exists to reject
  ['hilite', 'highlight'], // preset-expand.ts — an author-chosen preset name
]

/** Inputs chosen to reach each shape's own branches: the two zero-length early
 *  returns, both length orders, the equal-string diagonal, and a transposition
 *  (Levenshtein says 2 — a decoy that reddens if anyone swaps in Damerau). */
const EDGE_STRINGS: readonly string[] = [
  '',
  'a',
  'ab',
  'ba',
  'abc',
  'abcd',
  'abcde',
  'kitten',
  'sitting',
  'aaaaaaaa',
  'x',
  'stroke-dashoffset',
  '🌍',
  '🌍🌏',
]

describe('#2534 — the survivor computes what all three retired shapes computed', () => {
  const pairs: Array<readonly [string, string]> = [...CALL_SITE_PAIRS]
  for (const a of EDGE_STRINGS) for (const b of EDGE_STRINGS) pairs.push([a, b])

  it('agrees with the fresh-row shape on every pair', () => {
    for (const [a, b] of pairs) {
      expect(`${a}|${b} -> ${editDistance(a, b)}`).toBe(`${a}|${b} -> ${retiredFreshRow(a, b)}`)
    }
  })

  it('agrees with the buffer-swap shape on every pair', () => {
    for (const [a, b] of pairs) {
      expect(`${a}|${b} -> ${editDistance(a, b)}`).toBe(`${a}|${b} -> ${retiredSwapRow(a, b)}`)
    }
  })

  it('agrees with the in-place shape on every pair', () => {
    for (const [a, b] of pairs) {
      expect(`${a}|${b} -> ${editDistance(a, b)}`).toBe(`${a}|${b} -> ${retiredInPlace(a, b)}`)
    }
  })

  it('is Levenshtein, not Damerau — a transposition costs 2', () => {
    expect(editDistance('ab', 'ba')).toBe(2)
    expect(editDistance('kitten', 'sitting')).toBe(3)
    expect(editDistance('sqrrt', 'sqrt')).toBe(1)
  })

  it('is symmetric and zero only on equality', () => {
    for (const a of EDGE_STRINGS) {
      expect(editDistance(a, a)).toBe(0)
      for (const b of EDGE_STRINGS) expect(editDistance(a, b)).toBe(editDistance(b, a))
    }
  })
})

describe('#2534 — nearestByEditDistance keeps the scan semantics the sites had', () => {
  it('returns the nearest candidate within the threshold', () => {
    expect(nearestByEditDistance('sqrrt', ['floor', 'sqrt', 'step'], 2)).toBe('sqrt')
  })

  it('returns null when the nearest is farther than the threshold', () => {
    expect(nearestByEditDistance('frobnicate', ['floor', 'sqrt', 'step'], 2)).toBeNull()
  })

  it('accepts a candidate exactly at the threshold', () => {
    expect(nearestByEditDistance('ab', ['ba'], 2)).toBe('ba')
    expect(nearestByEditDistance('ab', ['ba'], 1)).toBeNull()
  })

  it('breaks ties on iteration order, as all four scans did with their strict `<`', () => {
    expect(nearestByEditDistance('ax', ['bx', 'cx'], 1)).toBe('bx')
    expect(nearestByEditDistance('ax', ['cx', 'bx'], 1)).toBe('cx')
  })

  it('returns null for an empty candidate set rather than throwing', () => {
    expect(nearestByEditDistance('anything', [], 99)).toBeNull()
  })
})

describe('#2534 ratchet — one edit-distance kernel in compiler/src/ir', () => {
  // The Coccinelle move (ADR-0013 decision 3): the semantic patch stays in the
  // tree, so the fifth "did you mean …?" site imports the helper instead of
  // growing a fifth copy. KNOWN LIMIT: this keys on the two names the copies
  // actually used. A kernel reintroduced under a third name with a different
  // body shape is Type-4, and CLAUDE.md §14 records that no detector in this
  // repo finds that class — review is the lever there, not this test.
  const KERNEL_RE = /function\s+(levenshtein|editDistance)\b/

  it('no file but edit-distance.ts declares a kernel', () => {
    const dir = dirname(fileURLToPath(import.meta.url))
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && f !== 'edit-distance.ts')
      .filter((f) => KERNEL_RE.test(readFileSync(join(dir, f), 'utf8')))
    expect(
      offenders,
      'import `editDistance` / `nearestByEditDistance` from ./edit-distance rather than ' +
        'adding a fifth private kernel (#2534)',
    ).toEqual([])
  })
})
