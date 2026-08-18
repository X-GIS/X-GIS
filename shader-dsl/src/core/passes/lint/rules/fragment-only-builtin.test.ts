import { describe, it, expect } from 'vitest'
import { lint } from '../engine.js'
import {
  module,
  fn,
  f32,
  f32T,
  vec2,
  vec4,
  vec2fT,
  vec4fT,
  vec3uT,
  voidT,
  dpdx,
  dpdy,
  fwidth,
  textureSample,
  textureSampleLevel,
  type FuncDecl,
} from '../../../ir/index.js'
import { resource, builtin } from '../../../sot.js'
import { collectFnRefs, emptyRefSet } from '../../../ir/collect-refs.js'
import { texture2dfT, texture2dArrayfT, samplerT } from '../../../ir/index.js'
import { emitModule } from '../../../backends/wgsl.js'
import { ValidationError } from '../../validate.js'
import { fragmentOnlyBuiltin } from './fragment-only-builtin.js'

const FIX =
  'textureSample is fragment-only in WGSL — use textureSampleLevel(tex, smp, uv, level) — an explicit LOD needs no derivatives'
// #1651 — the ARRAY row names the array-shaped fix (the layer argument is part of it).
const ARRAY_FIX =
  'textureSampleArray is fragment-only in WGSL — use textureSampleLevel(tex, smp, uv, layer, level) — an explicit LOD needs no derivatives'

const tex = resource('fob_tex', texture2dfT, { group: 0, binding: 0 })
const smp = resource('fob_smp', samplerT, { group: 0, binding: 1 })
const arr = resource('fob_arr', texture2dArrayfT, { group: 0, binding: 2 })

// leaf → mid: the fragment-only call sits TWO hops below any entry, so a direct-call
// check would miss it (transitive reachability is the point).
const leaf = fn('fob_leaf', { uv: vec2fT }, vec4fT, ({ uv }) =>
  textureSample(tex.node, smp.node, uv),
)
const mid = fn('fob_mid', { uv: vec2fT }, vec4fT, ({ uv }) => leaf({ uv }))
const leafLevel = fn('fob_leaf_level', { uv: vec2fT }, vec4fT, ({ uv }) =>
  textureSampleLevel(tex.node, smp.node, uv, 1),
)
const leafArray = fn('fob_leaf_array', { uv: vec2fT }, vec4fT, ({ uv }) =>
  textureSample(arr.node, smp.node, uv, 1),
)
const leafArrayLevel = fn('fob_leaf_array_level', { uv: vec2fT }, vec4fT, ({ uv }) =>
  textureSampleLevel(arr.node, smp.node, uv, 1, 0),
)

const vsCalling = (callee: typeof mid) =>
  fn('fob_vs', {}, vec4fT, () => callee({ uv: vec2(0, 0) }), {
    stage: 'vertex',
    retAttr: builtin('position', vec4fT),
  })

const run = (m: ReturnType<typeof module>) => lint(m, [fragmentOnlyBuiltin])

