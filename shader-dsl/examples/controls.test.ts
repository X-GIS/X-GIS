// ═══ shader-dsl examples — controls ↔ reflection cross-check ═══
//
// `controls` keys are uniform-struct FIELD NAMES: the hosts (site runner, e2e
// render gate) look each key up in reflect(module)'s std140 field table to find
// its byte offset. Nothing ties the two together at compile time, so a typo'd
// control key silently packs nothing and a control-less field silently stays 0.
// This gate makes both directions structural:
//   1. every control key must name a real field of the module's uniform block;
//   2. every renderable example's uniform field must carry a control (the hosts
//      would otherwise render it as a permanent 0 — a dead knob);
//   3. kind/type agreement for the auto controls: time → f32, resolution →
//      vec2<f32>, mouse → vec4<f32> (the [x, y, down, used] pointer contract).

import { describe, it, expect } from 'vitest'
import { examples } from './index.ts'
import { reflect } from '../src/index.ts'

const AUTO_KIND_TYPE: Record<string, string> = {
  time: 'f32',
  resolution: 'vec2<f32>',
  mouse: 'vec4<f32>',
}

describe('shader-dsl examples — controls ↔ reflection', () => {
  for (const ex of examples.filter((e) => e.renderable)) {
    it(`${ex.id}: control keys and uniform fields agree`, () => {
      const u = reflect(ex.module).uniforms[0]
      const fields = new Map((u?.fields ?? []).map((f) => [f.name, f.type]))
      const controls = ex.controls ?? {}
      // 1. no orphan control (typo'd key packs nothing)
      for (const key of Object.keys(controls)) {
        expect(fields.has(key), `control '${key}' names no uniform field`).toBe(true)
      }
      // 2. no dead field (a field without a control renders as a permanent 0)
      for (const name of fields.keys()) {
        expect(controls[name], `uniform field '${name}' has no control`).toBeTruthy()
      }
      // 3. the auto controls fill a fixed type — a mismatch would mis-pack bytes
      for (const [key, c] of Object.entries(controls)) {
        const want = AUTO_KIND_TYPE[c.kind]
        if (want) expect(fields.get(key), `'${key}' (${c.kind})`).toBe(want)
      }
    })
  }
})
