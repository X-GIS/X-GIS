// #2324: time-interpolated label shapes must resolve against the frame
// clock (host._elapsedMs), not performance.now() — otherwise a
// non-looping animation is already at its end value on frame 1, and a
// looping one runs at a boot-dependent phase offset from every other
// time-interpolated property.
import { describe, it, expect, vi, afterEach } from 'vitest'
import * as helpers from '../../render-loop-helpers'
import { labelPass } from './label-pass'
import { makeProjectionToken } from '../projection-token'
import type { FrameContext } from '../frame-context'
import type { SceneView } from '../scene-view'

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

function harness(elapsedMs: number) {
  const beginRenderPass = vi.fn(() => ({ end: () => undefined }))
  const ctx = {
    rhiEncoder: { beginRenderPass, __rhiEncoder: true },
    rhiScreenView: { __rhiScreenView: true },
    rhiColorView: { __rhiColorView: true },
    rhiStencilView: { __rhiStencilView: true },
    rhiSceneResolveView: { __rhiSceneResolveView: true },
    rhiColorViewScreen: { __rhiColorViewScreen: true },
    encoder: { beginRenderPass: vi.fn(() => ({ end: () => undefined })) },
    colorView: {},
    screenView: {},
    useResolve: true,
    passScope: (_label: string, fn: () => void) => fn(),
    projection: makeProjectionToken(0, 0, 0),
    scene: { w: 800, h: 600, dpr: 1 },
    screen: { w: 800, h: 600, dpr: 1 },
    sampleCount: 4,
    elapsedMs,
    _elapsedMs: elapsedMs,
  } as unknown as FrameContext
  const fadeLedger = { advance: () => ({ anyFadeOutCompleted: false }), enabled: false }
  const addLabel = vi.fn()
  const stage = {
    setDpr: () => undefined,
    setCameraZoom: () => undefined,
    setBearing: () => undefined,
    addLabel,
    getFadeLedger: () => fadeLedger,
    getActiveTextPairKeys: () => new Set<string>(),
    setPairIconHalfExtents: () => undefined,
    setSpriteMetadata: () => undefined,
    prepare: () => undefined,
    getDroppedPairKeys: () => new Set<string>(),
    getPairFitBoxes: () => new Map(),
    getInlineImagePlacements: () => [],
    wasLastPrepareFullyResolved: () => true,
    render: () => undefined,
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
    render: () => undefined,
    reset: () => undefined,
  }
  const label = {
    text: { kind: 'template', parts: [{ kind: 'literal', value: 'A' }] },
    size: 10,
    shapes: {
      textLayout: {
        size: {
          kind: 'time-interpolated',
          stops: [
            { timeMs: 0, value: 10 },
            { timeMs: 1000, value: 20 },
          ],
          loop: false,
          easing: 'linear',
          delayMs: 0,
        },
        font: null,
        fontWeight: null,
        fontStyle: null,
      },
      textPaint: { color: null, haloWidth: null, haloColor: null, haloBlur: null, opacity: null },
      icon: { iconSize: null, iconOpacity: null, iconColor: null },
    },
  }
  const host = {
    textStage: stage,
    iconStage: iStage,
    overlays: [],
    showCommands: [{ targetName: 'pts', visible: true, label, fill: '#ffffff' }],
    rawDatasets: new Map([
      [
        'pts',
        {
          features: [{ geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} }],
        },
      ],
    ]),
    vtSources: new Map(),
    graphics: { hasAnyImage: () => false, hostAtlas: () => null },
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
      getViewForProjection: () => ({ matrix: IDENTITY, eye: [0, 0, 0] }),
      getECEFCenter: () => [0, 0, 0],
    },
    ctx: { canvas: { width: 800, height: 600 } },
    _elapsedMs: elapsedMs,
    _labelsHaveTimeAnimation: true,
    _labelDispatchHits: 0,
    _labelDispatchMisses: 0,
    _labelDispatchLoopRuns: 0,
    _featureExprsCache: new WeakMap(),
    _scratchEmittedPointNames: new Map(),
    _scratchEmittedTextNames: new Map(),
    _scratchEmittedLineIconKeys: new Set(),
    consumeLabelDirty: () => false,
    markLabelDirty: () => undefined,
    projectionName: 'mercator',
    spriteUrl: null,
    _backgroundPattern: null,
  }
  return { ctx, host, scene: {} as unknown as SceneView, addLabel }
}

afterEach(() => vi.restoreAllMocks())

describe('label pass — time-interpolated label shapes read the FRAME clock (host._elapsedMs)', () => {
  it('passes host._elapsedMs (not performance.now()) to resolveLabelEffectiveDef', () => {
    const spy = vi.spyOn(helpers, 'resolveLabelEffectiveDef')
    vi.spyOn(performance, 'now').mockReturnValue(5000)
    const h = harness(0) // first rendered frame: frame clock = 0
    labelPass.execute(h.ctx, h.scene, h.host as never)
    expect(spy).toHaveBeenCalled()
    const elapsedArg = spy.mock.calls[0]![3]
    expect(elapsedArg).toBe(0)
  })

  it('first frame (frame clock 0): a non-looping 10→20 size animation starts at 10', () => {
    vi.spyOn(performance, 'now').mockReturnValue(5000)
    const h = harness(0)
    labelPass.execute(h.ctx, h.scene, h.host as never)
    expect(h.addLabel).toHaveBeenCalled()
    const def = h.addLabel.mock.calls[0]![4] as { size: number }
    expect(def.size).toBe(10)
  })

  it('CONTROL: with both clocks at 0 the resolver yields 10 (distinguishes clock from resolver)', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0)
    const h = harness(0)
    labelPass.execute(h.ctx, h.scene, h.host as never)
    expect(h.addLabel).toHaveBeenCalled()
    const def = h.addLabel.mock.calls[0]![4] as { size: number }
    expect(def.size).toBe(10)
  })
})
