// ═══ A shard family that is missing a leg reports GREEN (#1899) ═══
//
// `--shard=k/N` is how this workflow splits both the vitest matrix (`map/src --shard=1/5`
// … `5/5`, `shader-dsl --shard=1/2` … `2/2`) and, since #1899, the render gate
// (`--shard=${{ matrix.shard }}/4`). The partition is only "deterministic, disjoint and
// COMPLETE" — the `test` job's own playbook comment — while the numerators actually cover
// 1..N. Nothing made them.
//
// The failure is silent in exactly the direction that matters. Delete the `map-e` leg and
// leave `/5` on the other four: a fifth of `map/src`'s 471 files is never run, four legs
// pass, `test-result` aggregates four successes, and the PR is green. Add a leg past N and
// it errors loudly instead — the harmless direction.
//
// MEASURED, and this is why the silent direction stays silent even at runtime: a Playwright
// run whose shard matches ZERO tests exits **0** and prints nothing at all — no summary, no
// "Running N tests" header. `render-shard` carries a runtime guard for that (it greps the
// header), but an EMPTY shard is not this bug: an unclaimed shard is one nobody asked for,
// so no job runs it, so nothing is empty and nothing complains.
//
// So the invariant is asserted statically, where it costs milliseconds: for every
// denominator N in a shard family, the numerators are exactly 1..N.
//
// A NEW invariant, checked against the existing gates first (CLAUDE.md §12's second-ratchet
// lesson): `workflow-validity.test.ts` owns expression well-formedness and cache-key
// symmetry, `post-merge-guard.test.ts` owns the `push: main` guard's structure, and
// `paths-filter-semantics.test.ts` owns the `changes` filter. None of them can see this.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const WORKFLOW = join(ROOT, '.github/workflows/test.yml')

type Workflow = {
  readonly jobs: Readonly<
    Record<string, { readonly strategy?: { readonly matrix?: Record<string, unknown> } }>
  >
}

/** A `--shard=k/N` whose numerator is a LITERAL leg number. */
export interface LiteralShard {
  readonly k: number
  readonly n: number
}
/** A `--shard=${{ matrix.<key> }}/N` — the numerator comes from a matrix axis. */
export interface MatrixShard {
  readonly axis: string
  readonly n: number
}

/** Every string VALUE in the parsed workflow, at any depth.
 *
 *  Deliberately the parsed tree and not the raw file: a YAML comment is prose, not a
 *  command, and the `test` job's playbook comment literally reads "bump to
 *  `--shard=1/6..6/6`". Scanning raw text read that as a real one-leg `/6` family and
 *  reported a hole that does not exist — the population, not the assertion, was wrong. */
export function stringValues(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') out.push(node)
  else if (Array.isArray(node)) for (const v of node) stringValues(v, out)
  else if (node !== null && typeof node === 'object')
    for (const v of Object.values(node)) stringValues(v, out)
  return out
}

export function scanShards(text: string): {
  literal: LiteralShard[]
  matrix: MatrixShard[]
} {
  const literal: LiteralShard[] = []
  const matrix: MatrixShard[] = []
  for (const m of text.matchAll(/--shard=(\$\{\{\s*matrix\.(\w+)\s*\}\}|\d+)\/(\d+)/g)) {
    const n = Number(m[3])
    if (m[2] !== undefined) matrix.push({ axis: m[2], n })
    else literal.push({ k: Number(m[1]), n })
  }
  return { literal, matrix }
}

const oneToN = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1)

describe('every --shard family in test.yml covers 1..N (#1899)', () => {
  const text = readFileSync(WORKFLOW, 'utf8')
  const wf = parse(text) as Workflow
  const { literal, matrix } = scanShards(stringValues(wf).join('\n'))

  it('found both shard forms — otherwise the arms below are vacuous', () => {
    // #996: a gate whose population silently empties is worse than no gate. The repo
    // uses both spellings today; if either disappears this arm reds rather than the
    // next ones passing over nothing.
    expect(literal.length, 'no literal `--shard=k/N` found in test.yml').toBeGreaterThan(0)
    expect(matrix.length, 'no `--shard=${{ matrix.* }}/N` found in test.yml').toBeGreaterThan(0)
  })

  it('every literal shard family is complete and disjoint', () => {
    const byN = new Map<number, number[]>()
    for (const { k, n } of literal) byN.set(n, [...(byN.get(n) ?? []), k])
    const broken = [...byN]
      .map(([n, ks]) => ({ n, ks: [...ks].sort((a, b) => a - b), want: oneToN(n) }))
      .filter(({ ks, want }) => JSON.stringify(ks) !== JSON.stringify(want))
    expect(
      broken.map((b) => `--shard=?/${b.n}: legs [${b.ks}] but /${b.n} needs [${b.want}]`),
      'a shard family whose numerators are not exactly 1..N does not cover its input. ' +
        'A MISSING leg is the dangerous case: those tests never run and every remaining ' +
        'leg still passes.',
    ).toEqual([])
  })

  it('every matrix-driven shard axis lists exactly 1..N', () => {
    const broken: string[] = []
    for (const { axis, n } of matrix) {
      const owner = Object.entries(wf.jobs).find(
        ([, j]) => j.strategy?.matrix?.[axis] !== undefined,
      )
      if (!owner) {
        broken.push(
          `--shard=\${{ matrix.${axis} }}/${n}: no job declares a \`${axis}\` matrix axis`,
        )
        continue
      }
      const [jobId, job] = owner
      const legs = job.strategy!.matrix![axis] as unknown[]
      if (JSON.stringify(legs) !== JSON.stringify(oneToN(n)))
        broken.push(`${jobId}.matrix.${axis} = [${legs}] but --shard=k/${n} needs [${oneToN(n)}]`)
    }
    expect(
      broken,
      'the matrix leg list and the `--shard` denominator are two numbers in different ' +
        'parts of the file that must agree. A denominator LARGER than the leg count ' +
        'silently drops the unclaimed shards. Change both together.',
    ).toEqual([])
  })
})

describe('the shard scanner distinguishes the states it claims to', () => {
  it('reads the denominator, not the leg index', () => {
    expect(scanShards('--shard=3/7 spec.ts').literal).toEqual([{ k: 3, n: 7 }])
  })

  it('reads a matrix expression without tripping on its braces or spaces', () => {
    expect(scanShards('--shard=${{ matrix.shard }}/4 a.spec.ts').matrix).toEqual([
      { axis: 'shard', n: 4 },
    ])
  })

  it('finds EVERY occurrence, so a second invocation cannot drift unseen', () => {
    const { literal, matrix } = scanShards('--shard=1/4 a\n--shard=${{ matrix.leg }}/2 b')
    expect(literal).toEqual([{ k: 1, n: 4 }])
    expect(matrix).toEqual([{ axis: 'leg', n: 2 }])
  })

  it('ignores prose that mentions the flag without a numeric denominator', () => {
    // The workflow's own comments say things like "`--shard=k/N` partitions the list".
    expect(scanShards('# `--shard=k/N` partitions the EXPLICIT list')).toEqual({
      literal: [],
      matrix: [],
    })
  })

  it('sees nothing when there is no flag', () => {
    expect(scanShards('playwright test a.spec.ts')).toEqual({ literal: [], matrix: [] })
  })
})
