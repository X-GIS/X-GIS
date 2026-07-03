import { test, expect } from '@playwright/test'

// Real-DSL-shader GLSL gate: the ACTUAL render-shader ModuleDecls (raster + the
// overdraw-compose pass) must emit GLSL ES 3.00 that COMPILES + LINKS on real WebGL2.
// Guards the GLSL backend's reserved-word identifier sanitisation (an entry param
// named `input`/`in` is GLSL-reserved) + the texelFetch/textureSize lod spelling —
// both required for these real shaders and easy to regress. Runs the emit+link in the
// browser (vite resolves the runtime shader graph; a bare bun run cannot).
test('real DSL render shaders emit linkable GLSL on WebGL2 (raster + overdraw-compose)', async ({
  page,
}) => {
  await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })
  const rows = await page.evaluate(async () => {
    const mod = await import('/e2e/_glsl-survey.ts')
    return mod.surveyGlslEmit()
  })
  for (const r of rows) {
    expect(r.vertex, `${r.name} vertex emit:\n${r.vertex}`).toContain('OK')
    expect(r.fragment, `${r.name} fragment emit:\n${r.fragment}`).toContain('OK')
    expect(r.link, `${r.name} compile/link:\n${r.link}`).toBe('LINK OK')
  }
})
