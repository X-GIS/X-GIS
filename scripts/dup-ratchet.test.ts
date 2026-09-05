// ═══ The duplication ratchet must DISTINGUISH — new copy red, stale entry red, clean green ═══
//
// CLAUDE.md §12: an assertion carries information only if it distinguishes the states of the
// thing it tests, and "cut the specific mechanism and confirm the message names the severed
// half". So the real jscpd binary runs here against a fixture on disk and the ladder is
// walked end to end: two copies → one clone; baseline it → zero new; a THIRD copy → one new
// (the rule-of-three moment the gate exists for); delete the copies → the baseline entry is
// stale. The pure helpers (baseline diff, clone classes, clustering, marker check) get their
// own cases because the report and the gate's verdict are built from them.
//
// The fixture is a 14-line function (~150 tokens) so it stays a clone if `.jscpd.json`'s
// minTokens is raised later — the ladder pins the COMMITTED config, not a private one.

import { describe, it, expect } from 'vitest'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  IGNORE,
  bareMarkers,
  classify,
  clusterClones,
  diffBaseline,
  scan,
  type Clone,
} from './dup-ratchet.js'

const clone = (
  a: string,
  as: number,
  ae: number,
  b: string,
  bs: number,
  be: number,
  lines = ae - as + 1,
): Clone => ({
  a: { file: a, start: as, end: ae },
  b: { file: b, start: bs, end: be },
  lines,
  tokens: lines * 8,
  isNew: true,
})

describe('diffBaseline — what entered and what left', () => {
  it('reports added (new clones) and removed (stale entries) as sorted fingerprint lists', () => {
    const committed = { version: 1, fingerprints: { a1: 1, b2: 1 } }
    const current = { version: 1, fingerprints: { b2: 1, c3: 1, a0: 1 } }
    expect(diffBaseline(committed, current)).toEqual({ added: ['a0', 'c3'], removed: ['a1'] })
  })
  it('is empty both ways when nothing changed', () => {
    const b = { version: 1, fingerprints: { a1: 1 } }
    expect(diffBaseline(b, { ...b })).toEqual({ added: [], removed: [] })
  })
})

describe('classify — the four remedy classes', () => {
  it('same file → intra-file', () => {
    expect(classify(clone('map/src/map.ts', 1, 9, 'map/src/map.ts', 40, 48))).toBe('intra-file')
  })
  it('same directory → intra-dir (a sibling family)', () => {
    expect(classify(clone('map/src/graphics/a.ts', 1, 9, 'map/src/graphics/b.ts', 1, 9))).toBe(
      'intra-dir',
    )
  })
  it('same workspace, different directory → intra-workspace', () => {
    expect(classify(clone('data/src/sources/x.ts', 1, 9, 'data/src/workers/y.ts', 1, 9))).toBe(
      'intra-workspace',
    )
  })
  it('different workspaces → cross-workspace', () => {
    expect(classify(clone('geo/src/globe.ts', 1, 9, 'shared/src/mat4.ts', 1, 9))).toBe(
      'cross-workspace',
    )
  })
})

describe('clusterClones — pairs become copies', () => {
  it('three pairwise clones of one fragment are ONE cluster of three copies', () => {
    const cs = [
      clone('p/a.ts', 1, 20, 'p/b.ts', 1, 20),
      clone('p/a.ts', 1, 20, 'p/c.ts', 5, 24),
      clone('p/b.ts', 1, 20, 'p/c.ts', 5, 24),
    ]
    const [c, ...rest] = clusterClones(cs)
    expect(rest).toEqual([])
    expect(c).toMatchObject({ copies: 3, clones: 3, dupLines: 60 })
    expect([...c!.files.keys()]).toEqual(['p/a.ts', 'p/b.ts', 'p/c.ts'])
  })
  it('overlapping ranges in the same file join the cluster; disjoint pairs stay apart', () => {
    const cs = [
      clone('p/x.ts', 1, 20, 'p/y.ts', 1, 20),
      clone('p/x.ts', 10, 30, 'p/z.ts', 5, 25),
      clone('q/m.ts', 1, 8, 'q/n.ts', 1, 8),
    ]
    const clusters = clusterClones(cs)
    expect(clusters.map((c) => c.copies)).toEqual([4, 2])
    expect([...clusters[0]!.files.get('p/x.ts')!]).toEqual(['1-20', '10-30'])
  })
})

