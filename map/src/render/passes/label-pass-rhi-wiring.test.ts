// ═══ Label pass → RHI seam wiring (#1046 F3b — the LAST chain pass) ═══
//
// The text-overlay sub-pass originates through the RHI frame shell:
// requireRhiFrame hands the pass the frame's RHI encoder + view bridges BY
// IDENTITY (a re-wrap or re-derive is the 34d4695 double-wrap class), the
// descriptor topology the native block declared survives byte-for-byte
// (colour bridge, loadOp 'load', conditional resolveTarget — the label pass
// is the frame's LAST colour writer), and both stages receive the RHI
// sub-pass handle directly, icons before text. The twin arm (ctx.rhiPass —
// the forced-WebGL2 live screen pass) is pinned unchanged: it draws onto
// the live pass and originates nothing. Raw-shell escape (null bridges)
// fails loud naming the pass.
//
// The viewport handed to both stages is the SCREEN geometry (decoy scene
// 800×600 must not appear) — labels are a screen-space overlay (#1429
// role partition), the opposite pin of the translucent scene-size source.
//
// GPU-free: stub FrameContext + host (stage/iStage stubs absorb the
// dispatch machinery; one overlay opens the labels-active gate with zero
// shows, so the ~1200-line show loop never runs). Fail-before: on the
// native body every case below except the twin pin is RED — the overlay
// pass begins on the DECOY native ctx.encoder, no RHI descriptor is
// captured, and the raw-shell case encodes instead of throwing.

import { describe, it, expect, vi } from 'vitest'
import { labelPass } from './label-pass'
import { makeProjectionToken } from '../projection-token'
import type { FrameContext } from '../frame-context'
import type { SceneView } from '../scene-view'

interface CapturedPass {
  desc: Record<string, unknown>
  ended: boolean
}

function harness(opts: { useResolve?: boolean; twin?: boolean; rawShell?: boolean } = {}) {
  const captured: CapturedPass[] = []
  const beginRenderPass = vi.fn((desc: Record<string, unknown>) => {
    const p = {
      desc,
      ended: false,
      end() {
        p.ended = true
      },
    }
    captured.push(p as unknown as CapturedPass)
    return p
  })
  const enc = { beginRenderPass, __rhiEncoder: true }
  // Decoy NATIVE encoder — the pre-port body encoded the text-overlay pass
  // here; after the port nothing may touch it on any arm.
  const nativeBegin = vi.fn(() => ({ end: () => undefined }))
  const twinPass = { __twinLivePass: true }
  const ctx = {
    rhiEncoder: opts.rawShell ? null : enc,
    rhiScreenView: { __rhiScreenView: true },
    rhiColorView: { __rhiColorView: true },
    rhiStencilView: { __rhiStencilView: true },
    rhiPass: opts.twin ? twinPass : undefined,
    encoder: { beginRenderPass: nativeBegin },
    colorView: { __nativeColorView: true },
    screenView: { __nativeScreenView: true },
    useResolve: opts.useResolve ?? true,
    passScope: (_label: string, fn: () => void) => fn(),
    projection: makeProjectionToken(0, 0, 0),
    scene: { w: 800, h: 600, dpr: 1 },
    screen: { w: 999, h: 998, dpr: 1 },
    sampleCount: 4,
    _elapsedMs: 0,
  } as unknown as FrameContext
  // Draw-call log: pass identity + viewport, icons-before-text ordering.
  const order: { kind: string; pass: unknown; viewport: unknown }[] = []
  const fadeLedger = {
    advance: () => ({ anyFadeOutCompleted: false }),
    enabled: false,
  }
  const stage = {
    setDpr: () => undefined,
    setCameraZoom: () => undefined,
    setBearing: () => undefined,
    addLabel: () => undefined,
    getFadeLedger: () => fadeLedger,
    getActiveTextPairKeys: () => new Set<string>(),
    setPairIconHalfExtents: () => undefined,
    setSpriteMetadata: () => undefined,
    prepare: () => undefined,
    getDroppedPairKeys: () => new Set<string>(),
    getPairFitBoxes: () => new Map(),
    getInlineImagePlacements: () => [],
    wasLastPrepareFullyResolved: () => true,
    render: (pass: unknown, viewport: unknown) => order.push({ kind: 'text', pass, viewport }),
    reset: () => undefined,
  }
  const iStage = {
    host: {},
    setDpr: () => undefined,
    computeObstacles: () => [],
    pairedIconHalfExtents: () => new Map(),
    isAtlasTerminal: () => true,
    setDroppedPairKeys: () => undefined,
    setPairFitBoxes: () => undefined,
    setInlineImagePlacements: () => undefined,
    setFadeLedger: () => undefined,
    prepare: () => undefined,
    getSprite: () => undefined,
    render: (pass: unknown, viewport: unknown) => order.push({ kind: 'icon', pass, viewport }),
    reset: () => undefined,
  }
  const host = {
    textStage: stage,
    iconStage: iStage,
    // One overlay opens the labels-active gate; zero shows keeps the whole
    // per-feature dispatch loop out of the harness.
    overlays: [{ lon: 0, lat: 0, text: 'seam' }],
    showCommands: [],
    vtSources: new Map(),
    camera: {
      zoom: 3,
      bearing: 0,
      pitch: 0,
      centerX: 0,
      centerY: 0,
      centerLatDeg: 0,
      globeMode: false,
      effectiveMpp: () => 1,
      getVisibleWorldCopies: () => [0],
      getViewForProjection: () => ({ matrix: new Float32Array(16) }),
    },
    ctx: { canvas: { width: 999, height: 998 } },
    _elapsedMs: 0,
    _labelsHaveTimeAnimation: false,
    _labelDispatchHits: 0,
    _labelDispatchMisses: 0,
    consumeLabelDirty: () => false,
    markLabelDirty: () => undefined,
    projectionName: 'mercator',
    spriteUrl: null,
    _backgroundPattern: null,
  }
  const scene = {} as unknown as SceneView
  return { ctx, host, scene, captured, order, beginRenderPass, nativeBegin, twinPass }
}

