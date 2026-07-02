// ═══ Shader DSL — thumbnail capture ═══
//
// Renders each renderable example to a still PNG poster for the /shader-dsl gallery cards
// (so the grid shows previews WITHOUT running 5 live WebGL2 canvases on load). Run:
//
//   npx tsx playground/capture-shader-thumbnails.mts
//
// Writes site/public/shader/<id>.jpg. Re-run after changing a shader. Renders a fixed
// frame (t = 3s) with each example's default slider values, packing the std140 UBO from
// reflect() — the same path the live page uses.
import { chromium } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
// Workspace imports (#763 A1 — was a ../ relative reach across packages).
import { examples } from '@xgis/shader-dsl/examples'
import { emitGlslModule, reflect } from '@xgis/shader-dsl'

const W = 640, H = 400, TIME = 3.0
const outDir = fileURLToPath(new URL('../site/public/shader/', import.meta.url))
mkdirSync(outDir, { recursive: true })

const payloads = examples.filter((e) => e.renderable).map((e) => ({
  id: e.id,
  vertex: emitGlslModule(e.module, 'vertex'),
  fragment: emitGlslModule(e.module, 'fragment'),
  reflection: reflect(e.module),
  controls: e.controls ?? {},
}))

const code = `(() => {
  const payloads = ${JSON.stringify(payloads)};
  const W = ${W}, H = ${H}, TIME = ${TIME};
  const out = [];
  for (const p of payloads) {
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: true });
    if (!gl) { out.push({ id: p.id, dataURL: null }); continue; }
    const mk = (t, s) => { const sh = gl.createShader(t); gl.shaderSource(sh, s); gl.compileShader(sh); return sh; };
    const prog = gl.createProgram();
    gl.attachShader(prog, mk(gl.VERTEX_SHADER, p.vertex));
    gl.attachShader(prog, mk(gl.FRAGMENT_SHADER, p.fragment));
    gl.linkProgram(prog); gl.useProgram(prog);
    const u = p.reflection.uniforms[0];
    if (u) {
      const buf = new ArrayBuffer(Math.ceil(u.size / 16) * 16);
      const f32 = new Float32Array(buf);
      for (const f of u.fields) {
        const c = p.controls[f.name];
        let v = [0];
        if (c && c.kind === 'time') v = [TIME];
        else if (c && c.kind === 'resolution') v = [W, H];
        else if (c && c.kind === 'slider') v = [c.value];
        else if (c && c.kind === 'const') v = c.value;
        for (let i = 0; i < v.length; i++) f32[f.offset / 4 + i] = v[i];
      }
      const ubo = gl.createBuffer();
      gl.bindBuffer(gl.UNIFORM_BUFFER, ubo);
      gl.bufferData(gl.UNIFORM_BUFFER, buf, gl.STATIC_DRAW);
      const idx = gl.getUniformBlockIndex(prog, u.name);
      if (idx !== 0xFFFFFFFF) { gl.uniformBlockBinding(prog, idx, 0); gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, ubo); }
    }
    gl.bindVertexArray(gl.createVertexArray());
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    out.push({ id: p.id, dataURL: canvas.toDataURL('image/jpeg', 0.82) });
  }
  return out;
})()`

const browser = await chromium.launch()
const page = await browser.newPage()
await page.goto('about:blank')
const results = await page.evaluate(code) as { id: string; dataURL: string | null }[]
await browser.close()

for (const r of results) {
  if (!r.dataURL) { console.log('XX', r.id, '(no render)'); continue }
  const b64 = r.dataURL.split(',')[1]
  writeFileSync(`${outDir}${r.id}.jpg`, Buffer.from(b64, 'base64'))
  console.log('OK', `${r.id}.jpg`)
}
