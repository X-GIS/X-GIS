// ═══ GLSL ES 3.00 — the fn section's shape: dependency order + main() as the entry (#1858) ═══
//
// Two emitter defects, one theme: GLSL ES 3.00 has no hoisting and one `main()` per unit,
// and the backend used to pay for both facts with structure nothing reads.
//
//   • It emitted a forward prototype for EVERY helper, because `lowered.funcs` order is not
//     dependency order — module()'s transitive collection PREPENDS collected callees, which
//     may land ahead of the extern-bodied projection fns they call (#740 R1). On the baked
//     map corpus that was 507 prototypes, 6.2% of the text, of which 20 were load-bearing.
//   • It spelled every entry as `<name>_impl` and synthesised a `main()` that called it once.
//     Entry names are ABI, so `mangle()` may not touch them: `fs_impl` shipped verbatim into
//     minified production text, wrapping a body that could simply BE main's body.
//
// The gates below are shaped so the fix cannot be faked by re-spelling. The order gate uses
// a module whose declaration order is the WRONG one (caller first) and asserts the emitted
// DEFINITION offsets, not a substring; the entry gate asserts BOTH that the wrapper is gone
// and that the values it carried still reach the varyings. Each has its negative twin — the
// `raw` helper (whose calls the IR walk cannot see) and the early-return entry (whose exits
// a void `main()` cannot spell) must both keep the old shape, or the fallbacks are dead code
// that would rot unnoticed.
//
// The REAL-driver half is playground/e2e/_glsl-compile-gate.spec.ts, which compiles and links
// these same strings on ANGLE — a prototype wrongly dropped is a link error there, and an
// entry wrongly merged is a compile error.

import { describe, it, expect } from 'vitest'
import { emitGlslModule } from '@xgis/shader-dsl'
import { f32T, vec2fT, vec4fT } from '@xgis/shader-dsl'
import type { FuncDecl, ModuleDecl } from '@xgis/shader-dsl'
import {
  fn,
  module as dslModule,
  ioStruct,
  builtin,
  location,
  vec4,
  vec2,
  ReturnIf,
  Let,
  rawStmt,
} from '@xgis/shader-dsl'
import { pruneRedundantPrototypes } from '../../emit-prod.js'

/** Where `text` DEFINES `name` (the `{`-bodied declarator), or -1. */
const defAt = (text: string, name: string): number =>
  text.search(new RegExp(`^\\w+ ${name}\\([^)]*\\) \\{`, 'm'))

/** Every `<type> <name>(...);` prototype in `text`. */
const protosIn = (text: string): string[] =>
  [...text.matchAll(/^\w+ (\w+)\([^)]*\);$/gm)].map((m) => m[1]!)

// ── The fixture: a caller declared BEFORE the callee it needs ──
//
// `outer` calls `inner`, and the module lists `outer` first — the exact order module()'s
// prepend produces for a collected callee that calls a later extern-bodied fn. Emitted in
// declaration order this NEEDS a prototype for `inner`; emitted in dependency order it needs
// none, which is the whole claim.
const inner = fn('inner', { v: f32T }, ({ v }) => v.mul(2))
const outer = fn('outer', { v: f32T }, ({ v }) => inner({ v }).add(1))

const IoOut = ioStruct('IoOut', {
  position: builtin('position', vec4fT),
  uv: location(0, vec2fT),
})

const vsEntry = fn(
  'vs',
  { idx: builtin('vertex_index', f32T) },
  IoOut.type,
  ({ idx }) => {
    const k = Let(outer({ v: idx }))
    return IoOut.construct({ position: vec4(k, 0, 0, 1), uv: vec2(k, k) })
  },
  { stage: 'vertex' },
)

const orderedModule = (): ModuleDecl => dslModule({ uses: [IoOut], funcs: [outer, inner, vsEntry] })

