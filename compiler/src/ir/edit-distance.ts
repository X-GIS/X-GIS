// ═══ Edit distance — the one kernel for compiler/src/ir's "did you mean …?" ═══
//
// Four diagnostics in this directory suggest a near-miss name for an unknown
// identifier, and before this module each owned a private Levenshtein: three
// spellings (two-row with a fresh row, two-row with a buffer swap, one row in
// place) under two names (`levenshtein`, `editDistance`). They computed the
// same function, so the copies were four authorities for one fact — and because
// two of them differ in name and shape, `bun run dup` could never see it: this
// is the Type-4 class CLAUDE.md §14 records as the gate's documented blind spot.
//
// What did NOT move is the acceptance threshold. Each site tunes its own
// (`≤ 2 / ≤ 1` by name length, `max(2, ⌈len/3⌉)`, a flat `≤ 3`), those tunings
// are real diagnostic policy, and folding them into one number would change
// what four error messages suggest. The threshold stays with the caller.

/**
 * Levenshtein edit distance between `a` and `b`: the fewest single-character
 * insertions, deletions and substitutions that turn one into the other, each
 * costing 1.
 *
 * Two rows of the DP matrix, swapped rather than reallocated — O(min work) for
 * the short identifiers this serves, and the textbook form, since none of the
 * callers is on a hot path (they run only while building an error).
 */
export function editDistance(a: string, b: string): number {
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

/**
 * The candidate nearest to `name`, or `null` when even the nearest is farther
 * than `maxDistance` — a distant match is noise, not a typo, and a diagnostic
 * is better with no `help` than with a wrong one.
 *
 * Ties go to the first candidate in iteration order, which is what all four
 * call sites did (each scanned with a strict `<`).
 */
export function nearestByEditDistance(
  name: string,
  candidates: Iterable<string>,
  maxDistance: number,
): string | null {
  let best: string | null = null
  let bestDist = Infinity
  for (const candidate of candidates) {
    const d = editDistance(name, candidate)
    if (d < bestDist) {
      bestDist = d
      best = candidate
    }
  }
  return best !== null && bestDist <= maxDistance ? best : null
}
