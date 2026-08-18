// ═══ #1812 — the PORTABLE KERNEL TIER, fail-before corpus ═══
//
// The tier's one-sentence contract: a compute entry declared `portable: true` emits on BOTH
// backends — native `@compute` on WGSL (zero byte change) and the compute→fragment-GPGPU
// lowering on GLSL ES 3.00 with NO emit-site option — and any construct outside the
// gather-only shape fails validation at EVERY emit, on BOTH writers, with a coded remedy.
// This file is what makes each clause of that sentence false-able:
//
//   • SD0110 — the declaration is compute-only, rejected by fn() at authoring time.
//   • SD0111 — one case per violation the analyzer can report, each asserted from
//     emitModule AND emitGlslModule (the SYMMETRY pin: the whole point of registering the
//     rule in CORE_RULES is that a kernel which could never lower for WebGL2 fails on
//     WebGPU too, at the same moment, with the same sentence).
//   • the byte pins — the declaration adds zero WGSL bytes, and the GLSL auto path is
//     byte-identical to the `emulateCompute: true` path for the M2a fixture shape.
//   • reflect() — the host-contract signal is present exactly when declared.
//
// The two writers report through DIFFERENT classes, deliberately, and the tests assert that
// difference rather than papering over it: WGSL fails inside `validate()` (a ValidationError
// aggregating every CORE diagnostic, each rendered as a `[SD0111] portable-kernel …` line),
// while GLSL fails EARLIER — inside `lowerComputeToFragment`, which runs before the lowered
// module reaches validate() — as a direct `ShaderDslError` with `code === 'SD0111'`. What is
// symmetric, and what the tier's promise actually needs, is the CODE and the violation
// SENTENCE: both come from the single authority, `analyzePortableKernel`.
//
// Fixture style follows backends/glsl-compute.test.ts (~lines 40-90): raw IR literals, no
// authoring layer, so a violation is constructed exactly and nothing else moves. The one
// exception is the `module()`-assembly test at the end, which MUST go through `fn()` — the
// declaration has no attrs spelling, so the fn HANDLE that `module()` puts into `funcs[]` is
// the only place it can be dropped, and a hand-built-decl-only corpus cannot see that.

import { describe, it, expect } from 'vitest'
import {
  fn,
  module,
  vec4,
  pack4x8unorm,
  If,
  Return,
  f32T,
  u32T,
  vec3uT,
  vec4uT,
  vec4fT,
  voidT,
  type BindingDecl,
  type Expr,
  type FuncDecl,
  type ModuleDecl,
  type ShaderType,
  type Stmt,
} from '../ir/index.js'
import { builtin, resource, storageBuffer } from '../sot.js'
import { emitModule } from '../backends/wgsl.js'
import { emitGlslModule } from '../backends/glsl.js'
import { reflect } from '../reflect.js'
import { ShaderDslError } from '../diagnostics/error.js'
import { ValidationError } from './validate.js'

const boolT = { kind: 'scalar', scalar: 'bool' } as ShaderType
const arrF32 = { kind: 'array', elem: f32T } as ShaderType
const arrU32 = { kind: 'array', elem: u32T } as ShaderType

// raw-IR node builders (matches backends/glsl-compute.test.ts fixture style)
const lit = (value: number, type: ShaderType): Expr => ({ op: 'lit', type, value })
const varref = (name: string, type: ShaderType): Expr => ({ op: 'varref', type, name })
const member = (base: Expr, field: string, type: ShaderType): Expr => ({
  op: 'member',
  type,
  base,
  field,
})
const index = (base: Expr, idx: Expr, type: ShaderType): Expr => ({ op: 'index', type, base, idx })

