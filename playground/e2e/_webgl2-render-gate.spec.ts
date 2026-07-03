// ═══ WebGL2 RHI render gate — the fallback PROOF ═══
//
// The culmination of the RHI / GLSL-backend work: the runtime WebGl2Device renders
// a texture-sampling fullscreen quad in a REAL WebGL2 context and reads back the
// sampled 2×2 checker. Proves end-to-end: GLSL program link + std140 UBO upload +
// texture-unit binding + VAO/attributes + draw + CORRECT pixels — the WebGL2 half
// of a future WebGPU→WebGL2 fallback, exercised THROUGH the same RhiDevice seam the
// 6 committed primitives target on WebGPU.
//
// The proof itself (resource creation, draw, readback) lives in _webgl2-proof.ts so
// it runs in the browser (a live WebGL2 context exists only there). This spec
// dynamic-imports that vite-served module on the dev-server origin, runs it, and the
// MAIN CONTEXT asserts SPECIFIC pixel values (not just non-blank) + no gl error.

import { test, expect } from '@playwright/test'

type Quad = number[]
const eqColor = (got: Quad, want: Quad, tol = 4) =>
  got.length === 4 && want.every((c, i) => Math.abs(got[i] - c) <= tol)

test('WebGL2 RHI render proof: WebGl2Device samples a 2×2 checker, readback matches', async ({
  page,
}) => {
  test.setTimeout(30_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  // any vite-served page on the dev origin — gives a context to dynamic-import the
  // proof module (which pulls in the runtime WebGl2Device + the shader-dsl GLSL backend).
  await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })

  const result = await page.evaluate(async () => {
    const mod = await import('/e2e/_webgl2-proof.ts')
    return mod.runWebgl2Proof()
  })

  // surface the emitted GLSL + readback for the failure message.
  const ctx = `glError=${result.glError} (NO_ERROR=${result.glNoError})
sampled BL=${result.bottomLeft} BR=${result.bottomRight} TL=${result.topLeft} TR=${result.topRight}
expected BL=${result.expected.bottomLeft} BR=${result.expected.bottomRight} TL=${result.expected.topLeft} TR=${result.expected.topRight}
clear=${result.expected.clear}
--- VERTEX GLSL ---
${result.vsGlsl}
--- FRAGMENT GLSL ---
${result.fsGlsl}`

  expect(result.fatal, `WebGL2 unavailable: ${result.fatal}`).toBeFalsy()
  expect(errors, `page errors:\n${errors.join('\n')}`).toEqual([])

  // no gl error through link → upload → bind → draw → readback.
  expect(result.glError, `gl.getError != NO_ERROR\n${ctx}`).toBe(result.glNoError)

  // SPECIFIC sampled colors: each quadrant must show its checker texel (proves the
  // texture was actually sampled, the UBO uploaded, and the quad drew), and NONE may
  // read as the magenta clear (proves the quad covered + replaced the framebuffer).
  expect(
    eqColor(result.bottomLeft, result.expected.bottomLeft),
    `bottom-left mismatch\n${ctx}`,
  ).toBe(true)
  expect(
    eqColor(result.bottomRight, result.expected.bottomRight),
    `bottom-right mismatch\n${ctx}`,
  ).toBe(true)
  expect(eqColor(result.topLeft, result.expected.topLeft), `top-left mismatch\n${ctx}`).toBe(true)
  expect(eqColor(result.topRight, result.expected.topRight), `top-right mismatch\n${ctx}`).toBe(
    true,
  )

  for (const q of [result.bottomLeft, result.bottomRight, result.topLeft, result.topRight]) {
    expect(
      eqColor(q, result.expected.clear),
      `a quadrant read as the magenta CLEAR (quad did not draw)\n${ctx}`,
    ).toBe(false)
  }
})

test('WebGL2 RHI reflection BY NAME: a multi-texture group binds correctly regardless of order', async ({
  page,
}) => {
  test.setTimeout(30_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })

  const r = await page.evaluate(async () => {
    const mod = await import('/e2e/_webgl2-proof.ts')
    return mod.runWebgl2ReflectionProof()
  })

  const ctx = `glError=${r.glError} (NO_ERROR=${r.glNoError})
named   left=${r.named.left} right=${r.named.right}
ordered left=${r.ordered.left} right=${r.ordered.right}
expected left(tex_a)=${r.expected.left} right(tex_b)=${r.expected.right}`

  expect(r.fatal, `WebGL2 unavailable: ${r.fatal}`).toBeFalsy()
  expect(errors, `page errors:\n${errors.join('\n')}`).toEqual([])
  expect(r.glError, `gl error\n${ctx}`).toBe(r.glNoError)

  // BY NAME: each sampler binds to its own texture unit → left=tex_a(red), right=tex_b(blue).
  expect(eqColor(r.named.left, r.expected.left), `named left should be tex_a (red)\n${ctx}`).toBe(
    true,
  )
  expect(
    eqColor(r.named.right, r.expected.right),
    `named right should be tex_b (blue)\n${ctx}`,
  ).toBe(true)

  // BY ORDER (names stripped, reversed layout-entry order): the units SWAP → left/right
  // flip. This proves the construction genuinely depends on name-pairing — the named
  // pass above is correct ONLY because the reflection bound by name, not by order.
  expect(
    eqColor(r.ordered.left, r.expected.right),
    `ordered left should SWAP to tex_b (blue)\n${ctx}`,
  ).toBe(true)
  expect(
    eqColor(r.ordered.right, r.expected.left),
    `ordered right should SWAP to tex_a (red)\n${ctx}`,
  ).toBe(true)
})

