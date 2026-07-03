// Unit tests for dead-layer-elim pass. Pin each elimination rule
// and the "preserve live layers" identity invariant.

import { describe, it, expect } from 'vitest'
import { deadLayerElimPass } from './dead-layer-elim'
import type { Scene, RenderNode } from '../render-node'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeNode(overrides: Partial<RenderNode> = {}): RenderNode {
  return {
    name: 'L',
    sourceRef: 'src',
    zOrder: 0,
    fill: { kind: 'constant', rgba: [1, 0, 0, 1] },
    stroke: {
      color: { kind: 'constant', rgba: [0, 0, 0, 1] },
      width: { kind: 'constant', value: 1 },
    },
    opacity: { kind: 'constant', value: 1 },
    size: { kind: 'constant', value: 8 },
    extrude: { kind: 'none' } as never,
    extrudeBase: { kind: 'none' } as never,
    projection: 'mercator',
    visible: true,
    pointerEvents: 'auto',
    filter: null,
    geometry: null,
    billboard: true,
    shape: 'circle' as never,
    ...overrides,
  }
}

function sceneOf(nodes: RenderNode[]): Scene {
  return { sources: [], renderNodes: nodes, symbols: [] }
}

describe('dead-layer-elim — explicit hidden', () => {
  it('drops layers with visible: false', () => {
    const hidden = makeNode({ visible: false })
    const visible = makeNode()
    const out = deadLayerElimPass.run(sceneOf([visible, hidden]))
    expect(out.renderNodes).toHaveLength(1)
    expect(out.renderNodes[0]).toBe(visible)
  })
})

describe('dead-layer-elim — empty zoom range', () => {
  it('drops layers with minzoom === maxzoom', () => {
    const empty = makeNode({ minzoom: 5, maxzoom: 5 })
    const out = deadLayerElimPass.run(sceneOf([empty]))
    expect(out.renderNodes).toHaveLength(0)
  })

  it('drops layers with minzoom > maxzoom', () => {
    const empty = makeNode({ minzoom: 10, maxzoom: 5 })
    const out = deadLayerElimPass.run(sceneOf([empty]))
    expect(out.renderNodes).toHaveLength(0)
  })

  it('keeps layers with valid minzoom < maxzoom band', () => {
    const valid = makeNode({ minzoom: 5, maxzoom: 10 })
    const out = deadLayerElimPass.run(sceneOf([valid]))
    expect(out.renderNodes).toHaveLength(1)
    expect(out.renderNodes[0]).toBe(valid)
  })

  it('keeps layers with only minzoom set (open upper)', () => {
    const minOnly = makeNode({ minzoom: 5 })
    const out = deadLayerElimPass.run(sceneOf([minOnly]))
    expect(out.renderNodes).toHaveLength(1)
  })
})

describe('dead-layer-elim — nothing to draw', () => {
  it('drops layers with no fill, no stroke, no label', () => {
    const noop = makeNode({
      fill: { kind: 'none' },
      stroke: {
        color: { kind: 'none' },
        width: { kind: 'constant', value: 1 },
      },
    })
    const out = deadLayerElimPass.run(sceneOf([noop]))
    expect(out.renderNodes).toHaveLength(0)
  })

  it('drops layers with stroke color but width=0', () => {
    const zeroWidth = makeNode({
      fill: { kind: 'none' },
      stroke: {
        color: { kind: 'constant', rgba: [1, 1, 1, 1] },
        width: { kind: 'constant', value: 0 },
      },
    })
    const out = deadLayerElimPass.run(sceneOf([zeroWidth]))
    expect(out.renderNodes).toHaveLength(0)
  })

  it('keeps layers with fill only (no stroke)', () => {
    const fillOnly = makeNode({
      stroke: {
        color: { kind: 'none' },
        width: { kind: 'constant', value: 0 },
      },
    })
    const out = deadLayerElimPass.run(sceneOf([fillOnly]))
    expect(out.renderNodes).toHaveLength(1)
  })

  it('keeps layers with stroke only (no fill)', () => {
    const strokeOnly = makeNode({
      fill: { kind: 'none' },
    })
    const out = deadLayerElimPass.run(sceneOf([strokeOnly]))
    expect(out.renderNodes).toHaveLength(1)
  })

  it('keeps layers with a label (no fill / stroke)', () => {
    const labelOnly = makeNode({
      fill: { kind: 'none' },
      stroke: {
        color: { kind: 'none' },
        width: { kind: 'constant', value: 0 },
      },
      label: { text: { kind: 'expr', expr: { ast: {} as never } } } as never,
    })
    const out = deadLayerElimPass.run(sceneOf([labelOnly]))
    expect(out.renderNodes).toHaveLength(1)
  })
})