// The tier's gather-only shell: guard on gid.x < u_count.x, then ONE store at gid.x.
const gidParam = { op: 'param', type: vec3uT, name: 'gid' } as Expr
const fid = member(gidParam, 'x', u32T)
const count = member(varref('u_count', vec4uT), 'x', u32T)
const color: Expr = {
  op: 'construct',
  type: vec4fT,
  args: [index(varref('feat_data', arrF32), fid, f32T), lit(0, f32T), lit(0, f32T), lit(1, f32T)],
}
const packed: Expr = { op: 'call', type: u32T, fn: 'pack4x8unorm', args: [color] }
const guard: Stmt = {
  s: 'if',
  arms: [
    { cond: { op: 'compare', type: boolT, cop: '>=', a: fid, b: count }, body: [{ s: 'return' }] },
  ],
}
const storeAt = (idx: Expr): Stmt => ({
  s: 'assign',
  target: index(varref('out_color', arrU32), idx, u32T),
  expr: packed,
})
const store = storeAt(fid)

const FEAT: BindingDecl = {
  group: 0,
  binding: 0,
  name: 'feat_data',
  space: 'storage',
  access: 'read',
  type: arrF32,
}
const OUT: BindingDecl = {
  group: 0,
  binding: 1,
  name: 'out_color',
  space: 'storage',
  access: 'read_write',
  type: arrU32,
}
const UNIFORM: BindingDecl = {
  group: 0,
  binding: 2,
  name: 'u_count',
  space: 'uniform',
  type: vec4uT,
}
const BINDINGS: readonly BindingDecl[] = [FEAT, OUT, UNIFORM]

/** The M2a fixture's UNDECLARED entry — attrs-only, exactly the shape whose
 *  `emulateCompute: true` bytes the auto path must reproduce. */
const PLAIN_ENTRY: FuncDecl = {
  name: 'paint',
  attrs: ['@compute', '@workgroup_size(64)'],
  params: [{ name: 'gid', type: vec3uT, builtin: 'global_invocation_id' }],
  ret: voidT,
  body: [guard, store],
}
/** The same entry, DECLARED portable. */
const PORTABLE_ENTRY: FuncDecl = {
  ...PLAIN_ENTRY,
  stage: 'compute',
  workgroupSize: 64,
  portable: true,
}

const modOf = (entry: FuncDecl, bindings: readonly BindingDecl[] = BINDINGS): ModuleDecl => ({
  consts: [],
  structs: [],
  bindings,
  funcs: [entry],
})
/** A portable kernel with `body` swapped in — the violation constructor for body-shaped cases. */
const withBody = (body: readonly Stmt[]): ModuleDecl => modOf({ ...PORTABLE_ENTRY, body })

const PLAIN_MOD = modOf(PLAIN_ENTRY)
const PORTABLE_MOD = modOf(PORTABLE_ENTRY)

/** Return what `emit` threw, or `undefined` when it did not throw — so an emit that silently
 *  ACCEPTS a kernel outside the tier fails the assertion instead of skipping every check. */
const captureThrow = (emit: () => unknown): unknown => {
  try {
    emit()
  } catch (e) {
    return e
  }
  return undefined
}

describe('#1812 SD0110 — portable is a COMPUTE declaration, rejected at authoring time', () => {
  // Not a tsc error: FnOpts is one flat bag (stage and portable are independent optionals),
  // which is exactly why fn() carries the runtime half of the two-layer pattern.
  it('fn() throws SD0110 for portable on a vertex entry', () => {
    const err = captureThrow(() =>
      fn('bad_vs', {}, () => vec4(0, 0, 0, 1), { stage: 'vertex', portable: true }),
    )
    expect(err).toBeInstanceOf(ShaderDslError)
    expect((err as ShaderDslError).code).toBe('SD0110')
    expect((err as Error).message).toContain("stage: 'vertex'")
  })

  it('fn() throws SD0110 for portable on a plain helper fn (no stage at all)', () => {
    const err = captureThrow(() => fn('bad_helper', {}, () => vec4(0, 0, 0, 1), { portable: true }))
    expect(err).toBeInstanceOf(ShaderDslError)
    expect((err as ShaderDslError).code).toBe('SD0110')
    expect((err as Error).message).toContain('no stage')
  })

  it('fn() accepts it on a compute entry and records it structurally', () => {
    const k = fn('ok_kernel', {}, () => undefined, { stage: 'compute', portable: true })
    expect(k.decl.portable).toBe(true)
  })
})

