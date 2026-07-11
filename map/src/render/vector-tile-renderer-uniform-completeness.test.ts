// ═══ VTR frameBlock completeness gate — every polygonU field is written (#999) ═══
//
// UniformBlock's contract (engine/src/render/uniform-block.ts): call `write({…})`
// once per frame to establish a COMPLETE buffer — completeness enforced by tsc,
// because UniformValues<F> is a mapped type with no optional members — then patch
// hot fields via `set.*`. VTR does NOT call `write()`: it constructs
// `frameBlock = uniformBlock(polygonU)` and only ever `set.*`s individual fields.
//
// That skips the compile-time completeness net. Add a field to `polygonU` and:
//   • renderer.ts / graticule-renderer.ts (which DO `B.write({…})`) fail to compile
//     until they supply the new field — the drift is caught;
//   • VTR compiles fine and silently leaves the new field 0/stale in every tile
//     draw — the exact #600 (globe_eye) failure mode, where a shared uniform grew
//     a field and one writer missed it.
//
// tsc can't gate VTR here (a partial `set.*` sequence is legal by design — that's
// the hot-loop surface). So this test is the completeness net VTR opted out of:
// the authoritative field list is read at RUNTIME from the reflected block
// (`Object.keys(uniformBlock(polygonU).set)`), and every field must be written by
// VTR — as `.set.<field>` (today's pattern) OR as a `.write({…})` object key (so
// the gate still holds if VTR later adopts the write() discipline) — unless it is
// an explicit, safe-to-be-zero OMISSION (std140 padding). A new unwritten field
// fails HERE, loudly, instead of going dark on-GPU.
//
// GPU-free (static source scan + CPU reflect); rides the `test (map)` CI leg.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { uniformBlock } from '@xgis/engine'
import { polygonU } from '../shaders/dsl/polygon'

const VTR = join(dirname(fileURLToPath(import.meta.url)), 'vector-tile-renderer.ts')
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

// Fields VTR legitimately does NOT write per frame, with the reason each is
// safe-to-be-zero. ONLY std140 padding belongs here — a lane the shader never
// reads, kept 0 by ArrayBuffer init. A real (shader-read) field must be written,
// never parked here. Adding a field to polygonU forces a choice: write it in VTR,
// or justify it here — the same "no silent omission" discipline write() enforces.
const OMITTED: Record<string, string> = {
  _pad_light_align:
    'std140 alignment padding (u32) — fills the 8-byte pad before cam_ecef_off_h; ' +
    'never read by any polygon shader, kept 0 by ArrayBuffer init (polygon.ts:137)',
}

describe('VTR frameBlock writes every polygonU field (#999, #600 completeness class)', () => {
  const allFields = Object.keys(uniformBlock(polygonU).set)
  const src = stripComments(readFileSync(VTR, 'utf8'))
  // Written = patched via `.set.<field>` (receiver-agnostic: `this.frameBlock` and
  // the local `B = this.frameBlock` alias both), OR supplied as a `.write({…})`
  // object key (VTR has none today — future-proofs the gate against a write() port).
  const written = new Set<string>([...src.matchAll(/\.set\.(\w+)/g)].map((m) => m[1]!))
  for (const block of src.matchAll(/\.write\(\{([\s\S]*?)\}\)/g))
    for (const k of block[1]!.matchAll(/(\w+)\s*:/g)) written.add(k[1]!)

  it('no polygonU field is left unwritten (silent-zero on-GPU otherwise)', () => {
    const uncovered = allFields.filter((f) => !written.has(f) && !(f in OMITTED))
    expect(
      uncovered,
      'VTR builds frameBlock = uniformBlock(polygonU) and never calls write(), so these ' +
        'polygonU fields are written by NO .set.* / .write() in vector-tile-renderer.ts — ' +
        'each renders as a silent 0 (the #600 globe_eye class). Write it per frame, or (only ' +
        `if it is padding the shader never reads) add it to OMITTED with a rationale:\n${uncovered.join('\n')}`,
    ).toEqual([])
  })

  it('no OMITTED entry is stale — the #996 vacuity guard', () => {
    // A padding entry that no longer exists in polygonU, or that VTR now actually
    // writes, is dead allowlist — it must be pruned, not left masking a real gap.
    const stale = Object.keys(OMITTED)
      .filter((f) => !allFields.includes(f) || written.has(f))
      .map((f) =>
        !allFields.includes(f)
          ? `${f} — not in polygonU anymore; delete this OMITTED entry`
          : `${f} — VTR now writes it; delete this OMITTED entry (it no longer omits anything)`,
      )
    expect(stale, stale.join('\n')).toEqual([])
  })

  it('the gate is non-vacuous — the load-bearing fields are present AND written', () => {
    // Guards a broken scan / rename silently emptying the coverage set (a green-but-
    // meaningless gate — the #996 lesson). globe_eye is the field #600 was about.
    for (const f of [
      'globe_eye',
      'cam_ecef_off_h',
      'cam_ecef_off_l',
      'light_dir_ecef',
      'pick_id',
    ]) {
      expect(allFields.includes(f), `expected '${f}' in polygonU`).toBe(true)
      expect(written.has(f), `expected VTR to write '${f}'`).toBe(true)
    }
    expect(allFields.length).toBeGreaterThanOrEqual(26)
    expect(written.size).toBeGreaterThanOrEqual(24)
  })
})
