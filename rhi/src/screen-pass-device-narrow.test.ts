// ═══ Screen-pass capability narrow (#783) ═══
//
// `beginScreenPass`/`endScreenPass`/`beginOffscreenPass` are `?`-optional on
// RhiDevice because only the WebGl2Device slice implements them today (the WebGPU
// path keeps its raw render-loop lifecycle — Story-7 convergence). The footgun:
// `device.beginScreenPass!(...)` compiles green and throws at runtime on a device
// that omits it. `asScreenPassDevice` closes it — it narrows to the capability by
// the POSITIVE `backend` marker + full method presence, or returns null, so a
// consumer proves presence by the type instead of asserting it with `!`.
//
// Two halves are pinned here: the runtime narrow LOGIC (all-or-nothing, backend-
// gated) and the compile-time CONTRACT (the `@ts-expect-error` line fails
// `tsc --build @xgis/rhi` if the optional call ever type-checks without narrowing).

import { describe, it, expect } from 'vitest'
import { asScreenPassDevice, type RhiDevice, type RhiScreenPassDesc } from './rhi'

// asScreenPassDevice reads only `.backend` + the screen-pass method slots; a bare
// partial cast to RhiDevice exercises the narrow with no real backend.
function fake(partial: Record<string, unknown>): RhiDevice {
  return partial as unknown as RhiDevice
}
const screenPassMethods = {
  beginScreenPass: () => ({}),
  endScreenPass: () => {},
  beginOffscreenPass: () => ({}),
}

describe('asScreenPassDevice narrow logic (#783)', () => {
  it('rejects an undefined device', () => {
    expect(asScreenPassDevice(undefined)).toBeNull()
  })

  it('rejects a WebGPU device — backend is the authority even if the methods are present', () => {
    // A `beginScreenPass!` on a WebGPU device compiles green and throws; the narrow
    // returns null so there is nothing to `!`. Backend-gated: methods present but
    // backend 'webgpu' → still rejected.
    expect(asScreenPassDevice(fake({ backend: 'webgpu', ...screenPassMethods }))).toBeNull()
  })

  it('rejects a WebGL2 device missing part of the capability (all-or-nothing)', () => {
    expect(
      asScreenPassDevice(
        fake({ backend: 'webgl2', beginScreenPass: () => ({}), endScreenPass: () => {} }),
      ),
    ).toBeNull()
  })

  it('narrows a WebGL2 device that implements the full lifecycle to the same object', () => {
    const dev = fake({ backend: 'webgl2', ...screenPassMethods })
    expect(asScreenPassDevice(dev)).toBe(dev)
  })
})

describe('asScreenPassDevice type contract (#783)', () => {
  it('forbids the optional call on a bare RhiDevice; allows it after narrowing (no `!`)', () => {
    const desc: RhiScreenPassDesc = { width: 1, height: 1 }
    const dev = fake({ backend: 'webgl2', ...screenPassMethods })
    // @ts-expect-error beginScreenPass is optional on RhiDevice — possibly undefined.
    dev.beginScreenPass(desc)
    const narrowed = asScreenPassDevice(dev)
    // After the null-check the method is present WITHOUT a `!` assertion. If the
    // narrowed type ever regressed to optional, this line would fail the build.
    if (narrowed) narrowed.beginScreenPass(desc)
    expect(narrowed).toBe(dev)
  })
})