describe('#1812 SD0111 — every tier violation fails on BOTH writers with the same sentence', () => {
  const CASES: ReadonlyArray<{ name: string; module: ModuleDecl; detail: string }> = [
    {
      name: 'gid read as .y (the tier is 1-D)',
      module: withBody([
        { s: 'let', name: 'row', expr: member(gidParam, 'y', u32T) },
        guard,
        store,
      ]),
      detail: "'gid' is used other than as 'gid.x'",
    },
    {
      name: 'gid read as a whole vector',
      module: withBody([{ s: 'let', name: 'g', expr: gidParam }, guard, store]),
      detail: "'gid' is used other than as 'gid.x'",
    },
    {
      name: 'scatter write (out_color[0])',
      module: withBody([guard, storeAt(lit(0, u32T))]),
      detail: 'is not a plain store at the invocation index',
    },
    {
      name: 'two writes to the output',
      module: withBody([guard, store, store]),
      detail: "writes to 'out_color' 2 times",
    },
    {
      name: 'zero writes to the output',
      module: withBody([guard]),
      detail: "writes to 'out_color' 0 times",
    },
    {
      name: 'output element is f32, not u32',
      module: modOf(PORTABLE_ENTRY, [FEAT, { ...OUT, type: arrF32 }, UNIFORM]),
      detail: "storage binding 'out_color' is array<f32>",
    },
    {
      name: 'no read_write storage binding at all',
      module: modOf(PORTABLE_ENTRY, [FEAT, UNIFORM]),
      detail: 'declares no read_write storage binding',
    },
    {
      name: 'two read_write storage bindings',
      module: modOf(PORTABLE_ENTRY, [
        FEAT,
        OUT,
        { ...OUT, binding: 3, name: 'out_color2' },
        UNIFORM,
      ]),
      detail: 'declares 2 read_write storage bindings',
    },
    {
      name: 'no dispatch uniform',
      module: modOf(PORTABLE_ENTRY, [FEAT, OUT]),
      detail: 'declares no uniform binding',
    },
    {
      name: 'dispatch uniform is not vec4<u32>',
      module: modOf(PORTABLE_ENTRY, [FEAT, OUT, { ...UNIFORM, type: vec4fT }]),
      detail: "'u_count' is vec4<f32>, not vec4<u32>",
    },
    {
      name: 'a raw statement in the entry body',
      module: withBody([guard, { s: 'raw', wgsl: '// spliced', glsl: '// spliced' }, store]),
      detail: 'contains a `raw` statement',
    },
  ]

  for (const c of CASES) {
    it(`WGSL + GLSL both reject: ${c.name}`, () => {
      // WGSL — validate() runs the CORE portable-kernel rule on the AUTHORED module and
      // aggregates every error diagnostic into one ValidationError.
      const wgsl = captureThrow(() => emitModule(c.module))
      expect(wgsl, 'emitModule ACCEPTED a kernel outside the portable tier').toBeInstanceOf(
        ValidationError,
      )
      expect((wgsl as Error).message).toContain('SD0111')
      expect((wgsl as Error).message).toContain(c.detail)

      // GLSL — the compute→fragment lowering gates the declared kernel through the SAME
      // analyzer, and throws before the lowered module ever reaches validate(); so the class
      // is the base ShaderDslError, carrying SD0111 as its own code.
      const glsl = captureThrow(() => emitGlslModule(c.module, 'fragment'))
      expect(glsl, 'emitGlslModule ACCEPTED a kernel outside the portable tier').toBeInstanceOf(
        ShaderDslError,
      )
      expect((glsl as ShaderDslError).code).toBe('SD0111')
      expect((glsl as Error).message).toContain(c.detail)
    })
  }

  it('reports EVERY violation, not just the first (three broken clauses, three sentences)', () => {
    const m = modOf({ ...PORTABLE_ENTRY, body: [guard, storeAt(lit(0, u32T))] }, [FEAT, OUT])
    const wgsl = captureThrow(() => emitModule(m)) as ValidationError
    expect(wgsl).toBeInstanceOf(ValidationError)
    expect(wgsl.diagnostics.filter((d) => d.code === 'SD0111')).toHaveLength(2)
    expect(wgsl.message).toContain('is not a plain store at the invocation index')
    expect(wgsl.message).toContain('declares no uniform binding')
  })

  it('a module with NO portable declaration is silent — the tier is declared, never inferred', () => {
    expect(() => emitModule(PLAIN_MOD)).not.toThrow()
  })
})

