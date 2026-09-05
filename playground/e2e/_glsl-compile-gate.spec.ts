// ═══ GLSL ES 3.00 compile gate: emitGlslModule output compiles on a real WebGL2 ═══
//
// The unit suite (shader-dsl/src/core/backends/glsl.test.ts) asserts the SHAPE of
// the emitted GLSL (version pragma, std140 block + engine-matched offsets, in/out
// varyings, single main()) but NEVER invokes `gl.compileShader`, so a string that
// is well-formed-LOOKING but rejected by the GLSL ES 3.00 compiler (precision
// omissions, reserved-word collisions, an in/out name collision, a bad gl_*
// builtin) would pass the unit gate. This spec closes that hole: it emits a
// representative @vertex + @fragment module via `emitGlslModule(m, stage)` and
// `compileShader`s + `linkProgram`s both in a REAL WebGL2 context (any browser —
// WebGL2 needs no WebGPU adapter), asserting empty info logs + a linked program.
//
// This is the headless-WebGL2 compile gate the glsl backend's W2 caveat called for.

import { test, expect } from '@playwright/test'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BAKED_GLSL_BOOT } from '../../map/src/shaders/baked/baked-glsl-boot.generated'
import { BAKED_GLSL_HILLSHADE } from '../../map/src/shaders/baked/baked-glsl-hillshade.generated'
import { BAKED_GLSL_LAZY } from '../../map/src/shaders/baked/baked-glsl-lazy.generated'
// Relative import (NOT the `@xgis/shader-dsl` alias): Playwright transpiles specs in raw
// Node, which does not resolve the workspace alias — the other compile gate
// (_wgsl-compile-gate.spec.ts) imports runtime shaders the same relative way.
import {
  emitGlslModule,
  glslEs300Backend,
  hostFeaturesFor,
  reflect,
  mat4x4fT,
  vec4fT,
  vec2fT,
  vec3fT,
  f32T,
  u32T,
  structT,
  module as buildModule,
  fn,
  ioStruct,
  builtin,
  location,
  overrideConst,
  rawStmt,
  If,
  Var,
  f32,
  u32,
  i32,
  i32T,
  toF32,
  toI32,
  clamp,
  floor,
  constExpr,
  constRef,
  arrayT,
  arrayLit,
  Node,
  vec2,
  vec4,
  type ShaderType,
  type Expr,
  type FuncDecl,
  type ModuleDecl,
  type StructDecl,
} from '../../shader-dsl/src/index'

// ── a representative vertex+fragment module with a std140 uniform struct ──
const Uniforms: StructDecl = {
  name: 'Uniforms',
  fields: [
    { name: 'mvp', type: mat4x4fT },
    { name: 'viewport', type: vec4fT },
    { name: 'fade', type: f32T },
    { name: 'origin', type: vec3fT },
  ],
}
const VsIn: StructDecl = {
  name: 'VsIn',
  fields: [
    { name: 'pos', type: vec2fT, attr: '@location(0)' },
    { name: 'uv', type: vec2fT, attr: '@location(1)' },
  ],
}
const VsOut: StructDecl = {
  name: 'VsOut',
  fields: [
    { name: 'position', type: vec4fT, attr: '@builtin(position)' },
    { name: 'uv', type: vec2fT, attr: '@location(0)' },
  ],
}
const FsOut: StructDecl = {
  name: 'FsOut',
  fields: [{ name: 'color', type: vec4fT, attr: '@location(0)' }],
}

const param = (name: string, type: ShaderType): Expr => ({ op: 'param', type, name })
const varref = (name: string, type: ShaderType): Expr => ({ op: 'varref', type, name })
const fld = (base: Expr, field: string, type: ShaderType): Expr => ({
  op: 'member',
  type,
  base,
  field,
})
const lit = (value: number): Expr => ({ op: 'lit', type: f32T, value })
const v4 = (...args: Expr[]): Expr => ({ op: 'construct', type: vec4fT, args })

const module: ModuleDecl = {
  consts: [],
  structs: [Uniforms, VsIn, VsOut, FsOut],
  bindings: [{ group: 0, binding: 0, name: 'u', space: 'uniform', type: structT('Uniforms') }],
  funcs: [
    {
      name: 'vs',
      attrs: ['@vertex'],
      params: [{ name: 'inp', type: structT('VsIn') }],
      ret: structT('VsOut'),
      body: [
        { s: 'var', name: 'o', type: structT('VsOut') },
        {
          s: 'assign',
          target: fld(varref('o', structT('VsOut')), 'position', vec4fT),
          expr: v4(
            fld(fld(param('inp', structT('VsIn')), 'pos', vec2fT), 'x', f32T),
            fld(fld(param('inp', structT('VsIn')), 'pos', vec2fT), 'y', f32T),
            lit(0),
            lit(1),
          ),
        },
        {
          s: 'assign',
          target: fld(varref('o', structT('VsOut')), 'uv', vec2fT),
          expr: fld(param('inp', structT('VsIn')), 'uv', vec2fT),
        },
        { s: 'return', expr: varref('o', structT('VsOut')) },
      ],
    },
    {
      name: 'fs',
      attrs: ['@fragment'],
      params: [{ name: 'inp', type: structT('VsOut') }],
      ret: structT('FsOut'),
      body: [
        {
          s: 'return',
          expr: {
            op: 'construct',
            type: structT('FsOut'),
            args: [
              v4(
                fld(fld(param('inp', structT('VsOut')), 'uv', vec2fT), 'x', f32T),
                fld(fld(param('inp', structT('VsOut')), 'uv', vec2fT), 'y', f32T),
                lit(0),
                lit(1),
              ),
            ],
          },
        },
      ],
    },
  ],
}

