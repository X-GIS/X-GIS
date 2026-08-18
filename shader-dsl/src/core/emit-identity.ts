// ═══ Shader DSL — the emit MODE is part of an artifact's identity (#1715 Problem B) ═══
//
// A consumer reported the failure this exists to end: their generated shader registry is
// COMMITTED to git, a production build rewrote those tracked files, and the dev-mode golden
// tests then disagreed with what the build produced. Nothing was wrong with either emit —
// they were simply different emits, and the artifact carried no way to say which one it was.
//
// The fix is not to make the two emits equal; they are supposed to differ. It is to make the
// difference NAMEABLE, so a build can assert "this file was produced by the mode I expect"
// instead of discovering it through a diff nobody can explain.
//
// Deliberately NOT injected into the emitted source. That was the first design and it is
// worse: it puts a comment in every shipped shader string, it changes the bytes of 99
// committed goldens, and on GLSL it has to sit before `#version` where it reads like a
// mistake. The identity belongs on the ARTIFACT that gets committed — a registry banner, a
// manifest line, a filename — which is exactly where the reported failure happened.
// `buildRegistry` (#1716) takes it as `stamp` for that reason.

import type { EmitOptions } from './emit'
import type { ModuleDecl } from './ir'
import { isPortableComputeEntry } from './passes/portable-kernel'

/** 32-bit FNV-1a over the canonical form. Zero-dependency on purpose: `node:crypto` is not
 *  reachable from a browser-safe package, and this is a change DETECTOR, not a security
 *  primitive — an adversary who can rewrite the artifact can rewrite the stamp beside it. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** The emit target an identity is computed for. Spelled as the backends spell themselves. */
export type EmitTarget = 'wgsl' | 'glsl-es300'

/** Options that change emitted bytes and are not plugins. Kept as an explicit list rather
 *  than `keyof EmitOptions` so that adding an option is a REVIEWED decision about whether it
 *  belongs in the identity — a new byte-changing option silently absent from the stamp is
 *  the exact failure this file exists to prevent. */
export interface EmitIdentityInput extends EmitOptions {
  /** GLSL only — `emitGlslModule({ emulateCompute })` rewrites the entry, so it is a mode.
   *
   *  The marker means THE COMPUTE→FRAGMENT LOWERING RAN, not "this flag was passed": since
   *  #1812 a `portable`-declared compute entry runs the same lowering with no option at all,
   *  so pass the module as {@link emitIdentity}'s third argument and the marker is derived
   *  from either source. */
  readonly emulateCompute?: boolean
  /** GLSL only — pinned `override` values become hard `#define`s, so they change the bytes. */
  readonly overrideValues?: Readonly<Record<string, number | boolean>>
}

/**
 * A stable, human-readable identity for ONE emit configuration (#1715).
 *
 * ```ts
 * emitIdentity('glsl-es300')                                  // 'glsl-es300;parens=full;plugins=-#…'
 * emitIdentity('glsl-es300', { plugins: obfuscate() })
 * //   '…;plugins=mangle+prune-prototypes+alias-types+minify#…'
 * ```
 *
 * Write it beside a committed artifact and compare it after a build. Equal stamps mean the
 * same emit configuration produced both; different stamps name which axis moved, because the
 * readable half is not hashed away.
 *
 * WHAT IT COVERS: the target, `parens`, `fp64Flavor`, `emulateCompute`, whether override
 * values were pinned (and to what), and the plugin chain IN ORDER.
 *
 * WHAT IT DOES NOT COVER, stated because a stamp that quietly under-describes is worse than
 * none: a plugin's own OPTIONS. `minify({ …a })` and `minify({ …b })` are both `minify` here.
 * A plugin that wants finer granularity sets {@link EmitPlugin.identity}, which is used in
 * place of its name — the prod plugins do not, today, because dev-vs-prod is the distinction
 * that was actually reported and plugin names separate those completely.
 *
 * @param target - which backend emitted the artifact.
 * @param opts - the same options object handed to the emit call.
 * @param m - OPTIONAL, and only meaningful when the identity describes ONE module's emit: the
 * module that was emitted. The `emulateCompute` marker means the compute→fragment lowering
 * RAN, and since #1812 a `portable`-declared compute entry runs it on GLSL with no emit option
 * — so without the module a portable module's GLSL stamp would claim a plain emit. A stamp
 * that covers MANY modules (a registry banner) omits this and keeps its option-only meaning.
 * @returns a one-line identity: a readable summary, then `#` and a 32-bit digest of it.
 */
export function emitIdentity(target: EmitTarget, opts?: EmitIdentityInput, m?: ModuleDecl): string {
  const plugins = (opts?.plugins ?? []).map((p) => p.identity ?? p.name)
  // Sorted keys, so an object literal written in a different order is the same identity.
  const overrides = Object.entries(opts?.overrideValues ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${String(v)}`)
  // The lowering RAN — by the option, or (GLSL only, #1812) because the module declares a
  // portable compute entry, which takes the same path with no option. WGSL never runs it,
  // so the target gates the declaration half.
  const emulateCompute =
    opts?.emulateCompute === true ||
    (target === 'glsl-es300' && m !== undefined && m.funcs.some(isPortableComputeEntry))
  const parts = [
    target,
    `parens=${opts?.parens ?? 'full'}`,
    `fp64=${opts?.fp64Flavor ?? 'float'}`,
    ...(emulateCompute ? ['emulateCompute'] : []),
    ...(overrides.length ? [`overrides=${overrides.join(',')}`] : []),
    `plugins=${plugins.length ? plugins.join('+') : '-'}`,
  ]
  const readable = parts.join(';')
  return `${readable}#${fnv1a(readable)}`
}
