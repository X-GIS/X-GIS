import { describe, it, expect } from 'vitest'
import { fn, module, vec4, vec2, f32, u32T, vec4fT, vec2fT, f32T } from './ir/index.js'
import { ioStruct, location, builtin } from './sot.js'
import { reflect, type EntryIoField } from './reflect.js'
import { emitGlslModule } from './backends/glsl.js'

// ═══ #1905 — `EntryInfo.io`: the entry's @location/@builtin INTERFACE ═══
//
// `inputs`/`output` report TYPE KEYS, which is what semanticDiff fingerprints a module
// with — and nothing else. A host validating a vertex/fragment pair needs the LOCATION
// numbers, and they are already in the IR, so the consumer that wanted them reached back
// into `ModuleDecl`, re-implemented the struct-vs-scalar walk, and regex-parsed WGSL
// attribute syntax on top of a package whose premise is structured IR.
//
// The motivating consumer is a varying-parity gate: every fragment input location must be
// produced by a vertex output at the same location, builtins excluded. The last test here
// is that gate, run over this file's own pair.

const VOut = ioStruct('VOut', {
  position: builtin('position', vec4fT),
  uv: location(0, vec2fT),
  tint: location(1, vec4fT, 'flat'),
})

const vs = fn(
  'vs',
  { pos: location(0, vec4fT), vi: builtin('vertex_index', u32T) },
  ({ pos }) => {
    const o = VOut.var()
    o.position.assign(pos)
    o.uv.assign(vec2(pos.x, pos.y))
    o.tint.assign(vec4(1, 1, 1, 1))
    return o.$
  },
  { stage: 'vertex' },
)
const fs = fn('fs', { in: VOut }, (p) => p.in.tint.mul(p.in.uv.x), {
  stage: 'fragment',
  retAttr: '@location(0)',
})
const pair = () => module({ structs: [VOut.decl], funcs: [vs, fs] })

const ioOf = (name: string) => reflect(pair()).entries.find((e) => e.name === name)!.io

