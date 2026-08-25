// ═══ #2042 INC-3 — the Frame/Show/Tile partition of polygonU: exhaustive,
//     disjoint, byte-compatible ═══
//
// INC-4 rebinds the polygon draw from ONE 432-byte block to THREE ranges
// (frameBlockU / showBlockU / tileBlockU). The rebind is safe only if:
//   1. EXHAUSTIVE + DISJOINT — every polygonU field lands in exactly one
//      destination (or is explicitly retiring/pending, with its reason).
//      A field left out reads as silent zeros on-GPU after the rebind —
//      the #600 globe_eye failure class at the architecture level.
//   2. BYTE-COMPATIBLE — a value packed into a destination block is
//      byte-identical to the same value packed into polygonU today (same
//      scalar/vector kind, same u32-raw-word routing). Anything else means
//      the INC-4 shader reads different bytes than the one it replaces.
//
// This gate is pure CPU reflection over the four declarations — no GPU, no
// emission (none of the three new structs is referenced by any shader yet).

import { describe, it, expect } from 'vitest'
import { uniformBlock } from '@xgis/engine'
import { polygonU } from '../shaders/dsl/polygon'
import { tileBlockU } from '../shaders/dsl/tile-block'
import { showBlockU } from '../shaders/dsl/show-block'
import { frameBlockU } from '../shaders/dsl/frame-block'

const fieldsOf = (u: Parameters<typeof uniformBlock>[0]): string[] =>
  Object.keys(uniformBlock(u).set).filter((f) => !f.startsWith('_pad'))

// polygonU fields that deliberately have NO destination:
const RETIRING: Record<string, string> = {
  cam_ecef_off_h:
    'the RTC offset recombines in-VS from tile_ecef_center − cam_ecef_center (INC-1); ' +
    'its spare .w lane (fill-antialias) relocates to ShowBlock.fill_antialias',
  cam_ecef_off_l:
    'recombined with _h; its spare .w lane (fill-extrusion-vertical-gradient) ' +
    'relocates to ShowBlock.fill_vertical_gradient',
}
const PENDING: Record<string, string> = {
  cam_h:
    'per-(tile × camera) Mercator DSFUN rel — deriving it in-VS needs the flat-arm ' +
    'analogue of INC-1 (absolute cam Merc hi/lo in FrameBlock + hi/lo tile origin in ' +
    'TileBlock) with its own precision proof; until that increment it stays ring-staged',
  cam_l: 'hi/lo pair of cam_h — same pending flat-arm recombination',
}
// Destination fields that deliberately have NO polygonU source:
const RELOCATED_INTO_SHOW = new Set(['fill_antialias', 'fill_vertical_gradient'])

