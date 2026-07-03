import { describe, it, expect } from 'vitest'
import { resolveBackend, initGPU, FORCE_GL2 } from './gpu'

// #795 — `resolveBackend` is the SINGLE backend-precedence authority: an
// explicit `'webgpu'`/`'webgl2'` wins over the `?forcegl2=1` dev override;
// `'auto'` honours the flag, then defaults to WebGPU. In the vitest env there
// is no window/URL, so `FORCE_GL2` is false — the logic tests pin the
// explicit-wins contract (independent of the flag) and the auto→WebGPU default
// (byte-identical to today's no-flag boot). The integration test proves the
// CONSTRUCTION option (not the URL) routes to WebGL2.

function fakeCanvas(gl: unknown): HTMLCanvasElement {
  return {
    width: 8, height: 8, clientWidth: 8, clientHeight: 8,
    getContext(type: string): unknown { return type === 'webgl2' ? gl : null },
  } as unknown as HTMLCanvasElement
}

describe('resolveBackend — backend precedence authority (#795)', () => {
  it('an explicit backend wins and is independent of the ?forcegl2 flag', () => {
    expect(resolveBackend('webgpu')).toBe('webgpu')
    expect(resolveBackend('webgl2')).toBe('webgl2')
  })

  it("'auto' defaults to WebGPU when the ?forcegl2 override is off (today's default boot)", () => {
    expect(FORCE_GL2).toBe(false) // vitest env: no window/URL flag
    expect(resolveBackend('auto')).toBe('webgpu')
  })

  it("'auto' tracks the FORCE_GL2 override (the ONLY consumer of the flag)", () => {
    // resolveBackend('auto') === (FORCE_GL2 ? 'webgl2' : 'webgpu'). Here FORCE_GL2
    // is false → WebGPU; the flag=true → 'webgl2' arm is covered by the
    // ?forcegl2=1 e2e parity gate.
    expect(resolveBackend('auto')).toBe(FORCE_GL2 ? 'webgl2' : 'webgpu')
  })
})

describe('initGPU — backend construction option (#795)', () => {
  it('boots the WebGL2 backend from the option alone, WITHOUT the ?forcegl2 URL flag', async () => {
    // The exact path XGISMap takes: options.backend → _backend → initGPU(canvas,
    // { backend }). resolveBackend('webgl2') → the WebGL2 early-return branch.
    const ctx = await initGPU(fakeCanvas({} as WebGL2RenderingContext), { backend: 'webgl2' })
    expect(ctx.rhi?.backend).toBe('webgl2')
    expect(ctx.sampleCount).toBe(1) // slice-1 isolated single-sample topology
  })
})