describe('dead-layer-elim — conservative about animation', () => {
  it('KEEPS layers with constant opacity=0 (might animate visible later)', () => {
    // Plan: only DROP layers that can NEVER render. opacity=0 is
    // a known animation base — the keyframes pass may bring it
    // visible. The scheduler's per-frame threshold filters at
    // render time when the animation is also static-0.
    const invisible = makeNode({
      opacity: { kind: 'constant', value: 0 },
    })
    const out = deadLayerElimPass.run(sceneOf([invisible]))
    expect(out.renderNodes).toHaveLength(1)
  })
})

describe('dead-layer-elim — raster source preservation', () => {
  it('KEEPS layers that reference a raster source despite no fill / stroke', () => {
    // Raster layers carry no fill / stroke / label — they paint via
    // texture sampling in the runtime. The pass must not eliminate
    // them on the "nothing to draw" heuristic; the OFM Liberty
    // natural_earth shaded-relief layer otherwise gets dropped and
    // the basemap loses its low-zoom hillshade underlay.
    const rasterNode = makeNode({
      name: 'natural_earth',
      sourceRef: 'ne2_shaded',
      fill: { kind: 'none' },
      stroke: {
        color: { kind: 'none' },
        width: { kind: 'constant', value: 0 },
      },
    })
    const scene: Scene = {
      sources: [{ name: 'ne2_shaded', type: 'raster', url: 'https://x/{z}/{x}/{y}.png' }],
      renderNodes: [rasterNode],
      symbols: [],
    }
    const out = deadLayerElimPass.run(scene)
    expect(out.renderNodes).toHaveLength(1)
    expect(out.renderNodes[0]).toBe(rasterNode)
  })

  it('KEEPS layers that reference a raster-dem source', () => {
    const demNode = makeNode({
      name: 'hillshade',
      sourceRef: 'terrain',
      fill: { kind: 'none' },
      stroke: {
        color: { kind: 'none' },
        width: { kind: 'constant', value: 0 },
      },
    })
    const scene: Scene = {
      sources: [{ name: 'terrain', type: 'raster-dem', url: 'https://x/{z}/{x}/{y}.webp' }],
      renderNodes: [demNode],
      symbols: [],
    }
    const out = deadLayerElimPass.run(scene)
    expect(out.renderNodes).toHaveLength(1)
  })

  it('still drops empty-zoom-range raster layers (raster gate is not unconditional)', () => {
    const dead = makeNode({
      sourceRef: 'ne2_shaded',
      fill: { kind: 'none' },
      stroke: {
        color: { kind: 'none' },
        width: { kind: 'constant', value: 0 },
      },
      minzoom: 5,
      maxzoom: 5,
    })
    const scene: Scene = {
      sources: [{ name: 'ne2_shaded', type: 'raster', url: 'https://x/{z}/{x}/{y}.png' }],
      renderNodes: [dead],
      symbols: [],
    }
    const out = deadLayerElimPass.run(scene)
    expect(out.renderNodes).toHaveLength(0)
  })
})

describe('dead-layer-elim — identity preservation', () => {
  it('returns the same scene reference when nothing was dropped', () => {
    const scene = sceneOf([makeNode(), makeNode({ name: 'L2' })])
    const out = deadLayerElimPass.run(scene)
    expect(out).toBe(scene)
  })

  it('drops only the dead layer, keeps live ones by reference', () => {
    const live = makeNode()
    const dead = makeNode({ visible: false })
    const live2 = makeNode({ name: 'L2' })
    const out = deadLayerElimPass.run(sceneOf([live, dead, live2]))
    expect(out.renderNodes).toHaveLength(2)
    expect(out.renderNodes[0]).toBe(live)
    expect(out.renderNodes[1]).toBe(live2)
  })
})

