// ═══ Backend chain on a CLAIMED canvas — the blank-map fallback gate ═══
//
// Reported symptom: on machines that cannot use WebGPU the auto chain "triggers
// the fallback but backend selection fails" and the map never appears.
//
// Root cause: a canvas's context type is STICKY and IRREVERSIBLE. Verified in
// Chromium 1194 — after `getContext('webgpu')` hands out a context, the SAME
// element's `getContext('webgl2')` returns null forever, while a virgin canvas
// returns a context. So `[webgpu, webgl2]` cannot walk from one backend to the
// other on one element: the fallback's create() dies on a null context and the
// chain exhausts. Two production paths reach a claimed canvas — a WebGPU create()
// that fails after claiming, and a re-boot (device-lost recovery / host remount)
// on a canvas an earlier SUCCESSFUL WebGPU boot claimed, once WebGPU is gone.
//
// The fixture below reproduces exactly that stickiness, so the gate fails for the
// same reason the browser does rather than for a mock's convenience.

import { describe, it, expect } from 'vitest'
import {
  selectBackend,
  markSurfaceClaimed,
  surfaceClaimedBy,
  BackendUnavailableError,
  SurfaceUnusableError,
  type RhiBackendProvider,
} from './rhi-provider'

/** A canvas with the browser's real one-context-type-forever rule: the first
 *  successful getContext wins, every other type returns null from then on. */
function stickyCanvas(): HTMLCanvasElement {
  let claimed: string | null = null
  return {
    width: 8,
    height: 8,
    clientWidth: 8,
    clientHeight: 8,
    getContext(type: string): unknown {
      if (claimed !== null && claimed !== type) return null
      claimed = type
      return { type }
    },
  } as unknown as HTMLCanvasElement
}

type Ctx = { backend: string; canvas: HTMLCanvasElement }

/** A provider whose create() boots only on a canvas that yields ITS context type
 *  — i.e. it fails on a claimed element exactly as the real backends do. */
function provider(id: 'webgpu' | 'webgl2'): RhiBackendProvider<Ctx> {
  const type = id === 'webgpu' ? 'webgpu' : 'webgl2'
  return {
    id,
    probe: async () => true,
    create: async (canvas) => {
      if (!canvas.getContext(type)) throw new Error(`${id}: getContext("${type}") returned null`)
      markSurfaceClaimed(canvas, id)
      return { backend: id, canvas }
    },
  }
}

