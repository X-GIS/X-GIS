import { describe, it, expect } from 'vitest'
import { fn, module, externFn, callFn, f32, f32T } from './index'
import { emitModule } from '../backends/wgsl'

// ═══ #740 R1 — module() transitive collection + key-naming ═══
//
// The assembly ceremony this retires: authors hand-listing every helper fn in
// manual callee-first order. Contract under test:
//   1. fns reached through handle calls (declRef) but not listed are PREPENDED
//      callee-first (post-order), so entries-only modules define-before-use;
//   2. an authored array keeps its EXACT order (byte-compat for existing code);
//   3. a key-named record names anonymous fns / renames mismatched ones and
//      re-spells every handle-made call;
//   4. externFn / raw callFn string calls carry no declRef and are left alone.

const leaf = fn('leaf', { x: f32T }, ({ x }) => x.mul(2))
const mid = fn('mid', { x: f32T }, ({ x }) => leaf(x).add(1))
const top = fn('top', { x: f32T }, ({ x }) => mid(x).add(leaf(x)))

describe('module() transitive fn collection', () => {
  it('prepends unlisted callees callee-first (post-order), deduped', () => {
    const m = module({ funcs: [top] })
    expect(m.funcs.map((f) => f.name)).toEqual(['leaf', 'mid', 'top'])
  })

  it('keeps an authored full list byte-identical (order verbatim, nothing added)', () => {
    const authored = module({ funcs: [leaf, mid, top] })
    expect(authored.funcs.map((f) => f.name)).toEqual(['leaf', 'mid', 'top'])
    // The emitted WGSL is exactly what the same hand-assembled module emits.
    expect(emitModule(authored)).toBe(
      emitModule({ consts: [], structs: [], bindings: [], funcs: [leaf, mid, top] }),
    )
  })

  it('collects through a partially-authored list without disturbing its order', () => {
    const m = module({ funcs: [mid, top] })
    expect(m.funcs.map((f) => f.name)).toEqual(['leaf', 'mid', 'top'])
  })

  it('leaves extern / raw string calls alone (no declRef → no collection)', () => {
    const ext = externFn('injected', { x: f32T }, f32T)
    const user = fn('user', { x: f32T }, ({ x }) => ext(x).add(callFn('raw_name', f32T, f32(1))))
    const m = module({ funcs: [user] })
    expect(m.funcs.map((f) => f.name)).toEqual(['user'])
  })

  it('dedups by NAME, not just identity (pass-transformed / dual-instance decls)', () => {
    // A composer transform (or vite dual-loading the package) produces a listed
    // fn whose OBJECT differs from the declRef the call sites carry — same name.
    // Identity-only dedup re-collected the original next to the copy → dup-func
    // at validate (the exact demo-path regression the polygon composer hit).
    const caller = fn('caller2', { x: f32T }, ({ x }) => leaf(x))
    const leafCopy = { ...leaf.decl, body: [...leaf.decl.body] } // transformed twin, same name
    const m = module({ funcs: [leafCopy, caller] })
    expect(m.funcs.map((f) => (f as { decl?: { name: string } }).decl?.name ?? f.name)).toEqual([
      'leaf',
      'caller2',
    ])
  })
})

describe('module() key-named funcs record', () => {
  it('names anonymous fns by their key and re-spells handle-made calls', () => {
    const helper = fn({ x: f32T }, ({ x }) => x.mul(3))
    const entry = fn({ x: f32T }, ({ x }) => helper(x).add(1))
    const m = module({ funcs: { half_life: helper, main_entry: entry } })
    expect(m.funcs.map((f) => declName(f))).toEqual(['half_life', 'main_entry'])
    const wgsl = emitModule(m)
    expect(wgsl).toContain('fn half_life(')
    expect(wgsl).toContain('half_life(x)') // the call site spells the key name
    expect(wgsl).not.toContain('_fn') // no auto-name leaked into the emit
  })

  it('renames a named fn when the key differs, across other bodies', () => {
    const a = fn('old_name', { x: f32T }, ({ x }) => x.add(1))
    const caller = fn('caller', { x: f32T }, ({ x }) => a(x))
    const m = module({ funcs: { renamed: a, caller } })
    const wgsl = emitModule(m)
    expect(wgsl).toContain('fn renamed(')
    expect(wgsl).toContain('renamed(x)')
    expect(wgsl).not.toContain('old_name')
  })

  it('collects unlisted callees of record entries too', () => {
    const helper2 = fn('helper2', { x: f32T }, ({ x }) => x.mul(4))
    const entry2 = fn({ x: f32T }, ({ x }) => helper2(x))
    const m = module({ funcs: { entry2 } })
    expect(m.funcs.map((f) => declName(f))).toEqual(['helper2', 'entry2'])
  })
})

const declName = (f: { name: string; decl?: { name: string } }): string =>
  (f as { decl?: { name: string } }).decl?.name ?? f.name