describe('label pass — RHI seam wiring (#1046 F3b, the last chain pass)', () => {
  it('originates the text-overlay pass on the frame RHI encoder with the bridge views by IDENTITY', () => {
    const h = harness()
    labelPass.execute(h.ctx, h.scene, h.host as never)
    // The decoy native encoder is dead — the pass came from the RHI shell.
    expect(h.nativeBegin).not.toHaveBeenCalled()
    expect(h.beginRenderPass).toHaveBeenCalledTimes(1)
    const desc = h.captured[0].desc
    const colors = desc.colorAttachments as {
      view: unknown
      resolveTarget?: unknown
      loadOp: string
      storeOp: string
    }[]
    expect(colors).toHaveLength(1)
    expect(colors[0].view).toBe((h.ctx as { rhiColorView: unknown }).rhiColorView)
    // Last colour writer of the frame: it claims the MSAA resolve.
    expect(colors[0].resolveTarget).toBe((h.ctx as { rhiScreenView: unknown }).rhiScreenView)
    expect(colors[0].loadOp).toBe('load')
    expect(colors[0].storeOp).toBe('store')
    // Overlay content only — no depth/stencil attachment.
    expect(desc.depthStencilAttachment).toBeUndefined()
    expect(h.captured[0].ended).toBe(true)
    // Both stages received THE RHI sub-pass by identity, icons before text,
    // at SCREEN geometry (decoy scene 800×600 must not appear).
    expect(h.order.map((o) => o.kind)).toEqual(['icon', 'text'])
    for (const o of h.order) {
      expect(o.pass).toBe(h.captured[0])
      expect(o.viewport).toEqual({ width: 999, height: 998 })
    }
  })

  it('useResolve=false ⇒ the overlay pass claims no resolveTarget', () => {
    const h = harness({ useResolve: false })
    labelPass.execute(h.ctx, h.scene, h.host as never)
    expect(h.beginRenderPass).toHaveBeenCalledTimes(1)
    const colors = h.captured[0].desc.colorAttachments as { resolveTarget?: unknown }[]
    expect(colors[0].resolveTarget).toBeUndefined()
  })

  it('twin arm (ctx.rhiPass) draws onto the live pass by identity and originates NOTHING', () => {
    const h = harness({ twin: true })
    labelPass.execute(h.ctx, h.scene, h.host as never)
    expect(h.beginRenderPass).not.toHaveBeenCalled()
    expect(h.nativeBegin).not.toHaveBeenCalled()
    expect(h.order.map((o) => o.kind)).toEqual(['icon', 'text'])
    for (const o of h.order) {
      expect(o.pass).toBe(h.twinPass)
      expect(o.viewport).toEqual({ width: 999, height: 998 })
    }
  })

  it('raw-shell escape (null bridges, no twin pass) ⇒ throws naming the pass, encodes nothing', () => {
    const h = harness({ rawShell: true })
    expect(() => labelPass.execute(h.ctx, h.scene, h.host as never)).toThrow(/labels/)
    expect(h.nativeBegin).not.toHaveBeenCalled()
    expect(h.order).toHaveLength(0)
  })
})
