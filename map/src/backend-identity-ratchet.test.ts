// ═══ Backend-identity ratchet — `backend === / !== 'webgl2'|'webgpu'` shrink-only (#1046 F1) ═══
//
// The twin-frame program replaces backend-IDENTITY switches (`backend === 'webgl2'`)
// with capability queries (`rhi.caps.*`, doc §1.4/§2). This gate locks the count of
// identity comparisons in map/src as a shrink-only high-water mark: a new one fails
// the build; each phase that ports a site to a cap LOWERS the baseline. It does NOT
// forbid the sites (they retire across F3–F6, ending at the annotated #991 P6/P7
// residue, doc §6.3), it forbids GROWTH.
//
// Baseline 38 measured at fdcb3a1 (2026-07-14): 34 `===` sites + 4 `!==` sites — the
// doc's "38 non-test backend === sites" (§1.4) counts both comparison directions, since
// a `backend !==` is just as much an identity switch as a `backend ===`.
// 38→39 (#826): RetainedParticleDraper's GLSL-twin-source guard (particle-retained-
// material.ts) — the SAME #823 dual-source-material pattern every sibling draper in the
// baseline carries (arrow/circle/icon). A new dual-source primitive structurally needs
// this one identity read until the twin-source selection gets a real cap (no RhiCaps
// field expresses "consumes GLSL ES 3.00 sources" today); it retires with the others
// across F3–F6.
// 39→40 (#1057): PointDraper's GLSL-twin-source guard (point-material.ts) — the same
// structural class as the #826 particle entry above (dual-source Material needs one
// identity read to select its GLSL ES 3.00 sources); retires with the sibling draper
// guards when the twin-source selection gets its real cap across F3–F6.
// 40→41 (#1062, reconciled at the #1057 merge): GraticuleRenderer.setEnabled skips the
// eager WebGPU-buffer prime on the twin (ctx.device is the fail-loud proxy there) via
// one backend read — landed unbumped because the pre-#1212 precheck never ran the map
// leg; the twin-boot guard class retires with the F3–F6 sweep like the rest.
// 41→45 (#777 Phase II, merge union): HillshadeRenderer mirrors RasterRenderer's four
// backend splits — the DEM tile load (webgl2 bitmap+copyExternalImage vs webgpu
// loadImageTexture), the getSampleCount pick, the draw-pass wrap, and the evict
// destroy. Same still-blocked pattern raster-renderer carries; retires when the
// tile-load / pass-wrap / destroy sites move behind rhi.caps.* alongside raster.
// 45→46 (#1272): CoverageRenderer.render mirrors raster/hillshade's draw-pass wrap
// (webgl2 RhiRenderPass vs webgpu wrapWebGpuPass) — the same still-blocked pattern,
// retires with them when the pass-wrap moves behind rhi.caps.*.
// 46→47 (hillshade first-paint): HillshadeDraper.materialFor skips the WGSL emit when
// the device cannot consume it. Same structurally-blocked class as the #826 particle and
// #1057 point entries — "which shader language does this backend consume" has no RhiCaps
// field, so selecting (or here, DECLINING to build) a source language still costs one
// identity read. It is load-bearing rather than cosmetic: rhi-webgl2's createPipeline
// requires GLSL vsCode/fsCode and never reads `desc.code`, so on that backend the emit
// was 693 ms of a measured 2211 ms first-draw main-thread block for `multidirectional`.
// All three retire together the moment RhiCaps grows that field (F3–F6).
// 47→43 (shared-lowering twin): `glslStagesFor` moved the GLSL half of the
// source selection into wgsl-for.ts beside `wgslFor`, both routed through its single
// `readsWgsl`. Five drapers — arrow / circle / icon / particle retained, and point — held
// a `const gl2` for NOTHING BUT that selection, so switching them RETIRED five reads
// outright; a sixth arrived from main in the same window, which is why the measured
// count is 43 rather than 42. This is the shrink the F3–F6 sweep is for, taken early
// because the call sites now go through one place. Lowered to the measured count, not
// to a round number.
// 43→42 (RhiCaps.shaderLanguage): `readsWgsl` now asks the CAPABILITY — 'wgsl' reads
// RhiPipelineDesc.code, 'glsl-es300' reads vsCode/fsCode — instead of the backend's
// identity, retiring the last read in that seam. This is the shape the doc's §1.4/§2 ask
// for and the one #826/#1057 said did not exist yet: a THIRD backend now answers by
// populating a cap, not by joining a `!== 'webgl2'` chain. Every consumer takes the
// narrow `ShaderSourceDevice` (caps only), so nothing downstream can reach for .backend.
//
// 42→38 (#1046 Inc-F, measured at this commit): `interaction-controller.pickAt` asked
// which backend it was on to choose the pick READBACK strategy; it now asks
// `caps.pickReadback === 'sync'` — the cap minted for exactly that decision, whose
// rhi.ts doc names this call site as its consumer. That is one read (39→38); the other
// three were already retired by earlier increments in this program without the baseline
// being lowered to match, so this locks the measured count rather than a remembered one.
//
// 38→35 (#1679 increment 0, measured at this commit): `RetainedArrowAdvectedDraper` held the
// last of the dual-source `const gl2` selections the 47→43 entry above retired everywhere
// else — its GLSL half was guarded by an identity read while its WGSL half was not guarded at
// all — and both halves now go through `wgsl-for.ts`, i.e. through `caps.shaderLanguage`. That
// is one read (36→35); the other two had already been retired by earlier increments without
// the baseline following them down, so this locks the MEASURED count rather than a remembered
// one, exactly as the 42→38 entry did.
//
// 35→33 (#1679 increment 7, measured at this commit): `LineRhiDraper` was the last draper
// whose GLSL half never went through the seam at all — inc 0 routed seven others but missed
// this one, because line spells its stages as an EMITTER ARGUMENT
// (`emitLineGlsl(variant, pick, stageArg)`) rather than as a `…GlslStages` pair. Both of its
// `const gl2` reads are gone: the source now comes from `glslFor` and the entry-array GROUP
// selection from `readsWgsl`, which is the same question asked once. Two reads, 35→33.
//
// 33→32 (#1623): HillshadeRenderer.loadTileTexture's `this.rhi.backend !== 'webgl2'` fork
// (the WebGPU raw-device `loadImageTexture` arm, the raster family's last one — #1579
// closed raster's own copy) is gone; both backends load through the RHI unconditionally.
//
// 32->31 (#2474): the globe fill drape's `bakeAvailable` asked for the device's NAME
// because no cap expressed what the bake needs — an offscreen pass on an OUT-OF-FRAME
// encoder. `RhiCaps.outOfFramePasses` is that cap, and the read is gone. Recorded with
// it, because the count alone cannot show this: the site was born WITH its feature
// (#1022), so it sat inside every baseline this program ever set and no growth check
// could reach it. The `zero identity reads in the drape's routing` test below is the
// presence assertion that closes that hole for this subsystem.
//
// Applies the #996 lesson (a source-scan gate whose matcher silently matches nothing is
// vacuously green): two guards below prove the regex still matches AND the walk still
// reaches the real tree, so `count <= BASELINE` can never pass by scanning an empty set.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAP_SRC = join(dirname(fileURLToPath(import.meta.url)))
const BASELINE = 31