describe('glsl-es300 — the fn section is emitted in dependency order (#1858)', () => {
  it('defines a callee BEFORE its caller even when the module declares them the other way', () => {
    const vs = emitGlslModule(orderedModule(), 'vertex')
    const at = { inner: defAt(vs, 'inner'), outer: defAt(vs, 'outer') }
    expect(at.inner, 'inner must be defined').toBeGreaterThan(-1)
    expect(at.outer, 'outer must be defined').toBeGreaterThan(-1)
    // The ASSERTION that distinguishes the fix from the bug: offsets, not a substring —
    // the pre-fix emitter produced both definitions too, just in the other order.
    expect(at.inner).toBeLessThan(at.outer)
  })

  it('emits NO prototype once the order carries define-before-use', () => {
    expect(protosIn(emitGlslModule(orderedModule(), 'vertex'))).toEqual([])
  })

  it('leaves pruneRedundantPrototypes() nothing to remove — byte-identical output', () => {
    // The emitter is now the single authority for define-before-use; the text pass stays
    // as the safety net for hand-written rawGlsl, and must be a no-op on our own bytes.
    const vs = emitGlslModule(orderedModule(), 'vertex')
    expect(pruneRedundantPrototypes(vs)).toBe(vs)
  })

  it('FALLS BACK to prototypes for everything when a helper body hides its calls in raw text', () => {
    // A `raw` Stmt is opaque to the IR walk, so the call graph is incomplete and no order
    // can be proven correct — the historical unconditional block is what must come back.
    const rawHelper: FuncDecl = {
      name: 'outer',
      params: [{ name: 'v', type: f32T }],
      ret: f32T,
      body: [
        rawStmt({ wgsl: 'let _k = 1.0;', glsl: 'float _k = 1.0;' }),
        { s: 'return', expr: { op: 'varref', name: '_k', type: f32T } },
      ],
    }
    const vs = emitGlslModule(
      dslModule({ uses: [IoOut], funcs: [rawHelper, inner, vsEntry] }),
      'vertex',
    )
    expect(protosIn(vs).sort()).toEqual(['inner', 'outer'])
  })
})

