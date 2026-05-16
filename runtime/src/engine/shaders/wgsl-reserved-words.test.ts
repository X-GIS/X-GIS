// Guard against the bug class where a WGSL reserved word is used as a
// declared identifier in hand-written shader WGSL. Regression: commit
// de56c70 (#135) added `fn unwrap_lon_near(value: f32, ref: f32)` —
// `ref` is reserved, so Tint/naga rejected the whole module
// ("Expected a Identifier, but got a ReservedWord") and EVERY vertex
// shader (it splices WGSL_PROJECTION_FNS) failed to compile → blank map.
//
// These shader strings are static, so scanning the declaration sites
// (fn names, parameters, let/var/const bindings) is enough.

import { describe, expect, it } from 'vitest'
import { WGSL_PROJECTION_FNS } from './projection'
import { POLYGON_SHADER_SOURCE } from '../render/renderer'
import { LINE_SHADER_SOURCE } from '../render/line-renderer'
import { RASTER_SHADER_SOURCE } from '../render/raster-renderer'

// WGSL spec reserved words (the high-value subset that realistically
// collides with shader-author names; `ref` is the one that bit us).
const RESERVED = new Set([
  'ref', 'filter', 'sample', 'texture', 'enum', 'typedef', 'union',
  'private', 'common', 'centroid', 'void', 'while', 'do', 'as',
  'async', 'attribute', 'mat', 'vec', 'ptr', 'Self', 'premerge',
  'regardless', 'unless', 'using', 'f16', 'f64', 'i8', 'i16', 'i64',
  'u8', 'u16', 'u64', 'interface', 'namespace', 'package', 'module',
  'static', 'auto', 'become', 'cast', 'class', 'crate', 'extern',
  'friend', 'goto', 'inline', 'macro', 'match', 'new', 'operator',
  'super', 'template', 'throw', 'try', 'type', 'unsafe', 'virtual',
  'where', 'yield',
])

function declaredIdentifiers(wgsl: string): string[] {
  const out: string[] = []
  // fn names
  for (const m of wgsl.matchAll(/\bfn\s+([A-Za-z_]\w*)/g)) out.push(m[1])
  // let / var / const bindings
  for (const m of wgsl.matchAll(/\b(?:let|var|const)\s+([A-Za-z_]\w*)/g)) out.push(m[1])
  // parameter names: `( ... name: type ... )` — name is the token
  // immediately before a `:` inside a parenthesised signature.
  for (const sig of wgsl.matchAll(/\(([^)]*)\)/g)) {
    for (const p of sig[1].matchAll(/([A-Za-z_]\w*)\s*:/g)) out.push(p[1])
  }
  return out
}

describe('shader WGSL never declares an identifier that is a reserved word', () => {
  const sources: [string, string][] = [
    ['WGSL_PROJECTION_FNS', WGSL_PROJECTION_FNS],
    ['POLYGON_SHADER_SOURCE', POLYGON_SHADER_SOURCE],
    ['LINE_SHADER_SOURCE', LINE_SHADER_SOURCE],
    ['RASTER_SHADER_SOURCE', RASTER_SHADER_SOURCE],
  ]
  for (const [name, src] of sources) {
    it(`${name} uses no WGSL reserved word as a declared identifier`, () => {
      const bad = declaredIdentifiers(src).filter((id) => RESERVED.has(id))
      expect(bad).toEqual([])
    })
  }

  it('the `ref` regression specifically stays fixed', () => {
    expect(WGSL_PROJECTION_FNS).not.toMatch(/\bref\s*:/)
  })
})
