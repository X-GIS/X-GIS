// ═══ The duplication gate must DISTINGUISH — a copy this branch adds is red, main's is not ═══
//
// CLAUDE.md §12: an assertion carries information only if it distinguishes the states of the
// thing it tests, and "cut the specific mechanism and confirm the message names the severed
// half". So the real jscpd binary runs here against a real git fixture and the ladder is
// walked end to end: a base commit that already contains a clone pair; the same tree scanned
// against that base reports nothing new; a THIRD copy added on top is reported new and named
// — which is the rule-of-three moment the gate exists for.
//
// The fixture is a git repo, not a directory, because the base is a REF: the mechanism under
// test is `--baseline-from-ref`, and a test that faked the base would be testing nothing.
// `resolveBaseRef` gets the case that matters for safety — a repo with no `origin/main` must
// THROW, never return a base that silently marks every clone new (or none).
//
// The fixture function is ~170 tokens so it stays a clone if `.jscpd.json`'s minTokens is
// raised later — the ladder pins the COMMITTED config, not a private one.

import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  IGNORE,
  bareMarkers,
  classify,
  clusterClones,
  resolveBaseRef,
  scan,
  shapeOnlyClones,
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

describe('shapeOnlyClones — the two noise classes the shape lens must discard', () => {
  // Every fragment below is read out of these two synthetic "shaped" files.
  const TABLE = Array.from({ length: 40 }, () => '_: "S",').join('\n')
  const CODE = Array.from(
    { length: 40 },
    (_, i) => `const _ = _(${i % 7}) + _.${'x'.repeat((i % 5) + 1)}`,
  ).join('\n')
  const read = (f: string): string => (f === 'table.ts' ? TABLE : CODE)

  it('drops a clone the token pass already reports', () => {
    const c = clone('code.ts', 1, 20, 'code.ts', 21, 40)
    expect(shapeOnlyClones([c], [c], read)).toEqual([])
  })

  it('drops one the token pass reports at a SHIFTED start — same finding, re-anchored', () => {
    // Erasing identifiers changes the token stream, so jscpd re-anchors the match a few
    // lines either way. Keying the subtraction on the start line (the first implementation)
    // let 54 clones / 1276 lines back in as "invisible to the gate" when the gate had
    // already flagged that file pair; overlap is the rule that distinguishes.
    const shaped = clone('code.ts', 3, 22, 'code.ts', 23, 42)
    const token = clone('code.ts', 1, 20, 'code.ts', 21, 40)
    expect(shapeOnlyClones([shaped], [token], read)).toEqual([])
  })

  it('keeps one on a file pair the token pass flags ELSEWHERE — a different finding', () => {
    const shaped = clone('code.ts', 1, 15, 'code.ts', 21, 35)
    const elsewhere = clone('code.ts', 60, 79, 'code.ts', 90, 109)
    expect(shapeOnlyClones([shaped], [elsewhere], read)).toEqual([shaped])
  })

  it('drops a region matching ITSELF a few entries along — a list, not a copy', () => {
    // colors.ts:5-277 ~ :18-290 was the real one: a 270-row table, overlapping ranges.
    expect(shapeOnlyClones([clone('code.ts', 1, 30, 'code.ts', 5, 34)], [], read)).toEqual([])
  })

  it('drops a uniform data table — every row shapes to the same text', () => {
    expect(shapeOnlyClones([clone('table.ts', 1, 20, 'table.ts', 21, 40)], [], read)).toEqual([])
  })

  it('keeps a structurally varied clone the token pass never saw', () => {
    const c = clone('code.ts', 1, 15, 'code.ts', 21, 35)
    expect(shapeOnlyClones([c], [], read)).toEqual([c])
  })
})

describe('resolveBaseRef — a lost base is loud, never silent', () => {
  it('throws in a repo with no reachable origin/main', () => {
    const root = mkdtempSync(join(tmpdir(), 'dup-nobase-'))
    git(root, 'init', '--quiet')
    expect(() => resolveBaseRef(root)).toThrow(/origin\/main/)
  })
})

// ── The ladder, against the real binary, the committed .jscpd.json, and a real ref ─────

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

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

describe('scan against a base ref (real jscpd, real git)', () => {
  // Base commit already carries the a↔b clone: the debt the branch inherits, not its doing.
  const root = mkdtempSync(join(tmpdir(), 'dup-ladder-'))
  git(root, 'init', '--quiet')
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'a.ts'), FIXTURE_FN)
  writeFileSync(join(root, 'src', 'b.ts'), FIXTURE_FN)
  git(root, 'add', '-A')
  git(root, 'commit', '--quiet', '-m', 'base')
  const base = git(root, 'rev-parse', 'HEAD')
  const opts = { root, roots: ['src'], ignore: IGNORE }

  it('the clone the base already has is found, and is NOT new', () => {
    const { clones, stats } = scan({ ...opts, baseRef: base })
    expect(clones).toHaveLength(1)
    expect(clones[0]).toMatchObject({ a: { file: 'src/a.ts' }, b: { file: 'src/b.ts' } })
    expect(clones[0]!.tokens).toBeGreaterThanOrEqual(70)
    expect(clones[0]!.isNew).toBe(false)
    expect(classify(clones[0]!)).toBe('intra-dir')
    expect(stats.files).toBe(2)
  })

  it('a THIRD copy added on top of the base IS new, and names the file that added it', () => {
    writeFileSync(join(root, 'src', 'c.ts'), FIXTURE_FN)
    const fresh = scan({ ...opts, baseRef: base }).clones.filter((c) => c.isNew)
    expect(fresh.length).toBeGreaterThan(0)
    expect(fresh.every((c) => c.a.file === 'src/c.ts' || c.b.file === 'src/c.ts')).toBe(true)
  })

  it('once the base itself carries the third copy, nothing is new again', () => {
    git(root, 'add', '-A')
    git(root, 'commit', '--quiet', '-m', 'third copy lands on the base')
    const moved = git(root, 'rev-parse', 'HEAD')
    expect(scan({ ...opts, baseRef: moved }).clones.filter((c) => c.isNew)).toEqual([])
  })
})
