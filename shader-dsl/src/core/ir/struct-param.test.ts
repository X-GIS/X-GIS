import { describe, it, expect } from 'vitest'
import { fn, module, f32T, vec2fT } from './index'
import { structDecl, ioStruct, location } from '../sot'
import { emitModule } from '../backends/wgsl'

// ═══ #740 R6 — struct/IO handles as fn param specs ═══
//
// `fn({ s: Seg }, ({ s }) => s.k …)` must emit BYTE-IDENTICALLY to the retired
// `fn({ s: Seg.type }, (p) => Seg.of(p.s).k …)` re-assertion — the handle path
// only moves the field-proxy wrap from every consumer body into fn() itself.

const Seg = structDecl('SegP', { k: f32T, v: vec2fT })

describe('fn() struct-handle params', () => {
  it('emits byte-identically to the .of() re-assertion path', () => {
    const oldStyle = fn('probe', { s: Seg.type }, (p) => {
      const s = Seg.of(p.s)
      return s.k.add(s.v.x)
    })
    const newStyle = fn('probe', { s: Seg }, ({ s }) => s.k.add(s.v.x))
    const emitOne = (f: typeof oldStyle) => emitModule(module({ structs: [Seg.decl], funcs: [f] }))
    expect(emitOne(newStyle)).toBe(emitOne(oldStyle))
  })

  it('works for ioStruct handles (entry-input pattern)', () => {
    const IO = ioStruct('IoP', { uv: location(0, vec2fT) })
    const g = fn('reads_io', { input: IO }, ({ input }) => input.uv.x.add(input.uv.y))
    const wgsl = emitModule(module({ structs: [IO.decl], funcs: [g] }))
    expect(wgsl).toContain('fn reads_io(input: IoP) -> f32')
    expect(wgsl).toContain('input.uv.x')
  })

  it('FORWARDS a handle param into another fn (proxy unwraps via $ / has trap)', () => {
    // The crash class: a single plain-object positional arg is parsed as a
    // named-args bag unless the proxy is recognised — which needs the `has`
    // trap (`'$' in proxy`) since the proxy target is an empty object.
    const IO2 = ioStruct('IoF', { uv: location(0, vec2fT) })
    const inner = fn('fwd_inner', { input: IO2 }, ({ input }) => input.uv.x)
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- the test verifies the POSITIONAL single struct-field-proxy forward (the `has`-trap recognition); it must use the positional form
    const outer = fn('fwd_outer', { input: IO2 }, ({ input }) => inner(input).add(input.uv.y))
    const wgsl = emitModule(module({ structs: [IO2.decl], funcs: [inner, outer] }))
    expect(wgsl).toContain('fwd_inner(input)') // forwarded as the raw struct value
  })
})