describe('selectBackend on a canvas another backend already claimed (#1341)', () => {
  it('a WebGPU-claimed canvas leaves the WebGL2 fallback UNBOOTABLE without a fresh surface', async () => {
    const canvas = stickyCanvas()
    // A previous successful WebGPU boot (or a create() that failed after claiming).
    canvas.getContext('webgpu')
    markSurfaceClaimed(canvas, 'webgpu')

    // WebGPU is gone now (adapter blocklisted after a GPU crash), so only the
    // WebGL2 provider is left — and it cannot have this element.
    await expect(selectBackend(canvas, [provider('webgl2')])).rejects.toThrow(
      BackendUnavailableError,
    )
  })

  it('names the CLAIM as the cause — not a flag the host never set', async () => {
    const canvas = stickyCanvas()
    canvas.getContext('webgpu')
    markSurfaceClaimed(canvas, 'webgpu')

    let err: BackendUnavailableError | null = null
    try {
      await selectBackend(canvas, [provider('webgl2')])
    } catch (e) {
      err = e as BackendUnavailableError
    }
    const causes = (err?.causes ?? [])
      .map((c: unknown) => (c instanceof Error ? c.message : String(c)))
      .join('; ')
    expect(causes).toContain('already claimed by "webgpu"')
    expect(causes).not.toContain('forcegl2')
  })

  it('renewSurface hands the fallback a virgin canvas and the chain BOOTS', async () => {
    const claimedCanvas = stickyCanvas()
    claimedCanvas.getContext('webgpu')
    markSurfaceClaimed(claimedCanvas, 'webgpu')

    const replacement = stickyCanvas()
    const asked: string[] = []
    const ctx = await selectBackend(claimedCanvas, [provider('webgl2')], {
      renewSurface: (prev, backend) => {
        expect(prev).toBe(claimedCanvas)
        asked.push(backend)
        return replacement
      },
    })

    expect(asked).toEqual(['webgl2'])
    expect(ctx.backend).toBe('webgl2')
    // The booted context carries the REPLACEMENT — the host must render into it.
    expect(ctx.canvas).toBe(replacement)
    expect(surfaceClaimedBy(replacement)).toBe('webgl2')
  })

  it('the real auto chain recovers: WebGPU claims, then fails, then WebGL2 boots fresh', async () => {
    const canvas = stickyCanvas()
    const replacement = stickyCanvas()
    // A WebGPU provider that claims the canvas and THEN fails (configure throw /
    // device ctor throw) — the window that strands the element in production.
    const webgpuClaimsThenFails: RhiBackendProvider<Ctx> = {
      id: 'webgpu',
      probe: async () => true,
      create: async (c) => {
        c.getContext('webgpu')
        markSurfaceClaimed(c, 'webgpu')
        throw new Error('context.configure failed')
      },
    }

    const ctx = await selectBackend(canvas, [webgpuClaimsThenFails, provider('webgl2')], {
      renewSurface: () => replacement,
    })
    expect(ctx.backend).toBe('webgl2')
    expect(ctx.canvas).toBe(replacement)
  })

  it('recovers from a claim the registry never saw (the HOST took a context first)', async () => {
    // The blank-map repro: something outside our backends claimed the element, so
    // surfaceClaimedBy() is blind and only the null getContext reveals it.
    const canvas = stickyCanvas()
    canvas.getContext('webgpu') // host-side claim — deliberately NOT marked
    const replacement = stickyCanvas()
    const surfaceAware: RhiBackendProvider<Ctx> = {
      id: 'webgl2',
      probe: async () => true,
      create: async (c) => {
        if (!c.getContext('webgl2')) throw new SurfaceUnusableError('getContext("webgl2") is null')
        markSurfaceClaimed(c, 'webgl2')
        return { backend: 'webgl2', canvas: c }
      },
    }

    expect(surfaceClaimedBy(canvas)).toBeUndefined()
    const ctx = await selectBackend(canvas, [surfaceAware], { renewSurface: () => replacement })
    expect(ctx.backend).toBe('webgl2')
    expect(ctx.canvas).toBe(replacement)
  })

  it('a non-surface boot fault does NOT churn the canvas — it just falls through', async () => {
    const canvas = stickyCanvas()
    let renewed = 0
    const adapterNull: RhiBackendProvider<Ctx> = {
      id: 'webgpu',
      probe: async () => true,
      create: async () => {
        throw new Error('Failed to get GPU adapter')
      },
    }
    const ctx = await selectBackend(canvas, [adapterNull, provider('webgl2')], {
      renewSurface: () => {
        renewed++
        return stickyCanvas()
      },
    })
    expect(renewed).toBe(0)
    expect(ctx.canvas).toBe(canvas)
  })

  it('an UNCLAIMED canvas is never renewed — the working path is untouched', async () => {
    const canvas = stickyCanvas()
    let renewed = 0
    const ctx = await selectBackend(canvas, [provider('webgpu')], {
      renewSurface: () => {
        renewed++
        return stickyCanvas()
      },
    })
    expect(renewed).toBe(0)
    expect(ctx.canvas).toBe(canvas)
  })

  it('a canvas claimed by the SAME backend is re-used, not renewed (re-boot path)', async () => {
    const canvas = stickyCanvas()
    canvas.getContext('webgl2')
    markSurfaceClaimed(canvas, 'webgl2')
    let renewed = 0
    const ctx = await selectBackend(canvas, [provider('webgl2')], {
      renewSurface: () => {
        renewed++
        return stickyCanvas()
      },
    })
    expect(renewed).toBe(0)
    expect(ctx.canvas).toBe(canvas)
  })
})