test.describe('GLSL ES 3.00 compile gate (emitGlslModule output compiles on real WebGL2)', () => {
  test('the @vertex + @fragment GLSL compiles + links with zero info-log errors', async ({
    page,
  }) => {
    const vertex = emitGlslModule(module, 'vertex')
    const fragment = emitGlslModule(module, 'fragment')
    // sanity: non-trivial emit (a silently-empty emit would pass the gate vacuously).
    expect(vertex.length).toBeGreaterThan(100)
    expect(fragment.length).toBeGreaterThan(100)
    expect(vertex.startsWith('#version 300 es')).toBe(true)

    await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })

    const result = await page.evaluate(
      ({ vertex, fragment }) => {
        const canvas = document.createElement('canvas')
        const gl = canvas.getContext('webgl2')
        if (!gl) return { fatal: 'no webgl2 context' as const }

        const compile = (type: number, src: string): { ok: boolean; log: string } => {
          const sh = gl.createShader(type)!
          gl.shaderSource(sh, src)
          gl.compileShader(sh)
          const ok = gl.getShaderParameter(sh, gl.COMPILE_STATUS) as boolean
          const log = gl.getShaderInfoLog(sh) ?? ''
          return { ok, log }
        }

        const vs = compile(gl.VERTEX_SHADER, vertex)
        const fs = compile(gl.FRAGMENT_SHADER, fragment)
        let linkOk = false
        let linkLog = ''
        if (vs.ok && fs.ok) {
          const prog = gl.createProgram()!
          const vsh = gl.createShader(gl.VERTEX_SHADER)!
          gl.shaderSource(vsh, vertex)
          gl.compileShader(vsh)
          const fsh = gl.createShader(gl.FRAGMENT_SHADER)!
          gl.shaderSource(fsh, fragment)
          gl.compileShader(fsh)
          gl.attachShader(prog, vsh)
          gl.attachShader(prog, fsh)
          gl.linkProgram(prog)
          linkOk = gl.getProgramParameter(prog, gl.LINK_STATUS) as boolean
          linkLog = gl.getProgramInfoLog(prog) ?? ''
        }
        return { vs, fs, linkOk, linkLog }
      },
      { vertex, fragment },
    )

    // WebGL2 must be available in the test browser (a Chromium with no WebGL2 is a
    // gate failure, not a skip — every dev/CI browser has WebGL2).
    expect(
      result,
      `WebGL2 unavailable: ${'fatal' in result ? result.fatal : ''}`,
    ).not.toHaveProperty('fatal')
    if ('fatal' in result) return

    expect(
      result.vs.ok,
      `vertex shader failed to compile:\n${result.vs.log}\n--- GLSL ---\n${vertex}`,
    ).toBe(true)
    expect(
      result.fs.ok,
      `fragment shader failed to compile:\n${result.fs.log}\n--- GLSL ---\n${fragment}`,
    ).toBe(true)
    expect(result.linkOk, `program failed to link:\n${result.linkLog}`).toBe(true)
  })

  // #1673 STEP-0 CENSUS — what does mediump actually MEAN on the CI rasterizer?
  //
  // The mediump emit option (GlslEmitOptions.floatPrecision) is a mobile bandwidth/power
  // knob, and #1673's stated premise was that this gate cannot judge it numerically:
  // software rasterizers and desktop ANGLE were assumed to implement mediump as full f32,
  // making a highp-vs-mediump pixel-diff green by construction — an assertion that cannot
  // distinguish the two states (§12). Rather than assume it, MEASURE it. The census has
  // TWO halves, because they answer different questions and here they DISAGREE:
  //
  //   (a) DECLARED — getShaderPrecisionFormat over LOW/MEDIUM/HIGH float × both stages.
  //       This is what the driver ADVERTISES, and it is what a runtime feature-detect
  //       would read.
  //   (b) OBSERVED — compile the SAME fragment source twice, once under `precision
  //       mediump float;` and once under `precision highp float;`, evaluate a quantity
  //       that is destroyed by an fp16 mantissa and survives an f32 one, and read the
  //       pixel back. This is what the shader actually COMPUTES.
  //
  // The probe quantity is ((1.0 + eps) - 1.0) * 4096.0 with eps = 2^-12, fed through a
  // uniform so no CPU-side constant-folding can pre-compute it. ULP(1.0) is 2^-10 in
  // fp16, so 2^-12 is below the half-ULP tie and 1.0 + eps rounds back to exactly 1.0 →
  // the probe reads 0. In f32 ULP(1.0) is 2^-23, the add is exact, and the probe reads
  // 1.0 → 255. The highp arm is the CONTROL: it must read 255, otherwise the probe is
  // measuring itself rather than the precision qualifier.
  //
  // Neither half is asserted as a threshold — both are DATA. The gate asserts only that
  // the measurement HAPPENED (six cells answered, both arms compiled) and that the
  // control arm behaved, then prints the numbers and derives the verdict from them. The
  // verdict is what licenses the scope statement in AUTHORING.md and on #1673.
  test('census: declared vs observed mediump float precision (getShaderPrecisionFormat + fp16 probe)', async ({
    page,
  }) => {
    await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })

    const census = await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 4
      canvas.height = 4
      const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true })
      if (!gl) return { fatal: 'no webgl2 context' as const }

      // ── (a) DECLARED ──
      const stages = [
        ['VERTEX', gl.VERTEX_SHADER],
        ['FRAGMENT', gl.FRAGMENT_SHADER],
      ] as const
      const kinds = [
        ['LOW_FLOAT', gl.LOW_FLOAT],
        ['MEDIUM_FLOAT', gl.MEDIUM_FLOAT],
        ['HIGH_FLOAT', gl.HIGH_FLOAT],
      ] as const
      const rows: {
        stage: string
        kind: string
        rangeMin: number
        rangeMax: number
        precision: number
      }[] = []
      for (const [stageName, stage] of stages)
        for (const [kindName, kind] of kinds) {
          const f = gl.getShaderPrecisionFormat(stage, kind)
          if (!f) continue
          rows.push({
            stage: stageName,
            kind: kindName,
            rangeMin: f.rangeMin,
            rangeMax: f.rangeMax,
            precision: f.precision,
          })
        }

      // ── (b) OBSERVED ──
      // Fullscreen triangle from gl_VertexID: no attribute buffers needed.
      const VS = `#version 300 es
precision highp float;
precision highp int;
void main() {
  float x = float((gl_VertexID & 1) * 4 - 1);
  float y = float((gl_VertexID >> 1) * 4 - 1);
  gl_Position = vec4(x, y, 0.0, 1.0);
}
`
      const fsFor = (p: 'mediump' | 'highp'): string => `#version 300 es
precision ${p} float;
precision highp int;
uniform float u_eps;
out vec4 fragColor;
void main() {
  float survived = ((1.0 + u_eps) - 1.0) * 4096.0;
  fragColor = vec4(survived, 0.0, 0.0, 1.0);
}
`
      const runProbe = (p: 'mediump' | 'highp'): { ok: boolean; log: string; red: number } => {
        const mk = (type: number, src: string): WebGLShader => {
          const sh = gl.createShader(type)!
          gl.shaderSource(sh, src)
          gl.compileShader(sh)
          return sh
        }
        const vsh = mk(gl.VERTEX_SHADER, VS)
        const fsh = mk(gl.FRAGMENT_SHADER, fsFor(p))
        const vsOk = gl.getShaderParameter(vsh, gl.COMPILE_STATUS) as boolean
        const fsOk = gl.getShaderParameter(fsh, gl.COMPILE_STATUS) as boolean
        if (!vsOk || !fsOk)
          return {
            ok: false,
            log: `${gl.getShaderInfoLog(vsh) ?? ''}${gl.getShaderInfoLog(fsh) ?? ''}`,
            red: -1,
          }
        const prog = gl.createProgram()!
        gl.attachShader(prog, vsh)
        gl.attachShader(prog, fsh)
        gl.linkProgram(prog)
        if (!(gl.getProgramParameter(prog, gl.LINK_STATUS) as boolean))
          return { ok: false, log: gl.getProgramInfoLog(prog) ?? '', red: -1 }
        gl.useProgram(prog)
        // 2^-12 — below fp16's half-ULP at 1.0 (2^-11), exact in f32.
        gl.uniform1f(gl.getUniformLocation(prog, 'u_eps'), 1 / 4096)
        gl.viewport(0, 0, 4, 4)
        gl.clearColor(0, 0, 0, 1)
        gl.clear(gl.COLOR_BUFFER_BIT)
        gl.bindVertexArray(gl.createVertexArray())
        gl.drawArrays(gl.TRIANGLES, 0, 3)
        const px = new Uint8Array(4)
        gl.readPixels(2, 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
        return { ok: true, log: '', red: px[0]! }
      }

      const dbg = gl.getExtension('WEBGL_debug_renderer_info')
      return {
        renderer: gl.getParameter(gl.RENDERER) as string,
        unmaskedRenderer: dbg
          ? (gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) as string)
          : '(WEBGL_debug_renderer_info unavailable)',
        version: gl.getParameter(gl.VERSION) as string,
        rows,
        probeMediump: runProbe('mediump'),
        probeHighp: runProbe('highp'),
      }
    })

    expect(
      census,
      `WebGL2 unavailable: ${'fatal' in census ? census.fatal : ''}`,
    ).not.toHaveProperty('fatal')
    if ('fatal' in census) return

    const med = census.rows.filter((r) => r.kind === 'MEDIUM_FLOAT')
    const high = census.rows.filter((r) => r.kind === 'HIGH_FLOAT')
    const declaredSame = med.every((m, i) => m.precision === high[i]!.precision)
    // The probe reads 255 when the fp16-destroyed quantity SURVIVED (computed at f32).
    const observedSame = census.probeMediump.red === census.probeHighp.red

    // The printout IS this test's deliverable — the numbers are what the scope
    // statement on #1673 and in AUTHORING.md §9 cite.
    console.log(
      [
        `#1673 census — RENDERER: ${census.renderer}`,
        `#1673 census — UNMASKED: ${census.unmaskedRenderer}`,
        `#1673 census — VERSION:  ${census.version}`,
        '#1673 census — (a) DECLARED via getShaderPrecisionFormat:',
        ...census.rows.map(
          (r) =>
            `#1673 census —     ${r.stage.padEnd(8)} ${r.kind.padEnd(12)} ` +
            `{ rangeMin: ${r.rangeMin}, rangeMax: ${r.rangeMax}, precision: ${r.precision} }`,
        ),
        '#1673 census — (b) OBSERVED via ((1.0 + 2^-12) - 1.0) * 4096.0 → red channel',
        '#1673 census —     (255 = the f32-only bit survived, 0 = rounded away as fp16):',
        `#1673 census —     mediump arm: red=${census.probeMediump.red} ` +
          `(compiled=${census.probeMediump.ok})`,
        `#1673 census —     highp arm:   red=${census.probeHighp.red} ` +
          `(compiled=${census.probeHighp.ok}) <- control`,
        declaredSame === observedSame
          ? `#1673 census — VERDICT: declared and observed AGREE (${declaredSame ? 'mediump == highp' : 'mediump != highp'}).`
          : '#1673 census — VERDICT: DECLARED and OBSERVED DISAGREE. The stack ADVERTISES ' +
            `mediump as ${med[0]?.precision}-bit (fp16) but the probe reads ` +
            `${observedSame ? 'full-f32 behavior — computed at >=f32, or the (1+eps)-1 form was reassociated; either way indistinguishable' : 'reduced precision'}. ` +
            'Precision-format advertising is a minimum, not a promise, and somewhere in this ' +
            'ANGLE/SwiftShader stack (translator or rasterizer — the probe cannot attribute ' +
            'the layer, and the CI-blindness verdict is identical either way) only the ' +
            'minimum is honoured. ' +
            'Therefore this gate can prove COMPILE VALIDITY + HEADER SHAPE only for the ' +
            '#1673 knob: no CI pixel-diff can distinguish a highp emit from a mediump one, ' +
            'and real-device mediump behavior (true fp16 range/precision, the bandwidth win, ' +
            'the banding it can cause) is out of CI reach — an EXPLICIT stated skip.',
      ].join('\n'),
    )

    // The measurement happened: six cells answered, both arms compiled and linked.
    expect(census.rows).toHaveLength(6)
    expect(census.probeMediump.ok, `mediump probe failed: ${census.probeMediump.log}`).toBe(true)
    expect(census.probeHighp.ok, `highp probe failed: ${census.probeHighp.log}`).toBe(true)
    // CONTROL: at highp the f32-only bit MUST survive, or the probe is measuring itself
    // (a folded constant, a clamped output, a dead uniform) instead of the qualifier.
    expect(
      census.probeHighp.red,
      'highp control did not preserve 2^-12 at 1.0 — the probe is not measuring precision',
    ).toBe(255)
  })

  // #1673 — a mediump emit is still VALID GLSL ES 3.00 on a real driver. This is the
  // whole of what CI can prove about the knob (see the census above): the unit suite pins
  // the header bytes, and this pins that those bytes compile and link. Both stages,
  // because the float precision default is per-stage and a vertex/fragment mismatch in
  // the shared varyings is a LINK error, not a compile one — asserting only the fragment
  // would miss it.
  test('#1673: a {floatPrecision:mediump} emit compiles + links on real WebGL2', async ({
    page,
  }) => {
    const vertex = emitGlslModule(module, 'vertex', { floatPrecision: 'mediump' })
    const fragment = emitGlslModule(module, 'fragment', { floatPrecision: 'mediump' })
    expect(vertex).toContain('precision mediump float;')
    expect(fragment).toContain('precision mediump float;')
    // the load-bearing int line survived into the source the driver actually sees
    expect(vertex).toContain('precision highp int;')
    expect(fragment).toContain('precision highp int;')

    await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })

    const result = await page.evaluate(
      ({ vertex, fragment }) => {
        const canvas = document.createElement('canvas')
        const gl = canvas.getContext('webgl2')
        if (!gl) return { fatal: 'no webgl2 context' as const }
        const mk = (type: number, src: string): WebGLShader => {
          const sh = gl.createShader(type)!
          gl.shaderSource(sh, src)
          gl.compileShader(sh)
          return sh
        }
        const vsh = mk(gl.VERTEX_SHADER, vertex)
        const fsh = mk(gl.FRAGMENT_SHADER, fragment)
        const vs = {
          ok: gl.getShaderParameter(vsh, gl.COMPILE_STATUS) as boolean,
          log: gl.getShaderInfoLog(vsh) ?? '',
        }
        const fs = {
          ok: gl.getShaderParameter(fsh, gl.COMPILE_STATUS) as boolean,
          log: gl.getShaderInfoLog(fsh) ?? '',
        }
        let linkOk = false
        let linkLog = ''
        if (vs.ok && fs.ok) {
          const prog = gl.createProgram()!
          gl.attachShader(prog, vsh)
          gl.attachShader(prog, fsh)
          gl.linkProgram(prog)
          linkOk = gl.getProgramParameter(prog, gl.LINK_STATUS) as boolean
          linkLog = gl.getProgramInfoLog(prog) ?? ''
        }
        return { vs, fs, linkOk, linkLog }
      },
      { vertex, fragment },
    )

    expect(
      result,
      `WebGL2 unavailable: ${'fatal' in result ? result.fatal : ''}`,
    ).not.toHaveProperty('fatal')
    if ('fatal' in result) return

    expect(
      result.vs.ok,
      `mediump vertex failed to compile:\n${result.vs.log}\n--- GLSL ---\n${vertex}`,
    ).toBe(true)
    expect(
      result.fs.ok,
      `mediump fragment failed to compile:\n${result.fs.log}\n--- GLSL ---\n${fragment}`,
    ).toBe(true)
    expect(result.linkOk, `mediump program failed to link:\n${result.linkLog}`).toBe(true)
  })

  // #923: a HOST-SPECIALIZED GLSL variant compiles on real WebGL2. The unit gate
  // (override-constants.test.ts) string-matches the specialized emit, but only ANGLE
  // proves the mechanism is valid GLSL — the earlier "prepend a #define" contract
  // string-matched fine yet produced an uncompilable shader (`#version` must lead the
  // source). The emitter now places the pinned `#define` AFTER the `#version` preamble,
  // spelled via literal(); this gate compiles that variant end-to-end.
  test('a #923 host-specialized override variant compiles + links on real WebGL2', async ({
    page,
  }) => {
    // Fullscreen-triangle vertex + a fragment whose branch is guarded by an override.
    const VsOut = ioStruct('OvVsOut', {
      pos: builtin('position', vec4fT),
      uv: location(0, vec2fT),
    })
    const vsFn = fn(
      'ov_vs',
      { vi: builtin('vertex_index', u32T) },
      ({ vi }) => {
        const x = toF32(vi.bitAnd(u32(1)))
          .mul(4)
          .sub(1)
        const y = toF32(vi.shr(u32(1)))
          .mul(4)
          .sub(1)
        return VsOut.construct({
          pos: vec4(x, y, 0, 1),
          uv: vec2(x.mul(0.5).add(0.5), y.mul(0.5).add(0.5)),
        })
      },
      { stage: 'vertex' },
    )
    const quality = overrideConst('quality', f32T, 1.0)
    const fsFn = fn(
      'ov_fs',
      { inp: VsOut },
      ({ inp }) => {
        const g = Var(f32(1))
        If(quality.node.gt(f32(1)), () => {
          g.assign(f32(2))
        })
        return vec4(inp.uv.x.mul(g), inp.uv.y, f32(0), f32(1))
      },
      { stage: 'fragment', retAttr: '@location(0)' },
    )
    const overrideModule = buildModule({
      overrides: [quality.decl],
      funcs: [vsFn, fsFn],
      uses: [VsOut],
    })

    const vertex = emitGlslModule(overrideModule, 'vertex')
    // The SPECIALIZED fragment: host pins quality=2.0 → a hard `#define quality 2.0`.
    const fragment = emitGlslModule(overrideModule, 'fragment', {
      overrideValues: { quality: 2.0 },
    })
    // guardrails: valid position (never prepended) + the pinned define is present.
    expect(vertex.startsWith('#version 300 es')).toBe(true)
    expect(fragment.startsWith('#version 300 es')).toBe(true)
    expect(fragment).toContain('#define quality 2.0')
    expect(fragment).not.toContain('#ifndef quality')

    await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })

    const result = await page.evaluate(
      ({ vertex, fragment }) => {
        const canvas = document.createElement('canvas')
        const gl = canvas.getContext('webgl2')
        if (!gl) return { fatal: 'no webgl2 context' as const }

        const compile = (type: number, src: string): { ok: boolean; log: string } => {
          const sh = gl.createShader(type)!
          gl.shaderSource(sh, src)
          gl.compileShader(sh)
          const ok = gl.getShaderParameter(sh, gl.COMPILE_STATUS) as boolean
          return { ok, log: gl.getShaderInfoLog(sh) ?? '' }
        }

        const vs = compile(gl.VERTEX_SHADER, vertex)
        const fs = compile(gl.FRAGMENT_SHADER, fragment)
        let linkOk = false
        let linkLog = ''
        if (vs.ok && fs.ok) {
          const prog = gl.createProgram()!
          const vsh = gl.createShader(gl.VERTEX_SHADER)!
          gl.shaderSource(vsh, vertex)
          gl.compileShader(vsh)
          const fsh = gl.createShader(gl.FRAGMENT_SHADER)!
          gl.shaderSource(fsh, fragment)
          gl.compileShader(fsh)
          gl.attachShader(prog, vsh)
          gl.attachShader(prog, fsh)
          gl.linkProgram(prog)
          linkOk = gl.getProgramParameter(prog, gl.LINK_STATUS) as boolean
          linkLog = gl.getProgramInfoLog(prog) ?? ''
        }
        return { vs, fs, linkOk, linkLog }
      },
      { vertex, fragment },
    )

    expect(
      result,
      `WebGL2 unavailable: ${'fatal' in result ? result.fatal : ''}`,
    ).not.toHaveProperty('fatal')
    if ('fatal' in result) return

    expect(
      result.vs.ok,
      `specialized vertex failed to compile:\n${result.vs.log}\n--- GLSL ---\n${vertex}`,
    ).toBe(true)
    expect(
      result.fs.ok,
      `specialized fragment failed to compile:\n${result.fs.log}\n--- GLSL ---\n${fragment}`,
    ).toBe(true)
    expect(result.linkOk, `specialized program failed to link:\n${result.linkLog}`).toBe(true)
  })

  // #1671: a PAIRED raw Stmt — one node carrying both spellings — emits GLSL a real
  // driver accepts. The unit suite pins the bytes, but only a compiler proves the
  // spliced text is valid IN THE POSITION the emitter puts it (inside the `fs_impl`
  // body, at the enclosing indent, after the emitter's own declarations). The local
  // the payload declares is READ by the return expression, so the splice cannot be
  // dropped and still link — an unreferenced raw would compile even if the emitter
  // had mangled the statement into a comment.
  test('#1671: a paired raw Stmt compiles + links on real WebGL2', async ({ page }) => {
    const rawFs: FuncDecl = {
      name: 'fs',
      attrs: ['@fragment'],
      params: [{ name: 'inp', type: structT('VsOut') }],
      ret: structT('FsOut'),
      body: [
        // the SAME statement, spelled for each target (`let` vs a typed decl)
        rawStmt({ wgsl: 'let _rawK = 0.5;', glsl: 'float _rawK = 0.5;' }),
        {
          s: 'return',
          expr: {
            op: 'construct',
            type: structT('FsOut'),
            args: [
              v4(
                fld(fld(param('inp', structT('VsOut')), 'uv', vec2fT), 'x', f32T),
                varref('_rawK', f32T),
                lit(0),
                lit(1),
              ),
            ],
          },
        },
      ],
    }
    const rawModule: ModuleDecl = { ...module, funcs: [module.funcs[0]!, rawFs] }

    const vertex = emitGlslModule(rawModule, 'vertex')
    const fragment = emitGlslModule(rawModule, 'fragment')
    // the GLSL payload landed verbatim, and the WGSL twin never leaks into GLSL source
    expect(fragment).toContain('float _rawK = 0.5;')
    expect(fragment).not.toContain('let _rawK')

    await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })

    const result = await page.evaluate(
      ({ vertex, fragment }) => {
        const canvas = document.createElement('canvas')
        const gl = canvas.getContext('webgl2')
        if (!gl) return { fatal: 'no webgl2 context' as const }
        const mk = (type: number, src: string): WebGLShader => {
          const sh = gl.createShader(type)!
          gl.shaderSource(sh, src)
          gl.compileShader(sh)
          return sh
        }
        const vsh = mk(gl.VERTEX_SHADER, vertex)
        const fsh = mk(gl.FRAGMENT_SHADER, fragment)
        const vs = {
          ok: gl.getShaderParameter(vsh, gl.COMPILE_STATUS) as boolean,
          log: gl.getShaderInfoLog(vsh) ?? '',
        }
        const fs = {
          ok: gl.getShaderParameter(fsh, gl.COMPILE_STATUS) as boolean,
          log: gl.getShaderInfoLog(fsh) ?? '',
        }
        let linkOk = false
        let linkLog = ''
        if (vs.ok && fs.ok) {
          const prog = gl.createProgram()!
          gl.attachShader(prog, vsh)
          gl.attachShader(prog, fsh)
          gl.linkProgram(prog)
          linkOk = gl.getProgramParameter(prog, gl.LINK_STATUS) as boolean
          linkLog = gl.getProgramInfoLog(prog) ?? ''
        }
        return { vs, fs, linkOk, linkLog }
      },
      { vertex, fragment },
    )

    expect(
      result,
      `WebGL2 unavailable: ${'fatal' in result ? result.fatal : ''}`,
    ).not.toHaveProperty('fatal')
    if ('fatal' in result) return

    expect(
      result.vs.ok,
      `paired-raw vertex failed to compile:\n${result.vs.log}\n--- GLSL ---\n${vertex}`,
    ).toBe(true)
    expect(
      result.fs.ok,
      `paired-raw fragment failed to compile:\n${result.fs.log}\n--- GLSL ---\n${fragment}`,
    ).toBe(true)
    expect(result.linkOk, `paired-raw program failed to link:\n${result.linkLog}`).toBe(true)
  })

  // #1670: a HOST-SIDE capability, end to end on a real driver.
  //
  // `enables: ['floatRenderTarget']` is the class of cap that has NO token in the
  // shader source: WebGL2 activates EXT_color_buffer_float through `gl.getExtension`,
  // so the emitted GLSL must be byte-for-byte what an enables-free module emits (the
  // unit suite pins that; here we re-assert `#extension` is ABSENT before handing the
  // string to a compiler). What only a driver can prove is the other half — that the
  // declaration was WORTH making: the extension the host requested is exactly the one
  // `reflect().requiredFeatures` named, and with it active the program renders into an
  // RGBA32F attachment and the value reads BACK.
  //
  // The witness is deliberately a value ABOVE 1.0 (3.25, a constant, so no
  // interpolation is involved): an RGBA8 attachment would clamp it to 1.0 and a
  // non-float readback would quantize it, so reading 3.25 back cannot happen unless the
  // float render target really is one. A merely non-zero pixel would not distinguish
  // that (§12 — an assertion must distinguish the states of the thing it tests).
  //
  // The extension NAME is not hardcoded in the page: it is derived from
  // reflect().requiredFeatures through the GLSL backend's capProfile and passed in. If
  // the profile row ever stopped naming EXT_color_buffer_float, the page would request
  // the wrong extension and the readback would fail — which is the point.
  test('#1670: a floatRenderTarget module renders into an RGBA32F target on real WebGL2', async ({
    page,
  }) => {
    // Fullscreen triangle from gl_VertexID — no vertex buffers, same idiom as the
    // #923 override gate above.
    const VsOut = ioStruct('FrtVsOut', {
      pos: builtin('position', vec4fT),
      uv: location(0, vec2fT),
    })
    const vsFn = fn(
      'frt_vs',
      { vi: builtin('vertex_index', u32T) },
      ({ vi }) => {
        const x = toF32(vi.bitAnd(u32(1)))
          .mul(4)
          .sub(1)
        const y = toF32(vi.shr(u32(1)))
          .mul(4)
          .sub(1)
        return VsOut.construct({
          pos: vec4(x, y, 0, 1),
          uv: vec2(x.mul(0.5).add(0.5), y.mul(0.5).add(0.5)),
        })
      },
      { stage: 'vertex' },
    )
    // BLUE is the witness: a constant 3.25, out of an unsigned-normalized range.
    const fsFn = fn(
      'frt_fs',
      { inp: VsOut },
      ({ inp }) => vec4(inp.uv.x.add(2.5), inp.uv.y.add(1.5), f32(3.25), f32(1)),
      { stage: 'fragment', retAttr: '@location(0)' },
    )
    const floatRtModule = buildModule({
      enables: ['floatRenderTarget'],
      funcs: [vsFn, fsFn],
      uses: [VsOut],
    })

    // The HOST contract: reflection names the requirement, the profile translates it
    // into the concrete WebGL2 extension the page must request.
    const required = reflect(floatRtModule).requiredFeatures
    expect(required).toContain('floatRenderTarget')
    // hostFeaturesFor is THE host-activation lookup (#1670) — it drops every cap whose
    // profile row has no host half, so what comes out is exactly what a host may pass to
    // getExtension / requiredFeatures, with no undefined holes.
    const hostFeatures = hostFeaturesFor(glslEs300Backend, required)
    expect(hostFeatures).toEqual(['EXT_color_buffer_float'])

    const vertex = emitGlslModule(floatRtModule, 'vertex')
    const fragment = emitGlslModule(floatRtModule, 'fragment')
    // A host-side cap costs ZERO emitted bytes — no directive on either stage.
    expect(vertex).not.toContain('#extension')
    expect(fragment).not.toContain('#extension')
    expect(vertex.startsWith('#version 300 es\nprecision ')).toBe(true)
    expect(fragment).toContain('3.25')

    await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })

    const result = await page.evaluate(
      ({ vertex, fragment, hostFeatures }) => {
        const canvas = document.createElement('canvas')
        canvas.width = 4
        canvas.height = 4
        const gl = canvas.getContext('webgl2')
        if (!gl) return { fatal: 'no webgl2 context' as const }

        // Exactly the extensions reflect() asked for — nothing hardcoded here.
        const missing = hostFeatures.filter((h) => gl.getExtension(h) === null)
        if (missing.length > 0) return { fatal: `missing extension: ${missing.join(', ')}` }

        const mk = (type: number, src: string): WebGLShader => {
          const sh = gl.createShader(type)!
          gl.shaderSource(sh, src)
          gl.compileShader(sh)
          return sh
        }
        const vsh = mk(gl.VERTEX_SHADER, vertex)
        const fsh = mk(gl.FRAGMENT_SHADER, fragment)
        const vs = {
          ok: gl.getShaderParameter(vsh, gl.COMPILE_STATUS) as boolean,
          log: gl.getShaderInfoLog(vsh) ?? '',
        }
        const fs = {
          ok: gl.getShaderParameter(fsh, gl.COMPILE_STATUS) as boolean,
          log: gl.getShaderInfoLog(fsh) ?? '',
        }
        // ONE result shape for every non-fatal outcome, so an early compile/link
        // failure reports through the same fields the success path fills.
        const out = {
          vs,
          fs,
          linkOk: false,
          linkLog: '',
          fboStatus: 0,
          complete: gl.FRAMEBUFFER_COMPLETE as number,
          glError: 0,
          readFormat: 0,
          readType: 0,
          px: [] as number[],
        }
        if (!vs.ok || !fs.ok) return out

        const prog = gl.createProgram()!
        gl.attachShader(prog, vsh)
        gl.attachShader(prog, fsh)
        gl.linkProgram(prog)
        out.linkOk = gl.getProgramParameter(prog, gl.LINK_STATUS) as boolean
        out.linkLog = gl.getProgramInfoLog(prog) ?? ''
        if (!out.linkOk) return out

        // The float render target the capability exists for.
        const tex = gl.createTexture()!
        gl.bindTexture(gl.TEXTURE_2D, tex)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 4, 4, 0, gl.RGBA, gl.FLOAT, null)
        const fbo = gl.createFramebuffer()!
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
        out.fboStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
        out.readFormat = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT) as number
        out.readType = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE) as number
        if (out.fboStatus !== gl.FRAMEBUFFER_COMPLETE) return out

        gl.viewport(0, 0, 4, 4)
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
        gl.useProgram(prog)
        // No attributes: the vertex stage builds the triangle from gl_VertexID.
        gl.drawArrays(gl.TRIANGLES, 0, 3)

        const px = new Float32Array(4)
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, px)
        out.glError = gl.getError()
        out.px = [...px]
        return out
      },
      { vertex, fragment, hostFeatures },
    )

    // A CI browser without WebGL2 or without EXT_color_buffer_float is a GATE FAILURE,
    // not a skip: this leg exists precisely to prove the extension path works.
    expect(
      result,
      `WebGL2 float render target unavailable: ${'fatal' in result ? result.fatal : ''}`,
    ).not.toHaveProperty('fatal')
    if ('fatal' in result) return

    expect(
      result.vs.ok,
      `floatRenderTarget vertex failed to compile:\n${result.vs.log}\n--- GLSL ---\n${vertex}`,
    ).toBe(true)
    expect(
      result.fs.ok,
      `floatRenderTarget fragment failed to compile:\n${result.fs.log}\n--- GLSL ---\n${fragment}`,
    ).toBe(true)
    expect(result.linkOk, `floatRenderTarget program failed to link:\n${result.linkLog}`).toBe(true)
    expect(
      result.fboStatus,
      `RGBA32F framebuffer incomplete (status ${result.fboStatus}) — EXT_color_buffer_float active?`,
    ).toBe(result.complete)
    expect(
      result.glError,
      `GL error ${result.glError} after readPixels; implementation read format/type = ${result.readFormat}/${result.readType}`,
    ).toBe(0)
    // THE witness: the out-of-unorm-range constant survived the round trip, so the
    // attachment really is float and the readback really is float.
    expect(result.px[2], `blue channel read back as ${result.px[2]}, expected 3.25`).toBeCloseTo(
      3.25,
      4,
    )
    // …and the interpolated red channel is likewise unclamped (>1.0) and non-zero.
    expect(result.px[0]).toBeGreaterThan(1)
  })

  // #1681: a NAMED module-scope const ARRAY, on a real driver.
  //
  // `constExpr(name, arrayT(elem, n), arrayLit(...))` is public API, but only the
  // INLINE array-literal form has driver evidence (map/src/shaders/dsl/raster.ts emits
  // `uint[6](0u,…)[idx]` inside an expression). The NAMED form takes a different emit
  // path — `emitConst` → `constDecl` → `glslType({kind:'array'})` — which produces GLSL's
  // postfix-size declarator, `const int[4] STEP_TABLE = int[4](3, 1, 2, 0);`. That
  // spelling is legal GLSL ES 3.00 but is NOT the spelling most emitters produce
  // (`const int STEP_TABLE[4] = …` is the other legal form), and no unit test compiles it.
  //
  // The read is RUNTIME-INDEXED (`STEP_TABLE[int(clamp(floor(uv.x*4), 0, 3))]`), so the
  // compiler cannot constant-fold the table away and prove the declaration vacuously —
  // and the indexed value reaches `FsOut.color`, so a driver that rejected or dropped the
  // declaration would leave `STEP_TABLE` undeclared and FAIL TO COMPILE/LINK rather than
  // silently render something. The table values are a PERMUTATION (3,1,2,0), not the
  // identity: substituting the index for the table would be a distinguishable different
  // shader (§12 — an assertion must distinguish the states of the thing it tests).
  test('#1681: a named const array indexed at runtime compiles + links on real WebGL2', async ({
    page,
  }) => {
    const StepTable: ShaderType = arrayT(i32T, 4)
    const stepTable = constExpr(
      'STEP_TABLE',
      StepTable,
      arrayLit(i32T, i32(3), i32(1), i32(2), i32(0)),
    )

    const uvOf = (comp: 'x' | 'y'): Node<'f32'> =>
      new Node<'f32'>(fld(fld(param('inp', structT('VsOut')), 'uv', vec2fT), comp, f32T))
    // slot ∈ [0,3] derived from the interpolated uv — a value the compiler cannot know.
    const slot = toI32(clamp(floor(uvOf('x').mul(4)), f32(0), f32(3)))
    const shade = toF32(constRef('STEP_TABLE', StepTable).at(slot, i32T)).div(3)

    const constArrayFs: FuncDecl = {
      name: 'fs',
      attrs: ['@fragment'],
      params: [{ name: 'inp', type: structT('VsOut') }],
      ret: structT('FsOut'),
      body: [
        {
          s: 'return',
          expr: {
            op: 'construct',
            type: structT('FsOut'),
            args: [v4(shade.expr, uvOf('y').expr, lit(0), lit(1))],
          },
        },
      ],
    }
    const constArrayModule: ModuleDecl = {
      ...module,
      consts: [stepTable],
      funcs: [module.funcs[0]!, constArrayFs],
    }

    const vertex = emitGlslModule(constArrayModule, 'vertex')
    const fragment = emitGlslModule(constArrayModule, 'fragment')
    // the declaration is present in GLSL's postfix-size form, and it is actually READ
    // (an unreferenced const would compile even if the emitter had mangled it).
    expect(fragment).toContain('const int[4] STEP_TABLE = int[4](3, 1, 2, 0);')
    expect(fragment).toContain('STEP_TABLE[int(')

    await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })

    const result = await page.evaluate(
      ({ vertex, fragment }) => {
        const canvas = document.createElement('canvas')
        const gl = canvas.getContext('webgl2')
        if (!gl) return { fatal: 'no webgl2 context' as const }
        const mk = (type: number, src: string): WebGLShader => {
          const sh = gl.createShader(type)!
          gl.shaderSource(sh, src)
          gl.compileShader(sh)
          return sh
        }
        const vsh = mk(gl.VERTEX_SHADER, vertex)
        const fsh = mk(gl.FRAGMENT_SHADER, fragment)
        const vs = {
          ok: gl.getShaderParameter(vsh, gl.COMPILE_STATUS) as boolean,
          log: gl.getShaderInfoLog(vsh) ?? '',
        }
        const fs = {
          ok: gl.getShaderParameter(fsh, gl.COMPILE_STATUS) as boolean,
          log: gl.getShaderInfoLog(fsh) ?? '',
        }
        let linkOk = false
        let linkLog = ''
        if (vs.ok && fs.ok) {
          const prog = gl.createProgram()!
          gl.attachShader(prog, vsh)
          gl.attachShader(prog, fsh)
          gl.linkProgram(prog)
          linkOk = gl.getProgramParameter(prog, gl.LINK_STATUS) as boolean
          linkLog = gl.getProgramInfoLog(prog) ?? ''
        }
        return { vs, fs, linkOk, linkLog }
      },
      { vertex, fragment },
    )

    expect(
      result,
      `WebGL2 unavailable: ${'fatal' in result ? result.fatal : ''}`,
    ).not.toHaveProperty('fatal')
    if ('fatal' in result) return

    expect(
      result.vs.ok,
      `const-array vertex failed to compile:\n${result.vs.log}\n--- GLSL ---\n${vertex}`,
    ).toBe(true)
    expect(
      result.fs.ok,
      `const-array fragment failed to compile:\n${result.fs.log}\n--- GLSL ---\n${fragment}`,
    ).toBe(true)
    // THE witness: the program LINKS. `STEP_TABLE` is referenced from the fragment
    // output, so a driver that had rejected the postfix-size const-array declaration
    // could not resolve the identifier and could not produce a linked program.
    expect(result.linkOk, `const-array program failed to link:\n${result.linkLog}`).toBe(true)
  })
})