describe('dead-layer-elim — Phase D.1 transparent fill drop', () => {
  it('drops a layer with constant alpha=0 fill + no stroke + no label + pointerEvents=none', () => {
    const dead = makeNode({
      fill: { kind: 'constant', rgba: [0.5, 0.5, 0.5, 0] },
      stroke: {
        color: { kind: 'none' },
        width: { kind: 'constant', value: 0 },
      },
      pointerEvents: 'none',
    })
    const out = deadLayerElimPass.run(sceneOf([dead]))
    expect(out.renderNodes).toHaveLength(0)
  })

  it('KEEPS transparent fill + opaque stroke (outline-only pattern)', () => {
    // Country borders / admin boundaries — fill is transparent on
    // purpose; the stroke draws the line. MUST keep.
    const outlineOnly = makeNode({
      fill: { kind: 'constant', rgba: [0, 0, 0, 0] },
      stroke: {
        color: { kind: 'constant', rgba: [0.2, 0.2, 0.2, 1] },
        width: { kind: 'constant', value: 1 },
      },
      pointerEvents: 'none',
    })
    const out = deadLayerElimPass.run(sceneOf([outlineOnly]))
    expect(out.renderNodes).toHaveLength(1)
    expect(out.renderNodes[0]).toBe(outlineOnly)
  })

  it('KEEPS transparent fill when pointerEvents=auto (invisible hit target)', () => {
    // Anti-pattern but valid use: an author wants a click region
    // that overlays other content invisibly. Dropping would break
    // the click handler.
    const hitTarget = makeNode({
      fill: { kind: 'constant', rgba: [0, 0, 0, 0] },
      stroke: {
        color: { kind: 'none' },
        width: { kind: 'constant', value: 0 },
      },
      pointerEvents: 'auto',
    })
    const out = deadLayerElimPass.run(sceneOf([hitTarget]))
    expect(out.renderNodes).toHaveLength(1)
    expect(out.renderNodes[0]).toBe(hitTarget)
  })

  it('KEEPS data-driven fill (could resolve non-zero alpha per feature)', () => {
    // Conservative: data-driven can't be statically proved transparent.
    const dataDriven = makeNode({
      fill: { kind: 'data-driven', expr: { ast: { kind: 'Identifier', name: 'class' } as never } },
      stroke: {
        color: { kind: 'none' },
        width: { kind: 'constant', value: 0 },
      },
      pointerEvents: 'none',
    })
    const out = deadLayerElimPass.run(sceneOf([dataDriven]))
    expect(out.renderNodes).toHaveLength(1)
  })

  it('drops zoom-interpolated fill where EVERY stop has alpha=0', () => {
    // Two stops, both alpha=0 → linear interpolation between them
    // is also alpha=0 → fill stays transparent at every zoom.
    const allTransparent = makeNode({
      fill: {
        kind: 'zoom-interpolated',
        stops: [
          { zoom: 0, value: [1, 0, 0, 0] },
          { zoom: 20, value: [0, 0, 1, 0] },
        ],
      },
      stroke: {
        color: { kind: 'none' },
        width: { kind: 'constant', value: 0 },
      },
      pointerEvents: 'none',
    })
    const out = deadLayerElimPass.run(sceneOf([allTransparent]))
    expect(out.renderNodes).toHaveLength(0)
  })

  it('KEEPS zoom-interpolated fill when at least one stop has alpha>0', () => {
    // Mix of transparent + opaque stops → interpolated alpha is
    // non-zero somewhere in the camera zoom range.
    const mixed = makeNode({
      fill: {
        kind: 'zoom-interpolated',
        stops: [
          { zoom: 0, value: [1, 0, 0, 0] },
          { zoom: 20, value: [0, 0, 1, 1] },
        ],
      },
      stroke: {
        color: { kind: 'none' },
        width: { kind: 'constant', value: 0 },
      },
      pointerEvents: 'none',
    })
    const out = deadLayerElimPass.run(sceneOf([mixed]))
    expect(out.renderNodes).toHaveLength(1)
  })

  it('REGRESSION: opacity:0 with non-transparent fill STILL KEPT', () => {
    // dead-layer-elim policy header pin (lines 23-25): opacity is
    // the animation-base channel and stays alive even when the
    // current value is 0. Phase D.1 only targets the FILL alpha
    // channel.
    const opacityZero = makeNode({
      opacity: { kind: 'constant', value: 0 },
      // fill is opaque (alpha=1); only opacity multiplies to 0.
      fill: { kind: 'constant', rgba: [1, 0, 0, 1] },
      pointerEvents: 'none',
    })
    const out = deadLayerElimPass.run(sceneOf([opacityZero]))
    expect(out.renderNodes).toHaveLength(1)
    expect(out.renderNodes[0]).toBe(opacityZero)
  })
})

describe('dead-layer-elim — pass metadata', () => {
  it('declares the right name and depends on merge-layers + folds', () => {
    expect(deadLayerElimPass.name).toBe('dead-layer-elim')
    expect(deadLayerElimPass.dependencies).toEqual([
      'merge-layers',
      'fold-trivial-stops',
      'fold-trivial-case',
    ])
  })
})