// `.backend` identity comparison, either direction, against either backend literal.
const PATTERN = 'backend\\s*(===|!==)\\s*[\'"](webgl2|webgpu)[\'"]'
const makeRe = (): RegExp => new RegExp(PATTERN, 'g')

function walkSrcTs(absDir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(absDir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.vite') continue
    const p = join(absDir, name)
    if (statSync(p).isDirectory()) out.push(...walkSrcTs(p))
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts'))
      out.push(p)
  }
  return out
}

function countIn(abs: string): number {
  return (readFileSync(abs, 'utf8').match(makeRe()) ?? []).length
}

describe('backend-identity ratchet: map/src `backend ===/!==` shrink-only (#1046 F1)', () => {
  const files = walkSrcTs(MAP_SRC)

  it('the matcher still matches identity comparisons (not vacuous — #996)', () => {
    expect("if (dev.backend === 'webgl2')".match(makeRe())).toHaveLength(1)
    expect("x.backend !== 'webgpu' && y.backend === 'webgl2'".match(makeRe())).toHaveLength(2)
    // must NOT match a non-identity comparison or an unrelated backend literal
    expect("backend === 'metal'".match(makeRe())).toBeNull()
    expect('caps.compute === "native"'.match(makeRe())).toBeNull()
  })

  it('the walk reaches the real map/src tree (not vacuous — #996)', () => {
    expect(files.length).toBeGreaterThan(0)
    // render-loop.ts is the stable frame shell — its presence proves the walk hit the tree.
    expect(files.some((f) => f.endsWith(join('map', 'src', 'render-loop.ts')))).toBe(true)
  })

  it(`no more than ${BASELINE} backend-identity comparisons in map/src (shrink-only)`, () => {
    const perFile = files
      .map((f) => ({ f, n: countIn(f) }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n)
    const total = perFile.reduce((s, x) => s + x.n, 0)
    const breakdown = perFile
      .map((x) => `  ${x.n}  ${x.f.slice(x.f.indexOf('map/src'))}`)
      .join('\n')
    expect(
      total,
      `map/src holds ${total} backend-identity comparisons (> baseline ${BASELINE}). ` +
        `Replace with rhi.caps.* (doc §2) or lower the baseline when a phase ports sites.\n${breakdown}`,
    ).toBeLessThanOrEqual(BASELINE)
  })
})

// ═══ #2474 — a PRESENCE gate, because the count ratchet above cannot be one ═══
//
// The ratchet is a shrink-only high-water mark: it forbids GROWTH. A site that lands
// in the SAME commit as its feature is therefore inside every baseline the program
// ever sets, and no growth check can reach it — which is exactly how the globe fill
// drape kept `bakeAvailable` on the device's NAME from #1022 until #2474, through a
// program (#1046 F1) whose stated close-out was "ratchet baseline {} for identity
// reads". The symptom took two years of zooms to surface: WebGL2 never baked, so the
// two backends had been drawing the globe differently the whole time, and it only
// became visible when #2093 improved the arm only one of them was on.
//
// So this subsystem asserts PRESENCE — zero, here, always — rather than a count.
// Scoped deliberately: it is not a repo-wide ban (the remaining sites retire on their
// own increments), it is the one subsystem that has already paid for the lesson.

/** The drape's own files. Backend-neutral by construction — the dependency was only
 *  ever at the encoder seam — so zero is the honest assertion, not an aspiration. */
const DRAPE_FILES = [
  join('render', 'vector-drape-renderer.ts'),
  join('render', 'vector-drape-cache.ts'),
  join('render', 'vector-drape-stroke.ts'),
  join('render', 'drape-overzoom-dispatch.ts'),
  join('render', 'globe-drape-budget.ts'),
] as const

/** The `bakeAvailable` initializer, as source text: from its declaration through the
 *  last conjunct (the first line not ending in `&&`). Throws rather than returning
 *  empty if the declaration is renamed — a scan gate that silently matches nothing is
 *  vacuously green (#996), and this one has exactly one thing to find. */
function drapeRoutingExpr(src: string): string {
  const i = src.indexOf('const bakeAvailable =')
  if (i < 0) throw new Error('`const bakeAvailable =` not found — the drape routing site moved')
  const lines = src.slice(i).split('\n')
  const out = [lines[0]]
  for (let k = 1; k < lines.length; k++) {
    out.push(lines[k])
    if (!lines[k].trimEnd().endsWith('&&')) break
  }
  return out.join('\n')
}

describe("#2474 presence gate: the globe drape's routing reads a CAPABILITY", () => {
  it('`bakeAvailable` asks caps.outOfFramePasses and names no backend', () => {
    const vtr = readFileSync(join(MAP_SRC, 'render', 'vector-tile-renderer.ts'), 'utf8')
    const expr = drapeRoutingExpr(vtr)
    // CAUSE before EFFECT (§12): the cap must be what is read...
    expect(expr, `the drape's routing site no longer reads the capability:\n${expr}`).toContain(
      'caps.outOfFramePasses',
    )
    // ...and no identity comparison may come back to stand beside it.
    expect(
      expr.match(makeRe()),
      `the drape's routing site reads backend identity again:\n${expr}`,
    ).toBeNull()
  })

  it('the drape subsystem itself holds none (allowlist keys all resolve — #996)', () => {
    for (const rel of DRAPE_FILES) {
      const abs = join(MAP_SRC, rel)
      // A path-keyed allowlist dies silently when the files move; assert each key
      // still names a file before believing the zero it reports.
      expect(statSync(abs).isFile(), `${rel} moved — this allowlist is path-keyed`).toBe(true)
      expect(countIn(abs), `${rel} now reads backend identity`).toBe(0)
    }
  })
})