describe('#1905 — EntryInfo.io', () => {
  it('reports each entry param with its own location/builtin', () => {
    // fail-before: `inputs` was ['vec4<f32>', 'u32'] — type keys, no names, no locations.
    expect(ioOf('vs').inputs).toEqual<EntryIoField[]>([
      { name: 'pos', type: 'vec4<f32>', location: 0 },
      { name: 'vi', type: 'u32', builtin: 'vertex_index' },
    ])
  })

  it('FLATTENS a struct return to its fields, keeping builtins', () => {
    // Builtins are reported, not filtered: a varying-parity diagnostic has to be able to
    // say WHY `position` is excluded rather than have the field silently not exist.
    expect(ioOf('vs').outputs).toEqual<EntryIoField[]>([
      { name: 'position', type: 'vec4<f32>', builtin: 'position' },
      { name: 'uv', type: 'vec2<f32>', location: 0 },
      { name: 'tint', type: 'vec4<f32>', location: 1 },
    ])
  })

  it('FLATTENS a struct param too — the stage interface does not care which form it took', () => {
    // The case that decides the feature. Every fragment entry in this repo takes its
    // varyings as one ioStruct param, so an un-flattened `inputs` would be a single
    // struct-typed row with NO location — and a varying-parity gate over it would pass by
    // having nothing to check (§12's assertion that carries no information).
    expect(ioOf('fs').inputs).toEqual<EntryIoField[]>([
      { name: 'position', type: 'vec4<f32>', builtin: 'position' },
      { name: 'uv', type: 'vec2<f32>', location: 0 },
      { name: 'tint', type: 'vec4<f32>', location: 1 },
    ])
  })

  it("reports a BARE return's @location, the case that forced the consumer's regex", () => {
    // `retAttr` is a raw attribute STRING with no structured location twin in the IR, so
    // this is the read a consumer could not do any other way. `_ret` is the name the GLSL
    // backend gives that same output.
    expect(ioOf('fs').outputs).toEqual<EntryIoField[]>([
      { name: '_ret', type: 'vec4<f32>', location: 0 },
    ])
  })

  it("reports a bare return's @builtin from the STRUCTURED field (#1672)", () => {
    // The FieldSpec authoring form: `retBuiltin` carries the semantic id, `retAttr` the
    // spelling. Reading the structured field first is what #1672 preserved it for.
    const depth = fn('fs_depth', {}, () => f32(0.5), {
      stage: 'fragment',
      retAttr: builtin('frag_depth', f32T),
    })
    const io = reflect(module({ funcs: [depth] })).entries[0]!.io
    expect(io.outputs).toEqual<EntryIoField[]>([
      { name: '_ret', type: 'f32', builtin: 'frag_depth' },
    ])
  })

  it('reports NO outputs for a void return', () => {
    const k = fn('cs', { gid: builtin('global_invocation_id', u32T) }, () => {}, {
      stage: 'compute',
      workgroupSize: 32,
    })
    const io = reflect(module({ funcs: [k] })).entries[0]!.io
    expect(io.inputs).toEqual<EntryIoField[]>([
      { name: 'gid', type: 'u32', builtin: 'global_invocation_id' },
    ])
    expect(io.outputs).toEqual([])
  })

  it('leaves `inputs`/`output` exactly as they were — semanticDiff reads those', () => {
    const e = reflect(pair()).entries.find((x) => x.name === 'vs')!
    expect(e.inputs).toEqual(['vec4<f32>', 'u32'])
    expect(e.output).toEqual('struct:VOut')
  })

  // ── The use case, end to end ──
  it('supports the varying-parity check it exists for', () => {
    const r = reflect(pair())
    const locs = (fields: readonly EntryIoField[]) =>
      new Set(fields.filter((f) => f.builtin === undefined).map((f) => f.location))
    const produced = locs(r.entries.find((e) => e.stage === 'vertex')!.io.outputs)
    const consumed = locs(r.entries.find((e) => e.stage === 'fragment')!.io.inputs)
    // Pin the consumed set to REAL location numbers first. Without this the check is
    // §12's assertion that passes either way: un-flattened, both sides collapse to the
    // one-element set {undefined} and the parity filter is empty for the wrong reason.
    expect([...consumed].sort()).toEqual([0, 1])
    expect([...consumed].filter((l) => !produced.has(l))).toEqual([])
  })

  // ── The agreement gate ──
  //
  // reflect() and the GLSL backend read the same `ioAttrOf`/`retIoAttrOf` (ir/entry-io.ts),
  // and this is what holds them to it: a published interface that disagreed with the
  // emitted one would greenlight a pair GLSL then refuses to link.
  it('agrees with the varyings the GLSL backend actually emits', () => {
    const m = pair()
    const r = reflect(m)
    const emitted = (stage: 'vertex' | 'fragment', dir: 'in' | 'out') =>
      [
        ...emitGlslModule(m, stage).matchAll(
          /^(?:layout\(location = \d+\) )?(?:flat )?(in|out) \w+ (\w+);$/gm,
        ),
      ]
        .filter(([, d]) => d === dir)
        .map(([, , name]) => name)
        .sort()
    const varyings = (fields: readonly EntryIoField[]) =>
      fields
        .filter((f) => f.builtin === undefined)
        .map((f) => f.name)
        .sort()
    const vsIo = r.entries.find((e) => e.stage === 'vertex')!.io
    const fsIo = r.entries.find((e) => e.stage === 'fragment')!.io
    expect(emitted('vertex', 'out')).toEqual(varyings(vsIo.outputs))
    expect(emitted('fragment', 'in')).toEqual(varyings(fsIo.inputs))
    expect(emitted('fragment', 'out')).toEqual(varyings(fsIo.outputs))
  })
})
