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
// `validateVariantsWgsl` is the WGSL half. naga/tint still cannot enter this package (#1681
// zero-dependency), so validation is a real browser's Tint through
// `GPUDevice.createShaderModule()` + `getCompilationInfo()` — hence the ASYNC shape and the
// second structural parameter. What was wrong was the follow-on claim, once recorded here and
// in CLAUDE.md §5, that no software adapter exists to run it against: headless Chromium
// enumerates the SwiftShader Vulkan adapter given `--enable-unsafe-swiftshader` (the flag
// usually omitted) on a secure origin (`about:blank` has no `navigator.gpu` at all), and
// `playwright.config.ts` already sets both. `_variant-link-gate.spec.ts`'s WGSL arm drives it.

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
// ── the WGSL half (#1715 Problem A) ──────────────────────────────────────────

/** The slice of `GPUDevice` that validating a WGSL module needs.
 *
 *  A real `GPUDevice` satisfies this as-is — pass it straight in. Structural for the same
 *  two reasons as {@link GlLinker}: the package needs no WebGPU types to build (#1681
 *  rejected `@webgpu/types` on exactly that ground), and a test can drive the aggregation
 *  with a recorder while the real run goes through real Tint. */
export interface WgslValidator<Module = unknown> {
  createShaderModule(descriptor: { code: string }): Module
}

/** One compilation message, narrowed to what a gate reports. Mirrors `GPUCompilationMessage`
 *  without depending on its type. */
export interface WgslMessage {
  readonly type: string
  readonly message: string
  readonly lineNum?: number
}

/** A module that can report what its compilation produced — `GPUShaderModule`. Separate from
 *  {@link WgslValidator} because the module, not the device, owns this call. */
export interface WgslCompiled {
  getCompilationInfo(): Promise<{ readonly messages: readonly WgslMessage[] }>
}

/** What happened to one variant on the WGSL side. */
export interface VariantWgslResult {
  readonly key: string
  readonly ok: boolean
  /** `'emit'` — the DSL threw before any device call. `'validate'` — Tint reported errors,
   *  or the device call itself threw. Absent when `ok`. */
  readonly failedAt?: 'emit' | 'validate'
  /** Every message of type `'error'`, formatted. Absent when `ok`. Warnings and info are
   *  deliberately NOT failures: Tint emits them for valid shaders, and a gate that reddens
   *  on them trains people to ignore it. */
  readonly errors?: readonly string[]
}

/**
 * Validate EVERY variant of a family through a real WGSL compiler (#1715 Problem A).
 *
 * The WGSL twin of {@link linkVariants}: same enumeration, same "attempt every variant even
 * after one fails" rule, same per-key result shape. WGSL has no separate link step — one
 * module carries both entry points — so `createShaderModule` + `getCompilationInfo()` is the
 * whole check, and it is async where the GL one is not.
 *
 * ```ts
 * const device = await (await navigator.gpu.requestAdapter())!.requestDevice()
 * const failed = (await validateVariantsWgsl(device, family)).filter((r) => !r.ok)
 * expect(failed, failed.map((r) => `${r.key}: ${r.errors?.join('; ')}`).join('\n')).toEqual([])
 * ```
 *
 * NOTE `createShaderModule` does not throw on invalid WGSL — the errors arrive through
 * `getCompilationInfo()`. A gate that only wraps the call in try/catch passes on every
 * broken shader, which is why this reads the messages rather than trusting the absence of a
 * throw.
 *
 * @param device - a `GPUDevice`, or anything satisfying {@link WgslValidator}.
 * @param family - the family to enumerate; every key in `family.keys` is attempted.
 * @param opts - emit options, applied to every variant equally.
 * @returns one result per key, in `family.keys` order.
 */
export async function validateVariantsWgsl<A extends Record<string, readonly unknown[]>>(
  device: WgslValidator,
  family: VariantFamily<A>,
  opts?: EmitOptions,
): Promise<readonly VariantWgslResult[]> {
  let sources: ReadonlyMap<string, string>
  try {
    sources = family.emit('wgsl', opts)
  } catch (e) {
    // Same attribution rule as the GL side: emit is per-family, so one bad variant takes the
    // matrix down and nothing here can say which. Reported against every key rather than
    // guessed at.
    const err = `family emit threw (attribution unavailable — emit is per-family): ${(e as Error).message}`
    return family.keys.map((key) => ({
      key,
      ok: false,
      failedAt: 'emit' as const,
      errors: [err],
    }))
  }

  const out: VariantWgslResult[] = []
  for (const key of family.keys) {
    const code = sources.get(key)
    if (code === undefined) {
      out.push({ key, ok: false, failedAt: 'emit', errors: ['no source emitted for this key'] })
      continue
    }
    out.push(await validateOne(device, key, code))
  }
  return out
}

async function validateOne(
  device: WgslValidator,
  key: string,
  code: string,
): Promise<VariantWgslResult> {
  let info: { readonly messages: readonly WgslMessage[] }
  try {
    const mod = device.createShaderModule({ code }) as WgslCompiled
    info = await mod.getCompilationInfo()
  } catch (e) {
    return {
      key,
      ok: false,
      failedAt: 'validate',
      errors: [(e as Error).message.slice(0, MAX_LOG)],
    }
  }
  const errors = info.messages
    .filter((m) => m.type === 'error')
    .map((m) => `${m.lineNum === undefined ? '' : `L${m.lineNum}: `}${m.message}`.slice(0, MAX_LOG))
  return errors.length === 0 ? { key, ok: true } : { key, ok: false, failedAt: 'validate', errors }
}
