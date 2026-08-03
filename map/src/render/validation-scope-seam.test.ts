// ═══ Validation scopes reach the GPU through the RHI (#1046 F4 — Inc-A) ═══
//
// The chain's loop TAIL held four native `device.pushErrorScope`/`popErrorScope`
// sites (the frame-level scope + the per-pass `passScope` pair) — the first of
// the native residues that keep `chainFrame` false on WebGl2Device. The seam:
// `RhiDevice.pushValidationScope()`/`popValidationScope()` — WebGPU maps to the
// native scope stack (rejection passes through so the Audit-⑧-B2 rejected-pop
// arm keeps firing); WebGL2 no-ops, because an immediate-mode context surfaces
// errors through the frame encoder's `finish()` drain instead.
//
// This file pins the LOOP side: the render loop must speak only the RHI form.
// The adapter mappings are pinned in rhi-webgpu/src/validation-scope.test.ts.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const loopSrc = (): string =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'render-loop.ts'), 'utf8')

describe('validation-scope seam (#1046 F4 Inc-A)', () => {
  it('render-loop holds ZERO native errorScope calls', () => {
    const src = loopSrc()
    // The native spellings must be gone — a survivor is a loop-tail native the
    // WebGL2 chain frame would crash on (undefined device method) or bypass.
    expect(src.match(/\.pushErrorScope\(/g) ?? []).toHaveLength(0)
    expect(src.match(/\.popErrorScope\(/g) ?? []).toHaveLength(0)
  })

  it('render-loop speaks the RHI form at the frame + pass scopes', () => {
    const src = loopSrc()
    // RECEIVER-pinned (review MINOR-1): the scopes must ride the FRAME device —
    // a pair moved to a different RhiDevice would unbalance the native stack
    // while a receiver-blind count stayed green.
    // Two pushes (frame-level + the passScope helper) and two pops (the
    // passScope finally + the frame-level report) — the same four sites,
    // RHI-spelled. Counted exactly so a half-converted loop goes red.
    expect(src.match(/rhiFrame\.pushValidationScope\(\)/g) ?? []).toHaveLength(2)
    expect(src.match(/rhiFrame\.popValidationScope\(\)/g) ?? []).toHaveLength(2)
  })
})