describe('#1812 byte pins — the declaration is free on WGSL and exact on GLSL', () => {
  it('WGSL: declaring portable changes zero bytes', () => {
    expect(emitModule(PORTABLE_MOD)).toBe(emitModule(PLAIN_MOD))
  })

  it('GLSL: the auto path emits the emulateCompute bytes, with no emit-site option', () => {
    // The contrast is the point: the SAME module shape without the declaration still
    // fail-closes on the missing compute capability, so the declaration — nothing else — is
    // what flipped the lowering on.
    expect(() => emitGlslModule(PLAIN_MOD, 'fragment')).toThrow(/missing capabilities/)
    expect(emitGlslModule(PORTABLE_MOD, 'fragment')).toBe(
      emitGlslModule(PLAIN_MOD, 'fragment', { emulateCompute: true }),
    )
  })

  it('GLSL: the auto path really lowered (a fragment GPGPU pass, no compute left)', () => {
    const fs = emitGlslModule(PORTABLE_MOD, 'fragment')
    expect(fs).toContain('void main()')
    expect(fs).toMatch(/layout\(location = 0\) out uint \w+;/)
    expect(fs).toContain('uniform uvec4 u_count;')
    expect(fs).not.toContain('@compute')
  })
})

describe('#1812 reflect() — the host-contract signal', () => {
  it('portable is true exactly when declared, and absent otherwise', () => {
    const declared = reflect(PORTABLE_MOD).entries[0]!
    expect(declared.stage).toBe('compute')
    expect(declared.portable).toBe(true)

    const undeclared = reflect(PLAIN_MOD).entries[0]!
    expect(undeclared.stage).toBe('compute')
    // Absent, never `false` — the host reads "WebGPU-only" as it reads any absent capability.
    expect('portable' in undeclared).toBe(false)
  })
})

describe('#1812 the declaration survives module() assembly (fn-authored, not hand-built)', () => {
  // The ONE shape a hand-built-decl corpus cannot reach. `portable` has no attrs spelling by
  // design, and module() puts the fn HANDLE (not its decl) into funcs[] — so if the handle
  // does not mirror the field, every fn()-authored kernel loses the declaration on assembly
  // and the entire tier is silently dead on its only authoring path.
  const featData = storageBuffer('feat_data', f32T, { group: 0, binding: 0, access: 'read' })
  const outColor = storageBuffer('out_color', u32T, { group: 0, binding: 1, access: 'read_write' })
  const uCount = resource('u_count', vec4uT, { group: 0, binding: 2 })
  const authored = module({
    uses: [featData, outColor, uCount],
    funcs: [
      fn(
        'paint',
        { gid: builtin('global_invocation_id', vec3uT) },
        ({ gid }) => {
          const i = gid.x
          If(i.ge(uCount.node.x), () => {
            Return()
          })
          outColor.at(i).assign(pack4x8unorm(vec4(featData.at(i), 0, 0, 1)))
        },
        { stage: 'compute', workgroupSize: 64, portable: true },
      ),
    ],
  })

  it('reflect() sees it on the assembled module', () => {
    expect(reflect(authored).entries[0]?.portable).toBe(true)
  })

  it('the GLSL auto path engages for it — same bytes as the emulateCompute opt-in', () => {
    expect(emitGlslModule(authored, 'fragment')).toBe(
      emitGlslModule(authored, 'fragment', { emulateCompute: true }),
    )
    expect(emitGlslModule(authored, 'fragment')).toContain('void main()')
  })
})
