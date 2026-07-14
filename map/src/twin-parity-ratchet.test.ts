// ═══ Twin-parity pixel ratchet — chain-vs-twin DC shrink-only (#1046 F3-F4) ═══
//
// The twin-frame program (doc §6.3) drives a per-fixture HIGH-WATER DC (differing-
// pixel count) of the unified WebGL2 chain (`?rhichain=1`) vs the forced-WebGL2 twin
// at identical cameras DOWN to zero; zero on every fixture is F4's precondition to
// flip the WebGL2 default onto the chain. The DC is a real-GPU measurement, so the
// SHRINK-ONLY assertion (measured DC <= high-water) lives in the e2e capture spec
// (playground/e2e/_twin-parity-ratchet.spec.ts), which is the only place the pixels
// exist. THIS vitest gate is the source-fact half — it rides the `test (map)` CI leg
// and locks the high-water FILE's shape + vacuity so the ratchet can never rot:
//
//   • every canonical F3 fixture (doc §3-F3 matrix) is present — exactly, no more, no
//     fewer (a dropped fixture silently stops tracking a regression; #996 vacuity),
//   • every value is `null` (NOT YET MEASURED — skipped, the orchestrator seeds it
//     from the first capture run) or a non-negative integer (a shrink-only DC),
//   • the shrink-only discipline is documented at the declaration.
//
// This mirrors the loc-ceiling / backend-identity ratchets: vitest validates the
// committed fact, humans/the orchestrator LOWER the number as captures improve.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// The doc §3-F3 fixture matrix, one key per (fixture × projection) capture. Kept in
// lockstep with the high-water file's `fixtures` keys AND the e2e spec's FIXTURES.
const CANONICAL_FIXTURES = [
  'minimal',
  'ofm_bright_local_flat',
  'ofm_bright_local_globe',
  'dashed_lines',
  'fixture_line_image_pattern',
  'fixture_translucent_outline',
] as const

const HIGH_WATER_PATH = join(dirname(fileURLToPath(import.meta.url)), 'twin-parity-highwater.json')

interface HighWater {
  fixtures: Record<string, number | null>
}

function readHighWater(): HighWater {
  return JSON.parse(readFileSync(HIGH_WATER_PATH, 'utf8')) as HighWater
}

describe('twin-parity ratchet: chain-vs-twin DC high-water file is well-formed (#1046 F3)', () => {
  it('the canonical fixture matrix is non-empty (not vacuous — #996)', () => {
    // A gate that walks an empty matrix is vacuously green; pin the count so a future
    // edit that empties CANONICAL_FIXTURES fails loudly here.
    expect(CANONICAL_FIXTURES.length).toBe(6)
  })

  it('the high-water file lists EXACTLY the canonical fixtures (no fixture silently dropped/added)', () => {
    const keys = Object.keys(readHighWater().fixtures).sort()
    expect(keys, 'high-water fixtures must match the doc §3-F3 matrix exactly').toEqual(
      [...CANONICAL_FIXTURES].sort(),
    )
  })

  it('every high-water value is null (not yet measured — skipped) or a non-negative integer DC', () => {
    const { fixtures } = readHighWater()
    const bad: string[] = []
    for (const fx of CANONICAL_FIXTURES) {
      const v = fixtures[fx]
      if (v === null) continue // NOT YET MEASURED — the orchestrator seeds from the first capture
      if (!Number.isInteger(v) || v < 0)
        bad.push(
          `${fx}: ${v} — a high-water DC must be null (unmeasured) or a non-negative integer`,
        )
    }
    expect(bad, bad.join('\n')).toEqual([])
  })

  it('SHRINK-ONLY discipline: measured DC <= high-water is enforced by the e2e capture spec', () => {
    // Documents the split: the live pixel assertion (measured DC <= high-water, and DC
    // trending to zero for F4) lives in playground/e2e/_twin-parity-ratchet.spec.ts,
    // which captures ?rhichain=1 vs the twin on a real GPU. This vitest gate cannot
    // measure pixels; it locks the FILE (above). A null entry means the chain has not
    // yet been captured against the twin for that fixture (F3 remaining) — expected
    // while the pass bodies retype to the RHI encoder.
    const { fixtures } = readHighWater()
    const measured = CANONICAL_FIXTURES.filter((fx) => fixtures[fx] !== null)
    const pending = CANONICAL_FIXTURES.filter((fx) => fixtures[fx] === null)
    // Purely informational — the assertion is the well-formedness above. Log the state
    // so a CI reader sees how far the port has advanced.
    console.log(
      `[twin-parity] measured=${measured.length}/${CANONICAL_FIXTURES.length} ` +
        `pending(null)=${pending.join(',') || 'none'}`,
    )
    expect(measured.length + pending.length).toBe(CANONICAL_FIXTURES.length)
  })
})