describe('#2042 — polygonU → Frame/Show/Tile partition', () => {
  const poly = new Set(fieldsOf(polygonU))
  const tile = fieldsOf(tileBlockU)
  const show = fieldsOf(showBlockU)
  const frame = fieldsOf(frameBlockU)

  it('every polygonU field has exactly ONE destination (or a recorded retirement)', () => {
    const seen = new Map<string, string[]>()
    for (const [name, dest] of [
      ...tile.map((f) => [f, 'tile'] as const),
      ...show.map((f) => [f, 'show'] as const),
      ...frame.map((f) => [f, 'frame'] as const),
    ]) {
      if (!seen.has(name)) seen.set(name, [])
      seen.get(name)!.push(dest)
    }
    const problems: string[] = []
    for (const f of poly) {
      const dests = seen.get(f) ?? []
      const special = f in RETIRING || f in PENDING
      if (dests.length === 0 && !special)
        problems.push(`${f}: NO destination — silent zeros after the INC-4 rebind (#600 class)`)
      if (dests.length > 1) problems.push(`${f}: MULTIPLE destinations (${dests.join(', ')})`)
      if (dests.length > 0 && special)
        problems.push(`${f}: both a destination (${dests.join(', ')}) and a retirement note`)
    }
    for (const name of seen.keys()) {
      if (!poly.has(name) && !RELOCATED_INTO_SHOW.has(name))
        problems.push(
          `${name}: destination field with no polygonU source and no relocation note — ` +
            'either dead weight or a rename that breaks the byte-parity mapping',
        )
    }
    for (const f of Object.keys(RETIRING).concat(Object.keys(PENDING))) {
      if (!poly.has(f))
        problems.push(`${f}: retirement/pending note for a field polygonU no longer has`)
    }
    expect(problems, problems.join('\n')).toEqual([])
    // Non-vacuity: the partition actually covers the struct.
    expect(poly.size).toBeGreaterThanOrEqual(30)
    expect(tile.length + show.length + frame.length).toBeGreaterThanOrEqual(
      poly.size - Object.keys(RETIRING).length - Object.keys(PENDING).length,
    )
  })

  it('every partitioned field packs byte-identically in its destination block', () => {
    // One non-trivial value per field kind, exercised through BOTH packers.
    // u32 lanes use raw-word values an f32 route would corrupt (the
    // polygon-uniform-block discipline).
    const polyB = uniformBlock(polygonU)
    const MVP = Float32Array.from({ length: 16 }, (_, i) => (i + 1) * 0.03125)
    const V4: [number, number, number, number] = [1.5, -2.25, 3.125, -4.0625]
    const V2: [number, number] = [12345.5, -6789.25]
    const F = 0.8125
    const U32 = 0xabcd1234
    const val = (kind: string): unknown =>
      kind === 'mat' ? MVP : kind === 'vec4' ? V4 : kind === 'vec2' ? V2 : kind === 'u32' ? U32 : F
    // Field kind from the polygon declaration (same spec objects the blocks
    // were built from).
    const kindOf = (u: { struct: { fields: { name: string; type: unknown }[] } }, f: string) => {
      const t = u.struct.fields.find((x) => x.name === f)!.type as {
        kind?: string
        n?: number
        elem?: string
      }
      if (t.kind === 'mat') return 'mat'
      if (t.kind === 'vec') return t.n === 2 ? 'vec2' : 'vec4'
      return t.elem === 'u32' || (t as { name?: string }).name === 'u32' ? 'u32' : 'f32'
    }
    for (const [destName, destU] of [
      ['tile', tileBlockU],
      ['show', showBlockU],
      ['frame', frameBlockU],
    ] as const) {
      const destB = uniformBlock(destU as Parameters<typeof uniformBlock>[0])
      for (const f of fieldsOf(destU as Parameters<typeof uniformBlock>[0])) {
        if (RELOCATED_INTO_SHOW.has(f)) continue
        const kind = kindOf(polygonU as never, f)
        const v = val(kind)
        // Pack through the typed setters on both sides.
        const setP = (polyB.set as unknown as Record<string, (...a: number[]) => void>)[f]!
        const setD = (destB.set as unknown as Record<string, (...a: number[]) => void>)[f]!
        if (kind === 'mat') {
          ;(setP as unknown as (m: Float32Array) => void)(MVP)
          ;(setD as unknown as (m: Float32Array) => void)(MVP)
        } else if (Array.isArray(v)) {
          setP(...(v as number[]))
          setD(...(v as number[]))
        } else {
          setP(v as number)
          setD(v as number)
        }
        const size = kind === 'mat' ? 64 : kind === 'vec4' ? 16 : kind === 'vec2' ? 8 : 4
        const pOff = polyB.fieldOffset(f as never)
        const dOff = destB.fieldOffset(f as never)
        const pBytes = new Uint8Array(polyB.buffer, pOff, size)
        const dBytes = new Uint8Array(destB.buffer, dOff, size)
        expect(
          [...dBytes],
          `${destName}.${f}: bytes differ from polygonU.${f} for the same value — ` +
            'the INC-4 shader would read different data',
        ).toEqual([...pBytes])
      }
    }
  })
})