describe('fragment-only-builtin (#1650)', () => {
  it('flags textureSample reached TRANSITIVELY from a vertex entry', () => {
    const ds = run(
      module({ bindings: [tex.binding, smp.binding], funcs: [vsCalling(mid), mid, leaf] }),
    )
    expect(ds.map((d) => d.ruleId)).toEqual(['fragment-only-builtin'])
    expect(ds[0]?.message).toBe(FIX)
    expect(ds[0]?.fn).toBe('fob_leaf')
    expect(ds[0]?.code).toBe('SD0109')
  })

  it('flags the same chain reached from a COMPUTE entry', () => {
    const cs = fn(
      'fob_cs',
      { gid: builtin('global_invocation_id', vec3uT) },
      voidT,
      (_p, b) => {
        b.let('sampled', mid({ uv: vec2(0, 0) }))
      },
      { stage: 'compute', workgroupSize: 64 },
    )
    const ds = run(module({ bindings: [tex.binding, smp.binding], funcs: [cs, mid, leaf] }))
    expect(ds.map((d) => d.message)).toEqual([FIX])
  })

  it('stays silent when the SAME helper is reachable only from a fragment entry', () => {
    const fs = fn('fob_fs', {}, vec4fT, () => mid({ uv: vec2(0, 0) }), { stage: 'fragment' })
    expect(run(module({ bindings: [tex.binding, smp.binding], funcs: [fs, mid, leaf] }))).toEqual(
      [],
    )
  })

  it('stays silent for textureSampleLevel in a vertex entry (the sanctioned fix)', () => {
    const m = module({
      bindings: [tex.binding, smp.binding],
      funcs: [vsCalling(leafLevel), leafLevel],
    })
    expect(run(m)).toEqual([])
  })

  it('#1651: flags the ARRAY sample from a vertex entry, naming the ARRAY fix', () => {
    const m = module({
      bindings: [arr.binding, smp.binding],
      funcs: [vsCalling(leafArray), leafArray],
    })
    const ds = run(m)
    expect(ds.map((d) => d.message)).toEqual([ARRAY_FIX])
    expect(ds[0]?.code).toBe('SD0109')
    // the fix must name the LAYER argument — the 2d-shaped hint would mislead here
    expect(ds[0]?.hint).toContain('uv, layer, level')
  })

  it('#1651: stays silent for the array explicit-LOD form in a vertex entry', () => {
    const m = module({
      bindings: [arr.binding, smp.binding],
      funcs: [vsCalling(leafArrayLevel), leafArrayLevel],
    })
    expect(run(m)).toEqual([])
  })

  it('emitModule THROWS on the vertex violation — the rule is wired into CORE_RULES', () => {
    const m = module({ bindings: [tex.binding, smp.binding], funcs: [vsCalling(mid), mid, leaf] })
    expect(() => emitModule(m)).toThrow(ValidationError)
    expect(() => emitModule(m)).toThrow(/fragment-only in WGSL/)
  })

  it('UNDER-reports (documented) when the only edge to the builtin is inside a raw Stmt', () => {
    // collectFnRefs cannot see a call made in raw WGSL text (its documented contract),
    // so the closure lacks the vertex→fob_mid edge and the rule stays silent — the
    // pre-rule status quo, NOT a mis-report. Deliberate; see the rule docstring.
    const vsRaw: FuncDecl = {
      name: 'fob_vs_raw',
      attrs: ['@vertex'],
      params: [],
      ret: vec4fT,
      retAttr: '@builtin(position)',
      body: [{ s: 'raw', wgsl: 'return fob_mid(vec2<f32>(0.0, 0.0));' }],
    }
    const m = module({ bindings: [tex.binding, smp.binding], funcs: [vsRaw, mid, leaf] })
    expect(run(m)).toEqual([])
  })

  it('#1654: flags a helper reachable from BOTH a vertex and a fragment entry', () => {
    // Pins the rule docstring's "one reachable from BOTH is flagged, because it is
    // emitted into the vertex/compute stage as well" — previously true only by
    // construction (the closure never subtracts fragment-reachable fns), untested.
    const fs = fn('fob_fs_dual', {}, vec4fT, () => mid({ uv: vec2(0, 0) }), { stage: 'fragment' })
    // The fragment→mid edge is REAL, not assumed: without this cross-check the test
    // would still pass on the vertex chain alone if the fragment entry silently
    // failed to produce its call edge (verification-review nit on #1654).
    const fsRefs = emptyRefSet()
    collectFnRefs(fs.decl, fsRefs)
    expect([...fsRefs.calls]).toContain('fob_mid')
    const m = module({
      bindings: [tex.binding, smp.binding],
      funcs: [vsCalling(mid), fs, mid, leaf],
    })
    // Exactly ONE diagnostic: the shared leaf holds one call site, and being reachable
    // from a second (fragment) entry must neither silence nor duplicate it. (Today the
    // engine walks each fn once, so per-entry duplication is structurally impossible —
    // the exactly-one shape is a forward pin against a per-entry redesign.)
    expect(run(m).map((d) => d.message)).toEqual([FIX])
  })

  it('still fires on an IR-reachable violation when an UNRELATED raw Stmt exists (no bail)', () => {
    // Bailing on raw (the dce-fns / stageScope contract) would be WRONG here: those
    // TRANSFORM and need the complete graph; a diagnostic only needs its positives
    // sound, and IR edges are real calls. This pin goes red if anyone adds a bail.
    const noise: FuncDecl = {
      name: 'fob_noise',
      params: [],
      ret: vec4fT,
      body: [{ s: 'raw', wgsl: 'return vec4<f32>(1.0);' }],
    }
    const m = module({
      bindings: [tex.binding, smp.binding],
      funcs: [vsCalling(mid), mid, leaf, noise],
    })
    expect(run(m).map((d) => d.message)).toEqual([FIX])
  })
})