test('WebGL2 RHI renders a REAL DSL shader (overdraw-compose) — readback matches the colormap', async ({
  page,
}) => {
  test.setTimeout(30_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })

  const r = await page.evaluate(async () => {
    const mod = await import('/e2e/_webgl2-proof.ts')
    return mod.runWebgl2OverdrawProof()
  })

  const ctx = `glError=${r.glError} (NO_ERROR=${r.glNoError})
empty(count0)=${r.empty} expected=${r.expectedEmpty}
full(count16)=${r.full} expected=${r.expectedFull}`

  expect(r.fatal, `WebGL2 unavailable: ${r.fatal}`).toBeFalsy()
  expect(errors, `page errors:\n${errors.join('\n')}`).toEqual([])
  expect(r.glError, `gl error\n${ctx}`).toBe(r.glNoError)

  // EMPTY accumulator (count 0) → the shader's "no fragments" dark-navy branch.
  expect(eqColor(r.empty, r.expectedEmpty, 2), `empty accum should be dark navy\n${ctx}`).toBe(true)
  // SATURATED (count 16) → colormap(1) = red. Proves textureLoad + the colormap math ran.
  expect(eqColor(r.full, r.expectedFull, 2), `count-16 accum should colormap to red\n${ctx}`).toBe(
    true,
  )
})

test('WebGL2 RHI STORAGE→data-texture: reads a storage array<f32> via emulation', async ({
  page,
}) => {
  test.setTimeout(30_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })

  const r = await page.evaluate(async () => {
    const mod = await import('/e2e/_webgl2-proof.ts')
    return mod.runWebgl2StorageProof()
  })

  const ctx = `glError=${r.glError} (NO_ERROR=${r.glNoError})
left=${r.left} mid=${r.mid} right=${r.right} expected grey ${r.expected.left}/${r.expected.mid}/${r.expected.right}
--- FRAGMENT GLSL ---
${r.fsGlsl}`

  expect(r.fatal, `WebGL2 unavailable: ${r.fatal}`).toBeFalsy()
  expect(errors, `page errors:\n${errors.join('\n')}`).toEqual([])
  expect(r.glError, `gl error\n${ctx}`).toBe(r.glNoError)

  // each screen third read storage index 0/1/2 → data 0.25/0.5/0.75 as grey. Proves the
  // storage array was uploaded to + read from the emulated data texture via texelFetch.
  const grey = (q: number[], v: number) =>
    Math.abs(q[0] - v) <= 3 && Math.abs(q[1] - v) <= 3 && Math.abs(q[2] - v) <= 3
  expect(grey(r.left, r.expected.left), `left third = data[0] (0.25→64 grey)\n${ctx}`).toBe(true)
  expect(grey(r.mid, r.expected.mid), `mid third = data[1] (0.5→128 grey)\n${ctx}`).toBe(true)
  expect(grey(r.right, r.expected.right), `right third = data[2] (0.75→191 grey)\n${ctx}`).toBe(
    true,
  )
})

test('WebGL2 RHI MULTI-STORAGE: two storage buffers → two data textures, bound by name', async ({
  page,
}) => {
  test.setTimeout(30_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })

  const r = await page.evaluate(async () => {
    const mod = await import('/e2e/_webgl2-proof.ts')
    return mod.runWebgl2MultiStorageProof()
  })
  const ctx = `glError=${r.glError} px=${r.px} expected=${r.expected}`
  expect(r.fatal, `WebGL2 unavailable: ${r.fatal}`).toBeFalsy()
  expect(errors, `page errors:\n${errors.join('\n')}`).toEqual([])
  expect(r.glError, `gl error\n${ctx}`).toBe(r.glNoError)
  // R = data_a[0]=0.3→76, G = data_b[0]=0.6→153. Proves both storage buffers bound to their
  // own data texture + read by name (swap/miss would corrupt a channel).
  expect(eqColor(r.px, r.expected, 3), `multi-storage channels mismatch\n${ctx}`).toBe(true)
})

