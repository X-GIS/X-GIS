// ═══ executionModel confinement gate — the §5.3.3 promise, built (#1046 Inc-E2) ═══
//
// `RhiCaps.executionModel` is a DEVICE truth for engine upload/draw primitives
// (rhi.ts contract): map-layer passes and renderers must not fork on it — that
// would be backend identity wearing a capability's name. The Inc-E2 chain flip
// grants exactly five INTERIM exceptions — native-bodied sites that route the
// immediate arm to the *Rhi entries, decline, or steer a frame away from a
// native-bodied consumer; all dying at P6 with the native bodies themselves:
//
//   vector-tile-renderer.ts  ×1  VTR.render fork → renderImmediateArm
//   renderer.ts              ×2  renderToPass legacy-layer skip + graticule fork
//   frame-context.ts         ×1  ?debug=overdraw target routing (#1046 Inc-F2d)
//   opaque-pass.ts           ×1  the ?debug=checker arm (#1046 Inc-F2d)
//
// The last two were granted for reasons the gate should force into the open:
//
//   frame-context — the overdraw ACCUMULATOR routing, not the compose that
//     consumes it. The compose is raw WebGPU and threw every frame on an
//     immediate device until map.ts halted the loop; gating the compose alone
//     stops the crash but leaves the routing, so nothing writes the swapchain
//     and the frame goes blank. Gating the routing reproduces the twin, which
//     binds FBO 0 and never consults RenderTargets.
//   opaque-pass — `renderRhiChecker` bakes `RasterDraper(rhi,'rgba8unorm',1)`,
//     a pipeline shaped for the twin's single-sample screen pass. On WebGPU it
//     would bind into a bgra8unorm/MSAA-4 pass. debug-flags.ts already declares
//     sourceless WebGPU frames blank (#1041), so this keeps a contract rather
//     than adding a fork for convenience.
//
// This gate pins the consumer set EXACTLY: a new `.caps.executionModel` read
// anywhere in map/src — or a new one inside the allowlisted files — fails with
// the site named, and the bare-token sweep catches an aliasing evasion
// (`const { executionModel } = caps`). Applies the #996 lesson: matcher and
// walk are proven non-vacuous below, and every allowlist entry expects a
// NON-ZERO count, so a moved or renamed file cannot green silently.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAP_SRC = join(dirname(fileURLToPath(import.meta.url)), '..')

// A real capability READ — property access through `.caps`.
const READ = () => /\.caps\.executionModel/g
// The bare token, comments included — the "concept appears at all" sweep.
const TOKEN = () => /\bexecutionModel\b/g

/** Per-file `.caps.executionModel` read counts (path relative to map/src). */
const READ_ALLOWLIST: Record<string, number> = {
  'render/vector-tile-renderer.ts': 1,
  'render/renderer.ts': 2,
  'render/frame-context.ts': 1,
  'render/passes/opaque-pass.ts': 1,
}

/** Files allowed to MENTION the token at all (reads + docs). */
const TOKEN_ALLOWLIST = new Set([
  ...Object.keys(READ_ALLOWLIST),
  // Doc comments only — its code takes the pre-gated call (reads pinned 0 above).
  'render/vtr-immediate-arm.ts',
])

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

describe('executionModel confinement: map/src consumer set is EXACTLY the interim allowlist (#1046 Inc-E2)', () => {
  const files = walkSrcTs(MAP_SRC)
  const rel = (abs: string): string => abs.slice(MAP_SRC.length + 1).replaceAll('\\', '/')

  it('the matchers still match (not vacuous — #996)', () => {
    expect("if (this.ctx.rhi.caps.executionModel === 'immediate')".match(READ())).toHaveLength(1)
    expect('const { executionModel } = rhi.caps'.match(TOKEN())).toHaveLength(1)
    // must NOT match a different cap, or a backticked doc mention as a READ
    expect("caps.compute === 'native'".match(READ())).toBeNull()
    expect('`caps.executionModel === '.match(READ())).toBeNull()
  })

  it('the walk reaches the real map/src tree (not vacuous — #996)', () => {
    expect(files.length).toBeGreaterThan(100)
    expect(files.some((f) => f.endsWith(join('map', 'src', 'render-loop.ts')))).toBe(true)
  })

  it('`.caps.executionModel` reads: per-file counts equal the allowlist exactly', () => {
    const observed: Record<string, number> = {}
    for (const f of files) {
      const n = (readFileSync(f, 'utf8').match(READ()) ?? []).length
      if (n > 0) observed[rel(f)] = n
    }
    expect(
      observed,
      'executionModel is an engine-primitive capability (rhi.ts contract); map-layer ' +
        'consumers are interim P6-scoped exceptions. Port the new read behind the ' +
        'existing forks or take it to the engine seam — do not widen this allowlist ' +
        'without the #1046 review trail.',
    ).toEqual(READ_ALLOWLIST)
  })

  it('the bare token appears only in the allowlisted files (alias evasion sweep)', () => {
    const observed = files.filter((f) => TOKEN().test(readFileSync(f, 'utf8'))).map(rel)
    expect(new Set(observed)).toEqual(TOKEN_ALLOWLIST)
  })
})
