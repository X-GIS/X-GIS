// ═══ Shader DSL — compile + link EVERY variant of a family (#1715 Problem A) ═══
//
// A module is type-checked; the COMBINATION a host actually selects is only proven when a
// driver compiles and links it. The consumer that asked for this found two failures at the
// pixel-test stage that a compile gate would have caught in seconds — a missing sampler
// precision, and an interface mismatch between a vertex/fragment pair. Both are per-variant
// properties: the axis that adds a texture, or the axis that adds a varying, is the one that
// breaks, and only in the combinations that select it.
//
// The GL context is a PARAMETER, and structural. Two reasons, both load-bearing:
//
//   - the package stays browser-safe and dependency-free, and needs no DOM lib to build;
//   - a caller can drive it with a recorder, so the aggregation logic (which failure wins,
//     what the message says, that every variant is attempted) is testable without a GPU,
//     while the REAL run still goes through a real driver.
//
// It does not create the context, choose the canvas, or decide what a failure means for the
// build. That is the same split as `buildRegistry`: the environment belongs to the caller.
//
// GLSL / WebGL2 only, today. The WGSL half of this issue wants naga/tint, which cannot enter
// this package (#1681 zero-dependency), so it has to be a real browser's Tint through
// `GPUDevice.createShaderModule().getCompilationInfo()` — a different, ASYNC shape against a
// device this repo's CI has no software adapter for. It is deliberately absent rather than
// stubbed: an untested async validator that reports "no errors" because it never ran is the
// dark gate this issue exists to remove.

import type { EmitOptions } from './emit'
import type { VariantFamily } from './variant-family'

/** The slice of WebGL2 that compiling and linking a program needs.
 *
 *  A real `WebGL2RenderingContext` satisfies this as-is — pass it straight in. The handles
 *  are generic so a caller gets `WebGLShader`/`WebGLProgram` back rather than `unknown`, and
 *  a test can substitute its own. */
export interface GlLinker<Shader = unknown, Program = unknown> {
  readonly VERTEX_SHADER: number
  readonly FRAGMENT_SHADER: number
  readonly COMPILE_STATUS: number
  readonly LINK_STATUS: number
  createShader(type: number): Shader | null
  shaderSource(shader: Shader, source: string): void
  compileShader(shader: Shader): void
  getShaderParameter(shader: Shader, pname: number): unknown
  getShaderInfoLog(shader: Shader): string | null
  createProgram(): Program | null
  attachShader(program: Program, shader: Shader): void
  linkProgram(program: Program): void
  getProgramParameter(program: Program, pname: number): unknown
  getProgramInfoLog(program: Program): string | null
  deleteShader(shader: Shader): void
  deleteProgram(program: Program): void
}

/** What happened to one variant. */
export interface VariantLinkResult {
  /** The family key — the same id a pipeline cache or baked artifact uses. */
  readonly key: string
  readonly ok: boolean
  /** Which step failed. Absent when `ok`. `'emit'` means the DSL threw before any GL call,
   *  which is a different bug from a driver rejecting valid-looking source. */
  readonly failedAt?: 'emit' | 'vertex' | 'fragment' | 'link'
  /** The driver's log, or the thrown message. Absent when `ok`. */
  readonly log?: string
}

const MAX_LOG = 400

/**
 * Emit, compile and link EVERY variant of a family on a real WebGL2 context (#1715).
 *
 * ```ts
 * const gl = canvas.getContext('webgl2')!
 * const failed = linkVariants(gl, family).filter((r) => !r.ok)
 * expect(failed, failed.map((r) => `${r.key}: ${r.failedAt} ${r.log}`).join('\n')).toEqual([])
 * ```
 *
 * Every variant is attempted even after one fails, because the useful output of a gate like
 * this is "these three combinations are broken", not "the first one is".
 *
 * GL objects are deleted as it goes: a family is a cartesian product, and a matrix with a few
 * axes leaks hundreds of programs on a context that is usually shared with a live page.
 *
 * @param gl - a WebGL2 context, or anything satisfying {@link GlLinker}.
 * @param family - the family to enumerate; every key in `family.keys` is attempted.
 * @param opts - emit options, applied to every variant equally (so a prod-mode gate is
 *   `{ plugins: obfuscate() }` and needs no second entry point).
 * @returns one result per key, in `family.keys` order.
 */
export function linkVariants<A extends Record<string, readonly unknown[]>>(
  gl: GlLinker,
  family: VariantFamily<A>,
  opts?: EmitOptions,
): readonly VariantLinkResult[] {
  let vs: ReadonlyMap<string, string>
  let fs: ReadonlyMap<string, string>
  try {
    vs = family.emit('glsl-es300', { ...opts, stage: 'vertex' })
    fs = family.emit('glsl-es300', { ...opts, stage: 'fragment' })
  } catch (e) {
    // `family.emit` is all-or-nothing, so one bad variant takes the matrix down and there is
    // no way from here to say which. Reported against every key with the same message rather
    // than guessed at: the message names the offending declaration, and a fabricated
    // attribution would send the reader to the wrong variant.
    const log = `family emit threw (attribution unavailable — emit is per-family): ${(e as Error).message}`
    return family.keys.map((key) => ({ key, ok: false, failedAt: 'emit' as const, log }))
  }

  return family.keys.map((key) => {
    const v = vs.get(key)
    const f = fs.get(key)
    if (v === undefined || f === undefined)
      return {
        key,
        ok: false,
        failedAt: 'emit',
        log: `no ${v === undefined ? 'vertex' : 'fragment'} source emitted for this key`,
      }
    return linkOne(gl, key, v, f)
  })
}

function linkOne(gl: GlLinker, key: string, vsSrc: string, fsSrc: string): VariantLinkResult {
  const compile = (type: number, src: string) => {
    const sh = gl.createShader(type)
    if (sh === null) return { ok: false, log: 'createShader returned null', sh: null }
    gl.shaderSource(sh, src)
    gl.compileShader(sh)
    return {
      ok: gl.getShaderParameter(sh, gl.COMPILE_STATUS) === true,
      log: gl.getShaderInfoLog(sh) ?? '',
      sh,
    }
  }
  const v = compile(gl.VERTEX_SHADER, vsSrc)
  const f = compile(gl.FRAGMENT_SHADER, fsSrc)
  const cleanup = () => {
    if (v.sh !== null) gl.deleteShader(v.sh)
    if (f.sh !== null) gl.deleteShader(f.sh)
  }
  if (!v.ok) {
    cleanup()
    return { key, ok: false, failedAt: 'vertex', log: v.log.slice(0, MAX_LOG) }
  }
  if (!f.ok) {
    cleanup()
    return { key, ok: false, failedAt: 'fragment', log: f.log.slice(0, MAX_LOG) }
  }
  const prog = gl.createProgram()
  if (prog === null) {
    cleanup()
    return { key, ok: false, failedAt: 'link', log: 'createProgram returned null' }
  }
  gl.attachShader(prog, v.sh!)
  gl.attachShader(prog, f.sh!)
  gl.linkProgram(prog)
  const linked = gl.getProgramParameter(prog, gl.LINK_STATUS) === true
  const log = gl.getProgramInfoLog(prog) ?? ''
  gl.deleteProgram(prog)
  cleanup()
  return linked
    ? { key, ok: true }
    : { key, ok: false, failedAt: 'link', log: log.slice(0, MAX_LOG) }
}