// #2444 — the COMMITTED corpora, which nothing compiled until now. The tests above cover
// map/'s production shaders; `emit-goldens.test.ts` proves the emitter still produces the
// golden bytes but not that those bytes are a program ANGLE accepts, and `baked-sync.test.ts`
// says the same about the baked store the map ships.
test.describe('GLSL committed corpora', () => {
  test('the committed GLSL goldens and baked artifacts compile on real WebGL2', async ({
    page,
  }) => {
    await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })
    const here = dirname(fileURLToPath(import.meta.url))
    const goldenDir = join(here, '../../shader-dsl/examples/__emit-goldens__')
    const files = readdirSync(goldenDir).filter((f) => f.endsWith('.glsl'))

    // The goldens come as `<name>.vertex.glsl` / `<name>.fragment.glsl`, so they LINK as
    // pairs — which catches a varying mismatch a per-shader compile cannot see.
    const stems = [...new Set(files.map((f) => f.replace(/\.(vertex|fragment)\.glsl$/, '')))].sort()
    const pairs = stems
      .filter((n) => files.includes(`${n}.vertex.glsl`) && files.includes(`${n}.fragment.glsl`))
      .map((n) => ({
        name: `golden/${n}`,
        vertex: readFileSync(join(goldenDir, `${n}.vertex.glsl`), 'utf8'),
        fragment: readFileSync(join(goldenDir, `${n}.fragment.glsl`), 'utf8'),
      }))

    // Baked GLSL is stored per STAGE (the registry id carries `/vertex/` or `/fragment/`),
    // and which vertex pairs with which fragment is registry knowledge, so these are compiled
    // individually. That still catches syntax and type errors, which is where emit bugs live.
    const singles: Array<{ name: string; stage: 'vertex' | 'fragment'; src: string }> = []
    for (const [group, art] of [
      ['boot', BAKED_GLSL_BOOT],
      ['hillshade', BAKED_GLSL_HILLSHADE],
      ['lazy', BAKED_GLSL_LAZY],
    ] as const) {
      const stageOf = new Map<string, 'vertex' | 'fragment'>()
      for (const [id, hash] of Object.entries(art.index))
        if (!stageOf.has(hash)) stageOf.set(hash, id.includes('/vertex') ? 'vertex' : 'fragment')
      for (const [hash, src] of Object.entries(art.contents))
        singles.push({
          name: `baked/${group}/${hash.slice(0, 8)}`,
          stage: stageOf.get(hash) ?? 'fragment',
          src,
        })
    }

    // Floors, so a corpus that silently stopped being found fails HERE rather than vacuously.
    expect(pairs.length, 'no golden GLSL pairs found').toBeGreaterThanOrEqual(30)
    expect(singles.length, 'no baked GLSL sources found').toBeGreaterThanOrEqual(20)

    const result = await page.evaluate(
      ({ pairs, singles }) => {
        const canvas = document.createElement('canvas')
        const gl = canvas.getContext('webgl2')
        if (!gl) return { fatal: 'no webgl2 context' as const }
        const compile = (type: number, src: string): { ok: boolean; log: string } => {
          const sh = gl.createShader(type)!
          gl.shaderSource(sh, src)
          gl.compileShader(sh)
          return {
            ok: gl.getShaderParameter(sh, gl.COMPILE_STATUS) as boolean,
            log: gl.getShaderInfoLog(sh) ?? '',
          }
        }
        const failures: string[] = []
        for (const p of pairs) {
          const vs = compile(gl.VERTEX_SHADER, p.vertex)
          const fs = compile(gl.FRAGMENT_SHADER, p.fragment)
          if (!vs.ok) failures.push(`${p.name} vertex: ${vs.log.slice(0, 200)}`)
          if (!fs.ok) failures.push(`${p.name} fragment: ${fs.log.slice(0, 200)}`)
          if (!vs.ok || !fs.ok) continue
          const prog = gl.createProgram()!
          const vsh = gl.createShader(gl.VERTEX_SHADER)!
          gl.shaderSource(vsh, p.vertex)
          gl.compileShader(vsh)
          const fsh = gl.createShader(gl.FRAGMENT_SHADER)!
          gl.shaderSource(fsh, p.fragment)
          gl.compileShader(fsh)
          gl.attachShader(prog, vsh)
          gl.attachShader(prog, fsh)
          gl.linkProgram(prog)
          if (!(gl.getProgramParameter(prog, gl.LINK_STATUS) as boolean))
            failures.push(`${p.name} link: ${(gl.getProgramInfoLog(prog) ?? '').slice(0, 200)}`)
        }
        for (const s of singles) {
          const r = compile(s.stage === 'vertex' ? gl.VERTEX_SHADER : gl.FRAGMENT_SHADER, s.src)
          if (!r.ok) failures.push(`${s.name} (${s.stage}): ${r.log.slice(0, 200)}`)
        }
        return { failures, pairs: pairs.length, singles: singles.length }
      },
      { pairs, singles },
    )

    expect(result, 'WebGL2 unavailable').not.toHaveProperty('fatal')
    if ('fatal' in result) return
    console.log(
      `[glsl-corpus] ${result.pairs} golden pairs linked + ${result.singles} baked sources compiled on ANGLE`,
    )
    expect(
      result.failures,
      `committed GLSL failed on real WebGL2:\n${result.failures.join('\n')}`,
    ).toEqual([])
  })
})