describe('glsl-es300 — a single-exit entry IS main() (#1858)', () => {
  it('emits the entry body inside main(), with no `_impl` fn and no call to one', () => {
    const vs = emitGlslModule(orderedModule(), 'vertex')
    expect(vs).not.toContain('_impl')
    expect((vs.match(/void main\(\) \{/g) ?? []).length).toBe(1)
    // …and the values still land: the exit expression feeds the scatter directly.
    expect(vs).toContain('gl_Position = _out.position;')
    expect(vs).toContain('uv = _out.uv;')
    expect(defAt(vs, 'outer')).toBeLessThan(vs.indexOf('void main()'))
  })

  it('scatters straight from the exit VARIABLE, minting no copy of it', () => {
    // The `VsOut.var()` + field-assign + `return o.$` shape real shaders author
    // (map/src/shaders/dsl/flow-advect.ts). The scatter needs the value in a named place
    // and `o` already IS one, so `IoOut _out = o;` would copy a struct nothing else reads.
    const vsVar = fn(
      'vs_var',
      { idx: builtin('vertex_index', f32T) },
      IoOut.type,
      ({ idx }) => {
        const o = IoOut.var()
        o.position.assign(vec4(idx, 0, 0, 1))
        o.uv.assign(vec2(idx, idx))
        return o.$
      },
      { stage: 'vertex' },
    )
    const vs = emitGlslModule(dslModule({ uses: [IoOut], funcs: [vsVar] }), 'vertex')
    // `o` reaches emit as `_v0` — autoVars names every local — which is also why an
    // `_out` collision is remote enough that freshLocal() is belt-and-braces.
    expect(vs).toMatch(/^ {2}IoOut _v0;$/m)
    expect(vs).toContain('gl_Position = _v0.position;')
    expect(vs).toContain('uv = _v0.uv;')
    expect(vs).not.toContain('_out')
  })

  it('binds a bare BUILTIN param to a local, so the body can read it by name', () => {
    const fsE = fn('fs', { pos: builtin('position', vec4fT) }, ({ pos }) => vec4(pos.x, 0, 0, 1), {
      stage: 'fragment',
      retAttr: location(0, vec4fT),
    })
    const fs = emitGlslModule(dslModule({ funcs: [fsE] }), 'fragment')
    expect(fs).toContain('vec4 pos = gl_FragCoord;')
    expect(fs).toContain('_ret = vec4(pos.x, 0.0, 0.0, 1.0);')
  })

  it('does NOT self-bind a bare fragment input that already carries its varying name', () => {
    // `in float amt;` + a param named `amt` — `float amt = amt;` would bind the local to
    // ITSELF (a GLSL declarator is in scope inside its own initializer), so the merged form
    // must emit no local at all and let the body read the global.
    const fsA = fn('fs', { amt: location(0, f32T) }, ({ amt }) => vec4(amt, 0, 0, 1), {
      stage: 'fragment',
      retAttr: location(0, vec4fT),
    })
    const fs = emitGlslModule(dslModule({ funcs: [fsA] }), 'fragment')
    expect(fs).toMatch(/^in float amt;$/m)
    expect(fs).not.toMatch(/float amt = amt;/)
    expect(fs).toContain('_ret = vec4(amt, 0.0, 0.0, 1.0);')
  })

  it('RENAMES a gather local that would shadow the varying the scatter writes', () => {
    // THE BUG THE MERGE INTRODUCED, and the reason this file exists. `vs_line` takes
    // `@builtin(instance_index) seg_id` and returns a struct whose `seg_id` field is an
    // out varying. In the wrapper form those were two scopes. Merged naively, main()
    // opens with `uint seg_id = uint(gl_InstanceID);` — which captures the `flat out uint
    // seg_id` — and the scatter's `seg_id = _out.seg_id;` then writes the LOCAL. The
    // shader still compiles and still links; the varying just keeps whatever it held, and
    // every line in the map disappears. Only a real WebGL2 frame caught it.
    const SegOut = ioStruct('SegOut', {
      position: builtin('position', vec4fT),
      seg_id: location(0, f32T),
    })
    const vsSeg = fn(
      'vs_seg',
      { seg_id: builtin('vertex_index', f32T) },
      SegOut.type,
      ({ seg_id }) => SegOut.construct({ position: vec4(seg_id, 0, 0, 1), seg_id }),
      { stage: 'vertex' },
    )
    const vs = emitGlslModule(dslModule({ uses: [SegOut], funcs: [vsSeg] }), 'vertex')
    expect(vs).toMatch(/^out float seg_id;$/m)
    // The gather binds a DIFFERENT name…
    expect(vs).toMatch(/^ {2}float seg_id_in = float\(gl_VertexID\);$/m)
    expect(vs).not.toMatch(/^ {2}float seg_id = /m)
    // …the body reads that name…
    expect(vs).toContain('SegOut(vec4(seg_id_in, 0.0, 0.0, 1.0), seg_id_in)')
    // …and the scatter therefore reaches the varying, not a local shadowing it.
    expect(vs).toContain('seg_id = _out.seg_id;')
  })

  it('KEEPS the `_impl` wrapper for an early-return body', () => {
    // Two exits — the documented `allowEarlyReturn` deviation real shaders use for a perf
    // guard (map/src/shaders/dsl/line.ts). `void main()` cannot carry a value out of either,
    // and rewriting every exit into a scatter is a different transform, so this is exactly
    // the shape the wrapper still exists for. A lint WAIVER does not make it spellable.
    const fsR = fn(
      'fs_early',
      { pos: builtin('position', vec4fT) },
      ({ pos }) => {
        ReturnIf(pos.x.lt(0), vec4(0, 0, 0, 1))
        return vec4(pos.x, 0, 0, 1)
      },
      { stage: 'fragment', retAttr: location(0, vec4fT), allowEarlyReturn: true },
    )
    const fs = emitGlslModule(dslModule({ funcs: [fsR] }), 'fragment')
    expect(fs).toContain('vec4 fs_early_impl(vec4 pos)')
    expect(fs).toContain('_ret = fs_early_impl(gl_FragCoord);')
  })
})
