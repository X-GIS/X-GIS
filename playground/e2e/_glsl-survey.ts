// Survey (browser side): which REAL DSL render-shader ModuleDecls emit valid GLSL ES
// 3.00. Vite resolves @xgis/shader-dsl + the runtime shader graph; a bare bun run
// can't (no workspace symlink), so the survey runs through the same vite-served
// dynamic-import path the WebGL2 gate uses.

import { emitGlslModule } from '../../shader-dsl/src/index'
import { buildRasterModule } from '@xgis/map'
import { overdrawComposeModule } from '../../engine/src/shaders/dsl/overdraw-compose'

export interface SurveyRow { name: string; vertex: string; fragment: string; link: string }

export function surveyGlslEmit(): SurveyRow[] {
  const cases: { name: string; build: () => unknown }[] = [
    { name: 'raster(pick=false)', build: () => buildRasterModule(false) },
    { name: 'overdraw-compose', build: () => overdrawComposeModule },
  ]
  const gl = document.createElement('canvas').getContext('webgl2')
  const rows: SurveyRow[] = []
  for (const c of cases) {
    let m: Parameters<typeof emitGlslModule>[0]
    try { m = c.build() as Parameters<typeof emitGlslModule>[0] }
    catch (e) { rows.push({ name: c.name, vertex: 'BUILD THROW: ' + (e as Error).message, fragment: '', link: '-' }); continue }
    let vsSrc = '', fsSrc = ''
    const emit = (stage: 'vertex' | 'fragment') => {
      try { const s = emitGlslModule(m, stage); if (stage === 'vertex') vsSrc = s; else fsSrc = s; return `OK (${s.length} chars)` }
      catch (e) { return 'THROW: ' + (e as Error).message }
    }
    const vertex = emit('vertex'), fragment = emit('fragment')
    // compile + link on real WebGL2.
    let link = 'skipped (emit threw)'
    if (gl && vsSrc && fsSrc) {
      const compile = (type: number, src: string) => {
        const sh = gl.createShader(type)!; gl.shaderSource(sh, src); gl.compileShader(sh)
        return { ok: gl.getShaderParameter(sh, gl.COMPILE_STATUS) as boolean, log: gl.getShaderInfoLog(sh) ?? '', sh }
      }
      const vs = compile(gl.VERTEX_SHADER, vsSrc), fs = compile(gl.FRAGMENT_SHADER, fsSrc)
      if (!vs.ok) link = 'VS COMPILE FAIL: ' + vs.log.slice(0, 300)
      else if (!fs.ok) link = 'FS COMPILE FAIL: ' + fs.log.slice(0, 300)
      else {
        const prog = gl.createProgram()!; gl.attachShader(prog, vs.sh); gl.attachShader(prog, fs.sh); gl.linkProgram(prog)
        link = gl.getProgramParameter(prog, gl.LINK_STATUS) ? 'LINK OK' : 'LINK FAIL: ' + (gl.getProgramInfoLog(prog) ?? '').slice(0, 300)
      }
    }
    rows.push({ name: c.name, vertex, fragment, link })
  }
  return rows
}
