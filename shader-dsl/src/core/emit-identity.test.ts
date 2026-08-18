// ═══ emitIdentity (#1715 Problem B) — telling dev bytes from prod bytes ═══
//
// The reported failure: a committed generated registry, a production build that rewrote
// those tracked files, and dev-mode golden tests that then disagreed with what the build
// produced. Neither emit was wrong. The artifact just could not say which one it was.
//
// So the load-bearing property is not "the stamp exists" — it is that the stamp DISTINGUISHES
// the modes that produce different bytes, and does NOT distinguish two spellings of the same
// mode. A stamp that changes when nothing changed is noise a build learns to ignore; a stamp
// that stays put when the mode moved is the original bug with extra steps.

import { describe, it, expect } from 'vitest'
import { emitIdentity } from './emit-identity.js'
import { buildRegistry } from './registry.js'
import { inline, mangle, minify } from '../emit-prod.js'
import type { EmitPlugin } from './emit.js'
import { voidT, type ModuleDecl } from './ir/index.js'

describe('emitIdentity — what it must distinguish', () => {
  it('separates a dev emit from a prod one', () => {
    // THE case. These two produce different bytes, and telling them apart is the entire ask.
    expect(emitIdentity('glsl-es300')).not.toBe(
      emitIdentity('glsl-es300', { plugins: [inline(), mangle(), minify()] }),
    )
  })

  it('separates the two targets', () => {
    expect(emitIdentity('wgsl')).not.toBe(emitIdentity('glsl-es300'))
  })

  it.each([
    ['parens', { parens: 'minimal' } as const],
    ['fp64Flavor', { fp64Flavor: 'integer' } as const],
    ['emulateCompute', { emulateCompute: true } as const],
    ['overrideValues', { overrideValues: { FEATURE: true } } as const],
  ])('separates a change to %s, which changes emitted bytes', (_axis, opts) => {
    // Each of these is a byte-changing option that is NOT a plugin. A stamp built only from
    // the plugin chain would collapse all four into the default, which is the under-describing
    // failure mode the module header calls out.
    expect(emitIdentity('glsl-es300', opts)).not.toBe(emitIdentity('glsl-es300'))
  })

  it('separates two plugin chains that differ only in ORDER', () => {
    // mangle-then-minify and minify-then-mangle are different programs.
    expect(emitIdentity('wgsl', { plugins: [mangle(), minify()] })).not.toBe(
      emitIdentity('wgsl', { plugins: [minify(), mangle()] }),
    )
  })

  it('separates a plugin that declares its own identity', () => {
    const p = (identity: string): EmitPlugin => ({
      name: 'tuned',
      identity,
      transformText: (c) => c,
    })
    expect(emitIdentity('wgsl', { plugins: [p('tuned(a)')] })).not.toBe(
      emitIdentity('wgsl', { plugins: [p('tuned(b)')] }),
    )
  })
})

describe('emitIdentity — what it must NOT distinguish', () => {
  it('is stable across calls with the same configuration', () => {
    // Without this every arm above passes on a function returning a random string.
    expect(emitIdentity('wgsl', { plugins: [mangle()] })).toBe(
      emitIdentity('wgsl', { plugins: [mangle()] }),
    )
  })

  it('is stable across the ORDER an overrideValues literal was written in', () => {
    // Same configuration, different source spelling. A stamp that moved here would churn on
    // every unrelated edit and stop being read.
    expect(emitIdentity('glsl-es300', { overrideValues: { A: 1, B: 2 } })).toBe(
      emitIdentity('glsl-es300', { overrideValues: { B: 2, A: 1 } }),
    )
  })

  it('treats an absent option and its default as the same mode', () => {
    expect(emitIdentity('wgsl', { parens: 'full', fp64Flavor: 'float' })).toBe(emitIdentity('wgsl'))
  })

  it('treats an empty plugin array as no plugins', () => {
    expect(emitIdentity('wgsl', { plugins: [] })).toBe(emitIdentity('wgsl'))
  })
})

describe('emitIdentity — the shape of the string', () => {
  it('stays READABLE: the axis that moved is visible without decoding a hash', () => {
    // A bare digest would answer "did it change" and never "what changed", which is the
    // question someone staring at an unexplained diff actually has.
    const s = emitIdentity('glsl-es300', { plugins: [inline(), mangle(), minify()] })
    expect(s).toContain('glsl-es300')
    expect(s).toContain('plugins=inline+mangle+minify')
  })

  it('ends in a digest of exactly the readable part', () => {
    const s = emitIdentity('wgsl')
    const [readable, digest] = s.split('#')
    expect(digest).toMatch(/^[0-9a-f]{8}$/)
    // The digest is derived, not independent — so it cannot disagree with what it summarises.
    expect(emitIdentity('wgsl')).toBe(`${readable}#${digest}`)
  })

  it('is a single line, because it goes in a banner', () => {
    expect(emitIdentity('glsl-es300', { overrideValues: { A: 1, B: 2 } })).not.toContain('\n')
  })
})

describe('emitIdentity — the #1812 portable declaration is a mode too', () => {
  // Since #1812 the compute→fragment lowering runs on GLSL for a `portable`-declared entry
  // with NO emit option — so the `emulateCompute` marker means "the lowering RAN", and a
  // stamp built from the options alone would claim a plain emit for exactly the bytes the
  // lowering rewrote. The module (third argument) is what closes that gap.
  const entry = (portable: boolean): ModuleDecl['funcs'][number] => ({
    name: 'k',
    params: [],
    ret: voidT,
    body: [],
    stage: 'compute',
    ...(portable ? { portable: true } : {}),
  })
  const mod = (portable: boolean): ModuleDecl => ({
    consts: [],
    structs: [],
    bindings: [],
    funcs: [entry(portable)],
  })

  it('a portable module stamps GLSL as the lowering, identically to the option spelling', () => {
    expect(emitIdentity('glsl-es300', undefined, mod(true))).toBe(
      emitIdentity('glsl-es300', { emulateCompute: true }),
    )
    expect(emitIdentity('glsl-es300', undefined, mod(true))).not.toBe(emitIdentity('glsl-es300'))
  })

  it('does not mark WGSL (the lowering never runs there) nor an undeclared module', () => {
    expect(emitIdentity('wgsl', undefined, mod(true))).toBe(emitIdentity('wgsl'))
    expect(emitIdentity('glsl-es300', undefined, mod(false))).toBe(emitIdentity('glsl-es300'))
  })

  it('without the module the stamp keeps its option-only meaning (a registry banner)', () => {
    expect(emitIdentity('glsl-es300')).not.toContain('emulateCompute')
  })
})

describe('emitIdentity — reaching the artifact that actually broke', () => {
  it('lands in a generated registry banner', () => {
    // The registry is the committed file the production build rewrote. Putting the stamp in
    // its banner means the first line of that diff names the cause.
    const { source } = buildRegistry([{ id: 'a', importPath: './a.ts', exportName: 'a' }], {
      stamp: emitIdentity('glsl-es300', { plugins: [minify()] }),
    })
    expect(source).toContain('// Emit identity: glsl-es300;')
    expect(source).toContain('plugins=minify')
  })

  it('omits the banner line entirely when no stamp is given', () => {
    // Otherwise every existing generated file grows a line saying nothing.
    expect(
      buildRegistry([{ id: 'a', importPath: './a.ts', exportName: 'a' }]).source,
    ).not.toContain('Emit identity')
  })
})
