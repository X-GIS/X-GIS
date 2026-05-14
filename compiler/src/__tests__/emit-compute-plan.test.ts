// ═══════════════════════════════════════════════════════════════════
// SceneCommands.computePlan emission — tests
// ═══════════════════════════════════════════════════════════════════
//
// Asserts the contract: emitCommands surfaces the compute plan on
// SceneCommands so the runtime can consume it. The plan walk is
// pure (covered by compute-plan.test.ts); this test pins the
// end-to-end emission path — build a Scene IR by hand (skipping the
// parser to avoid coupling to .xgis syntax) and inspect the emitted
// SceneCommands shape.

import { describe, expect, it } from 'vitest'
import { emitCommands } from '../ir/emit-commands'
import type {
  ColorValue, DataExpr, RenderNode, Scene, SizeValue, StrokeValue,
} from '../ir/render-node'
import type { PropertyShape, RGBA } from '../ir/property-types'

const RED: RGBA = [1, 0, 0, 1]
const BLUE: RGBA = [0, 0, 1, 1]

function fieldAccess(name: string) {
  return { kind: 'FieldAccess' as const, object: null, field: name }
}

function matchExpr(field: string, arms: { pattern: string; hex: string }[]): DataExpr {
  return {
    ast: {
      kind: 'FnCall',
      callee: { kind: 'Identifier', name: 'match' },
      args: [fieldAccess(field)],
      matchBlock: {
        kind: 'MatchBlock',
        arms: arms.map(a => ({
          pattern: a.pattern,
          value: { kind: 'ColorLiteral' as const, value: a.hex },
        })),
      },
    },
  }
}

function makeNode(overrides: Partial<RenderNode> = {}): RenderNode {
  return {
    name: 'a', sourceRef: 's', zOrder: 0,
    fill: { kind: 'none' },
    stroke: {
      color: { kind: 'none' },
      width: { kind: 'constant', value: 0 } as PropertyShape<number>,
    } as StrokeValue,
    opacity: { kind: 'constant', value: 1 },
    size: { kind: 'none' } as SizeValue,
    extrude: { kind: 'none' } as never,
    extrudeBase: { kind: 'none' } as never,
    projection: 'mercator', visible: true, pointerEvents: 'auto',
    filter: null, geometry: null, billboard: true,
    shape: { kind: 'named', name: 'circle' } as never,
    ...overrides,
  }
}

function makeScene(nodes: RenderNode[]): Scene {
  return { sources: [], symbols: [], renderNodes: nodes } as Scene
}

describe('emitCommands — computePlan emission', () => {
  it('all-constant scene → computePlan field omitted', () => {
    const scene = makeScene([
      makeNode({ fill: { kind: 'constant', rgba: RED } }),
    ])
    const cmds = emitCommands(scene)
    expect(cmds.computePlan).toBeUndefined()
  })

  it('data-driven match() fill → computePlan with one entry', () => {
    const scene = makeScene([
      makeNode({
        fill: {
          kind: 'data-driven',
          expr: matchExpr('class', [
            { pattern: 'school',   hex: '#f0e8f8' },
            { pattern: 'hospital', hex: '#f5deb3' },
            { pattern: '_',        hex: '#888888' },
          ]),
        },
      }),
    ])
    const cmds = emitCommands(scene)
    expect(cmds.computePlan).toBeDefined()
    expect(cmds.computePlan!.length).toBe(1)
    const entry = cmds.computePlan![0]!
    expect(entry.paintAxis).toBe('fill')
    expect(entry.renderNodeIndex).toBe(0)
    expect(entry.kernel.entryPoint).toBe('eval_match')
    expect(entry.fieldOrder).toEqual(['class'])
    expect(entry.categoryOrder['class']).toEqual(['hospital', 'school'])
  })

  it('conditional fill → ternary kernel entry', () => {
    const scene = makeScene([
      makeNode({
        fill: {
          kind: 'conditional',
          branches: [{ field: 'flag', value: { kind: 'constant', rgba: RED } }],
          fallback: { kind: 'constant', rgba: BLUE },
        },
      }),
    ])
    const cmds = emitCommands(scene)
    expect(cmds.computePlan!.length).toBe(1)
    expect(cmds.computePlan![0]!.kernel.entryPoint).toBe('eval_case')
  })

  it('multi-show scene: only data-driven shows appear in plan with correct indices', () => {
    const scene = makeScene([
      makeNode({ fill: { kind: 'constant', rgba: RED } }),  // index 0
      makeNode({
        fill: {
          kind: 'data-driven',
          expr: matchExpr('kind', [
            { pattern: 'motorway', hex: '#ffaa00' },
            { pattern: '_',        hex: '#888888' },
          ]),
        },
      }),                                                    // index 1
    ])
    const cmds = emitCommands(scene)
    expect(cmds.computePlan!.length).toBe(1)
    expect(cmds.computePlan![0]!.renderNodeIndex).toBe(1)
    expect(cmds.computePlan![0]!.fieldOrder).toEqual(['kind'])
  })

  it('zoom-interpolated fill → no computePlan (route is palette / cpu, not compute)', () => {
    const scene = makeScene([
      makeNode({
        fill: {
          kind: 'zoom-interpolated',
          stops: [{ zoom: 0, value: RED }, { zoom: 20, value: BLUE }],
        } as ColorValue,
      }),
    ])
    const cmds = emitCommands(scene)
    // No FEATURE deps → router classifies as palette-zoom or
    // cpu-uniform; never reaches compute path.
    expect(cmds.computePlan).toBeUndefined()
  })

  it('computePlan entry kernel.entryPoint matches a fn declared in the wgsl', () => {
    const scene = makeScene([
      makeNode({
        fill: {
          kind: 'data-driven',
          expr: matchExpr('k', [
            { pattern: 'a', hex: '#ff0000' },
            { pattern: '_', hex: '#000000' },
          ]),
        },
      }),
    ])
    const cmds = emitCommands(scene)
    const entry = cmds.computePlan![0]!
    expect(entry.kernel.wgsl).toContain(`fn ${entry.kernel.entryPoint}(`)
  })
})