// ── #1654: the DERIVATIVE rows (dpdx / dpdy / fwidth) ──────────────────────────
// These three ids were ABSENT from FRAGMENT_ONLY_IDS before #1654, so the rule was
// silent on every case below: the positives here are the fail-before witness (on the
// pre-#1654 table each `run(...)` returned [] — green-by-silence — and only the new
// rows turn them red-then-green). Their fix is shared and shape-free: no drop-in
// alternative exists, so the quantity must come from somewhere other than the GPU's
// screen-space derivative.
const DERIV_FIX =
  'precompute the quantity and pass it in (a per-vertex varying, a CPU-computed uniform, or finite differences of neighboring samples) — derivatives exist only in a fragment invocation'

// Same leaf → mid shape as the texture fixtures: the derivative sits TWO hops below
// any entry, so only the transitive closure reaches it.
const leafDpdx = fn('fob_leaf_dpdx', { x: f32T }, f32T, ({ x }) => dpdx(x))
const midDpdx = fn('fob_mid_dpdx', { x: f32T }, f32T, ({ x }) => leafDpdx({ x }))
const leafDpdy = fn('fob_leaf_dpdy', { x: f32T }, f32T, ({ x }) => dpdy(x))
const leafFwidth = fn('fob_leaf_fwidth', { x: f32T }, f32T, ({ x }) => fwidth(x))

const vsCallingF32 = (callee: typeof midDpdx) =>
  fn('fob_vs_f32', {}, vec4fT, () => vec4(callee({ x: f32(1) }), 0, 0, 1), {
    stage: 'vertex',
    retAttr: builtin('position', vec4fT),
  })

describe('fragment-only-builtin — derivatives (#1654)', () => {
  it('flags dpdx reached TRANSITIVELY from a vertex entry, naming the derivative fix', () => {
    const ds = run(module({ funcs: [vsCallingF32(midDpdx), midDpdx, leafDpdx] }))
    expect(ds.map((d) => d.ruleId)).toEqual(['fragment-only-builtin'])
    expect(ds[0]?.message).toBe(`dpdx is fragment-only in WGSL — ${DERIV_FIX}`)
    expect(ds[0]?.fn).toBe('fob_leaf_dpdx')
    expect(ds[0]?.code).toBe('SD0109')
    // no same-shape alternative to name — the fix must be the precompute advice
    expect(ds[0]?.hint).toBe(DERIV_FIX)
  })

  it('flags dpdy reached from a COMPUTE entry', () => {
    const cs = fn(
      'fob_cs_dpdy',
      { gid: builtin('global_invocation_id', vec3uT) },
      voidT,
      (_p, b) => {
        b.let('d', leafDpdy({ x: f32(1) }))
      },
      { stage: 'compute', workgroupSize: 64 },
    )
    const ds = run(module({ funcs: [cs, leafDpdy] }))
    expect(ds.map((d) => d.message)).toEqual([`dpdy is fragment-only in WGSL — ${DERIV_FIX}`])
    expect(ds[0]?.code).toBe('SD0109')
  })

  it('flags fwidth from a vertex entry — the row every PRODUCTION call site uses', () => {
    // Every production/example derivative call is fwidth (icon, point, circle,
    // arrow, particle + the examples); dpdx/dpdy have positives above, so without
    // THIS one, deleting the fwidth row alone would leave the whole suite green
    // while the guard production actually relies on silently dies.
    const ds = run(module({ funcs: [vsCallingF32(leafFwidth), leafFwidth] }))
    expect(ds.map((d) => d.message)).toEqual([`fwidth is fragment-only in WGSL — ${DERIV_FIX}`])
    expect(ds[0]?.code).toBe('SD0109')
  })

  it('stays silent for fwidth reachable ONLY from a fragment entry (the negative)', () => {
    const fs = fn('fob_fs_fwidth', {}, vec4fT, () => vec4(leafFwidth({ x: f32(1) }), 0, 0, 1), {
      stage: 'fragment',
    })
    expect(run(module({ funcs: [fs, leafFwidth] }))).toEqual([])
  })
})