describe('bareMarkers — an intentional twin carries its reason', () => {
  it('flags a marker with nothing after it, or only punctuation', () => {
    const files: Array<[string, string]> = [
      ['a.ts', 'x\n// jscpd:ignore-start\nfoo()\n// jscpd:ignore-end'],
      ['b.ts', '// jscpd:ignore-start —  \nfoo()'],
    ]
    expect(bareMarkers(files)).toEqual(['a.ts:2', 'b.ts:1'])
  })
  it('accepts a marker with a reason on the same line', () => {
    const files: Array<[string, string]> = [
      ['c.ts', '// jscpd:ignore-start — WebGL2/WebGPU twin kept apart on purpose (#2165)\n'],
    ]
    expect(bareMarkers(files)).toEqual([])
  })
})

// ── The ladder, against the real binary and the committed .jscpd.json ──────────

const FIXTURE_FN = `export function fixtureFn(a: number, b: number, c: number): number {
  const s = a + b
  const t = s * c
  const u = t - a
  const v = u / (b || 1)
  const w = Math.sqrt(Math.abs(v))
  const x = Math.floor(w * 1000)
  const y = x % 7 === 0 ? x / 7 : x * 3 + 1
  const z = Math.max(y, s, t, u)
  const arr = [s, t, u, v, w, x, y, z]
  let acc = 0
  for (let i = 0; i < arr.length; i++) acc += arr[i]! * (i + 1)
  return acc + x + s + t + u
}
`

describe('scan — the gate ladder on a fixture tree (real jscpd)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dup-ladder-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'a.ts'), FIXTURE_FN)
  writeFileSync(join(root, 'src', 'b.ts'), FIXTURE_FN)
  const baseline = join(root, 'baseline.json')
  const opts = { root, roots: ['src'], ignore: IGNORE }

  it('two copies are one clone, repo-relative, above the committed token floor', () => {
    const { clones, stats } = scan(opts)
    expect(clones).toHaveLength(1)
    expect(clones[0]).toMatchObject({ a: { file: 'src/a.ts' }, b: { file: 'src/b.ts' } })
    expect(clones[0]!.tokens).toBeGreaterThanOrEqual(70)
    expect(classify(clones[0]!)).toBe('intra-dir')
    expect(stats.files).toBe(2)
  })

  it('once baselined the same clone is not new; a THIRD copy is', () => {
    scan({ ...opts, baseline, updateBaseline: true })
    expect(scan({ ...opts, baseline }).clones.map((c) => c.isNew)).toEqual([false])

    writeFileSync(join(root, 'src', 'c.ts'), FIXTURE_FN)
    const third = scan({ ...opts, baseline })
    expect(third.clones.filter((c) => c.isNew).length).toBeGreaterThan(0)
    expect(third.clones.some((c) => c.a.file === 'src/c.ts' || c.b.file === 'src/c.ts')).toBe(true)
  })

  it('deleting the copies leaves the baseline entry stale, which the diff reports', () => {
    rmSync(join(root, 'src', 'b.ts'))
    rmSync(join(root, 'src', 'c.ts'))
    const tmp = join(root, 'baseline-rescan.json')
    copyFileSync(baseline, tmp)
    const { clones } = scan({ ...opts, baseline: tmp, updateBaseline: true })
    expect(clones).toEqual([])
    const read = (p: string) =>
      JSON.parse(readFileSync(p, 'utf8')) as Parameters<typeof diffBaseline>[0]
    const d = diffBaseline(read(baseline), read(tmp))
    expect(d.added).toEqual([])
    expect(d.removed).toHaveLength(1)
  })
})