test('WebGL2 RHI STORAGE bitcast-u32 lanes (feat_data denormal-bits risk)', async ({ page }) => {
  test.setTimeout(30_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })
  const r = await page.evaluate(async () => {
    const mod = await import('/e2e/_webgl2-proof.ts')
    return mod.runWebgl2BitcastProof()
  })
  expect(r.fatal, `WebGL2 unavailable: ${r.fatal}`).toBeFalsy()
  expect(errors, `page errors:\n${errors.join('\n')}`).toEqual([])
  expect(r.glError).toBe(r.glNoError)
  // R = normal-bits lane low byte (52); G = DENORMAL lane low byte (200). G==200 proves
  // R32F texelFetch preserves denormal bits → bitcast-u32 of small-int feat_data lanes works.
  const eq = (got: number, want: number) => Math.abs(got - want) <= 2
  expect(eq(r.px[0], 52), `bitcast normal-bits lane: ${r.px} exp ${r.expected}`).toBe(true)
  expect(
    eq(r.px[1], 200),
    `bitcast DENORMAL lane (R32F flush risk): ${r.px} exp ${r.expected}`,
  ).toBe(true)
})

test('WebGL2 RHI STORAGE 2D-tiled: >maxTextureSize array wraps across rows', async ({ page }) => {
  test.setTimeout(30_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })
  const r = await page.evaluate(async () => {
    const mod = await import('/e2e/_webgl2-proof.ts')
    return mod.runWebgl2TiledStorageProof()
  })
  expect(r.fatal, `WebGL2 unavailable: ${r.fatal}`).toBeFalsy()
  expect(errors, `page errors:\n${errors.join('\n')}`).toEqual([])
  expect(r.glError).toBe(r.glNoError)
  // R = data[100] (row 0), G = data[2500] (row 1, col 452 at W=2048). Proves i→(i%W,i/W) tiling.
  expect(eqColor(r.px, r.expected, 3), `2D-tiled storage mismatch: ${r.px} exp ${r.expected}`).toBe(
    true,
  )
})

test('WebGL2 RHI STORAGE strided lane: feat_data[base*STRIDE+lane] computed index', async ({
  page,
}) => {
  test.setTimeout(30_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })
  const r = await page.evaluate(async () => {
    const mod = await import('/e2e/_webgl2-proof.ts')
    return mod.runWebgl2StridedProof()
  })
  expect(r.fatal, `WebGL2 unavailable: ${r.fatal}`).toBeFalsy()
  expect(errors, `page errors:\n${errors.join('\n')}`).toEqual([])
  expect(r.glError).toBe(r.glNoError)
  // left = data[0*4+2]=data[2]=0.4→102; right = data[1*4+2]=data[6]=0.7→179. Proves the
  // runtime base*STRIDE+lane computed index (the real feat_data access) lowers + reads right.
  const grey = (q: number[], v: number) =>
    Math.abs(q[0] - v) <= 3 && Math.abs(q[1] - v) <= 3 && Math.abs(q[2] - v) <= 3
  expect(grey(r.left, r.expected.left), `left = data[2] (0.4→102): ${r.left}`).toBe(true)
  expect(grey(r.right, r.expected.right), `right = data[6] (0.7→179): ${r.right}`).toBe(true)
})

test('WebGL2 RHI STORAGE array<Struct>: scalar-field lane read (shapes/segments path)', async ({
  page,
}) => {
  test.setTimeout(30_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })
  const r = await page.evaluate(async () => {
    const mod = await import('/e2e/_webgl2-proof.ts')
    return mod.runWebgl2StructStorageProof()
  })
  expect(r.fatal, `struct-storage emit/ctx: ${r.fatal}\n${r.fsGlsl}`).toBeFalsy()
  expect(errors, `page errors:\n${errors.join('\n')}`).toEqual([])
  expect(r.glError).toBe(r.glNoError)
  // left = items[0].val (lane 0*2+1=1)=0.4→102; right = items[1].val (lane 1*2+1=3)=0.7→179.
  const grey = (q: number[], v: number) =>
    Math.abs(q[0] - v) <= 3 && Math.abs(q[1] - v) <= 3 && Math.abs(q[2] - v) <= 3
  expect(grey(r.left, r.expected.left), `left items[0].val=0.4→102: ${r.left}`).toBe(true)
  expect(grey(r.right, r.expected.right), `right items[1].val=0.7→179: ${r.right}`).toBe(true)
})

test('WebGL2 RHI: the generic Material + executeItems render on WebGl2Device', async ({ page }) => {
  test.setTimeout(30_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })
  const r = await page.evaluate(async () =>
    (await import('/e2e/_webgl2-proof.ts')).runWebgl2MaterialProof(),
  )
  const ctx = `glError=${r.glError} BL=${r.bottomLeft} BR=${r.bottomRight} TL=${r.topLeft} TR=${r.topRight}`
  expect(r.fatal, `${r.fatal}`).toBeFalsy()
  expect(errors, `page errors:\n${errors.join('\n')}`).toEqual([])
  expect(r.glError, `gl error\n${ctx}`).toBe(r.glNoError)
  // the REAL Material + executeItems drew the checker through the descriptor path on WebGL2.
  expect(eqColor(r.bottomLeft, r.expected.bottomLeft), `BL\n${ctx}`).toBe(true)
  expect(eqColor(r.bottomRight, r.expected.bottomRight), `BR\n${ctx}`).toBe(true)
  expect(eqColor(r.topLeft, r.expected.topLeft), `TL\n${ctx}`).toBe(true)
  expect(eqColor(r.topRight, r.expected.topRight), `TR\n${ctx}`).toBe(true)
})
