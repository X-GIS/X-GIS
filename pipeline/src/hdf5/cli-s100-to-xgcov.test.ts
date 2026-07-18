// ═══ s100-to-xgcov CLI contract (#1158 GAP-1 INC-A / A6) ═══
//
// Drives the offline converter as a real process (bun) and asserts its I/O
// contract: --out is REQUIRED (non-zero exit), the artifact goes ONLY to --out
// (never stdout), stdout is the human summary, the written file decodes back to a
// valid coverage, and a reader error exits non-zero. skipIf(no bun) so the node-
// only CI leg still passes.

import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
// The codec's canonical home is @xgis/data; imported via the barrel-free '@xgis/data/coverage'
// subpath (pipeline's @xgis/data devDependency). A relative reach into ../../../data/src is
// outside pipeline's rootDir and fails `tsc --build` (TS6059/TS6307); the barrel is unusable
// by the bun subprocess this test spawns (its Vite `?worker` imports don't load under bun).
import { decodeCoverage } from '@xgis/data/coverage'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOOL = join(HERE, '..', '..', 'tools', 's100-to-xgcov.ts')
const FIX = join(HERE, '__fixtures__', 'sb_v0_symtab.h5')
const ASYM = join(HERE, '__fixtures__', 'asym_southflip.h5')
function golden(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(HERE, '__fixtures__', name + '.json'), 'utf8'))
}
function decodeOut(path: string): ReturnType<typeof decodeCoverage> {
  const b = readFileSync(path)
  return decodeCoverage(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
}

function hasBun(): boolean {
  try {
    execFileSync('bun', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
function run(args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('bun', [TOOL, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

describe.skipIf(!hasBun())('s100-to-xgcov CLI (A6)', () => {
  it('--out is REQUIRED: omitting it exits non-zero with a stderr error', () => {
    const r = run([FIX])
    expect(r.code).not.toBe(0)
    expect(r.stderr).toMatch(/--out .*REQUIRED/)
    expect(r.stdout).toBe('') // NEVER any artifact/summary on the error path
  })

  it('converts a fixture: summary to stdout, artifact to --out, decodes back', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'xgcov-')), 'chart.xgcov')
    const r = run([FIX, '--out', out])
    expect(r.code).toBe(0)
    // stdout is the HUMAN summary — product, grid, bands, datum, byte size.
    expect(r.stdout).toMatch(/product:\s+s102/)
    expect(r.stdout).toMatch(/grid:\s+4 × 3/)
    expect(r.stdout).toMatch(/vertical datum: code 12 \(sign down\)/)
    expect(r.stdout).toMatch(/wrote:.*\(\d+ bytes\)/) // stat-verified size
    // the artifact was actually written (exit 0 ≠ file written) and decodes.
    expect(existsSync(out)).toBe(true)
    const handle = await decodeOut(out)
    expect(handle.header.product).toBe('s102')
    expect(handle.header.size).toEqual([4, 3])
    // (the south→north-up flip is gated cell-by-cell end-to-end in the next test)
  })

  it('south→north-up flip is gated end-to-end: decoded grid == depth_north_up golden', async () => {
    // Convert the ASYMMETRIC fixture (distinct per cell, SE = nodata) and assert the
    // decoded .xgcov grid equals the h5py golden's north-up array cell-by-cell. This is
    // the load-bearing gate the CLI lacked: replacing the converter's southFirstToNorthUp
    // with the identity (or swapping its args) FAILS here — the old `valueAt === values[idx]`
    // check was a tautology (both sides read the same array) and passed regardless.
    const g = golden('asym_southflip')
    const nLon = g.nLon as number
    const nLat = g.nLat as number
    const expected = (g.depth_north_up as number[][]).flat()
    const out = join(mkdtempSync(join(tmpdir(), 'xgcov-')), 'asym.xgcov')
    const r = run([ASYM, '--out', out])
    expect(r.code).toBe(0)
    const handle = await decodeOut(out)
    expect(handle.header.size).toEqual([nLon, nLat])
    const v = handle.band(0).values
    expect(v.length).toBe(expected.length)
    for (let i = 0; i < expected.length; i++) {
      if (expected[i] === (g.fillValue as number)) expect(Number.isNaN(v[i]!)).toBe(true)
      else expect(v[i]).toBeCloseTo(expected[i]!, 5)
    }
  })

  it('a reader error (out-of-subset construct) exits non-zero', () => {
    const bad = join(HERE, '__fixtures__', 'neg_v3_latest.h5')
    const out = join(mkdtempSync(join(tmpdir(), 'xgcov-')), 'x.xgcov')
    const r = run([bad, '--out', out])
    expect(r.code).not.toBe(0)
    expect(r.stderr).toMatch(/superblock version 3/)
  })
})
