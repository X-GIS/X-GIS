// hunt 2026-09-02: #2298 — `_spriteAtlasViewPushed` must re-arm on a scene re-run.
//
// `_teardownForReinit()` (and the device-loss recovery path) destroys iconStage and
// run() #2 rebuilds the MapRenderer + every VTR, so the NEW renderer starts on the
// engine's 1×1 white stub view. The push in `RenderLoop._resolveFillPatterns` is
// one-shot and latch-gated, so a latch left `true` from run #1 means the re-loaded
// atlas is never pushed and every fill/line/background-pattern layer samples the stub.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { XGISMap } from '@xgis/map'
import {
  installWebGPUStub,
  type StubInstallation,
} from '../../rhi-webgpu/src/__test-support__/webgpu-stub'

// Node ships no HTMLCanvasElement; define a minimal one so the stub can patch
// getContext('webgpu') on its prototype (map-run-epoch-lifecycle.test.ts idiom).
function ensureCanvasCtor(): void {
  if (typeof HTMLCanvasElement === 'undefined') {
    ;(globalThis as { HTMLCanvasElement?: unknown }).HTMLCanvasElement = class {
      width = 256
      height = 256
      getContext(_t: string): unknown {
        return null
      }
    } as never
  }
}

function stubCanvas(): HTMLCanvasElement {
  const c = {
    width: 256,
    height: 256,
    clientWidth: 256,
    clientHeight: 256,
    style: {} as CSSStyleDeclaration,
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 256, bottom: 256, width: 256, height: 256 }
    },
    setPointerCapture() {},
    releasePointerCapture() {},
  } as unknown as HTMLCanvasElement
  Object.setPrototypeOf(c, HTMLCanvasElement.prototype)
  return c
}

class StubWorker {
  addEventListener(): void {}
  removeEventListener(): void {}
  postMessage(): void {}
  terminate(): void {}
}

let active: StubInstallation | null = null
function install(): StubInstallation {
  ensureCanvasCtor()
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
  vi.stubGlobal('Worker', StubWorker)
  active = installWebGPUStub({ freshDevices: true })
  return active
}

afterEach(() => {
  active?.uninstall()
  active = null
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

interface Seam {
  renderFrame: () => void
  renderer: { spriteAtlasView: unknown }
  iconStage: unknown
  renderLoopInstance: { _resolveFillPatterns(): void }
  _spriteAtlasViewPushed: boolean
}
const seam = (map: XGISMap) => map as unknown as Seam

function makeMap(): XGISMap {
  const map = new XGISMap(stubCanvas())
  seam(map).renderFrame = () => undefined
  return map
}

/** The IconStage surface `_resolveFillPatterns` + teardown read: atlas already
 *  LOADED (host state) and its WebGPU view (gpu.getView). Mirrors a real
 *  IconStage after its sprite fetch landed, minus the network. */
function loadedIconStage(view: unknown) {
  return {
    host: {
      getState: () => ({ status: 'loaded' }),
      get: () => undefined,
      getSpriteCenterColor: () => undefined,
    },
    gpu: {
      getView: () => view,
      size: () => ({ width: 64, height: 64 }),
      rhiView: () => undefined,
      rhiSampler: () => undefined,
    },
    destroy() {},
    setDpr() {},
    hasPendingAtlasLoad: () => false,
  }
}

describe('sprite-atlas push latch across a scene re-run (#2298)', () => {
  it('run() #2 rebuilds MapRenderer, so the re-loaded atlas view must be pushed into it again', async () => {
    install()
    const map = makeMap()
    const s = seam(map)

    // run #1 — atlas lands, _resolveFillPatterns pushes it (control arm).
    await map.run('xgis 1')
    const renderer1 = s.renderer
    const view1 = { atlas: 1 }
    s.iconStage = loadedIconStage(view1)
    s.renderLoopInstance._resolveFillPatterns()
    expect(renderer1.spriteAtlasView, 'run #1 control: atlas pushed').toBe(view1)
    expect(s._spriteAtlasViewPushed).toBe(true)

    // run #2 — _teardownForReinit nulls iconStage + rebuilds the renderer.
    await map.run('xgis 1')
    const renderer2 = s.renderer
    expect(renderer2, 'a re-run rebuilds MapRenderer').not.toBe(renderer1)
    expect(s.iconStage, 'a re-run destroys + nulls iconStage').toBeNull()
    expect(renderer2.spriteAtlasView, 'renderer #2 starts on the stub').not.toBe(view1)

    // IconStage #2 lazily rebuilt by the label pass; its atlas re-loads on ctx #2.
    const view2 = { atlas: 2 }
    s.iconStage = loadedIconStage(view2)
    s.renderLoopInstance._resolveFillPatterns()
    expect(
      renderer2.spriteAtlasView,
      'after a re-run the NEW renderer must receive the re-loaded sprite atlas view (not stay on the 1x1 stub)',
    ).toBe(view2)

    map.destroy()
  })
})
