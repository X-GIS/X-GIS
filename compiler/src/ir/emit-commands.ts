// ═══ IR → SceneCommands Bridge ═══
// Converts IR Scene to the existing runtime SceneCommands format.
// This bridge allows the runtime to consume IR without changes.

import type { Scene, RenderNode, ColorValue, ZoomStop, DataExpr } from './render-node'
import { rgbaToHex } from './render-node'
import { generateShaderVariant, type ShaderVariant } from '../codegen/shader-gen'

export type { ShaderVariant } from '../codegen/shader-gen'

export interface LoadCommand {
  name: string
  url: string
}

export interface ShowCommand {
  targetName: string
  fill: string | null
  stroke: string | null
  strokeWidth: number
  projection: string
  visible: boolean
  opacity: number
  size: number | null
  zoomOpacityStops: ZoomStop<number>[] | null
  zoomSizeStops: ZoomStop<number>[] | null
  shaderVariant: ShaderVariant | null
  filterExpr: DataExpr | null
  geometryExpr: DataExpr | null
}

export interface SceneCommands {
  loads: LoadCommand[]
  shows: ShowCommand[]
}

/**
 * Convert an IR Scene to the legacy SceneCommands format
 * that the existing runtime expects.
 */
export function emitCommands(scene: Scene): SceneCommands {
  const loads: LoadCommand[] = scene.sources.map(src => ({
    name: src.name,
    url: src.url,
  }))

  const shows: ShowCommand[] = scene.renderNodes.map(emitShow)

  return { loads, shows }
}

function emitShow(node: RenderNode): ShowCommand {
  // Generate shader variant for this layer
  const shaderVariant = generateShaderVariant(node)

  return {
    targetName: node.sourceRef,
    fill: colorToHex(node.fill),
    stroke: colorToHex(node.stroke.color),
    strokeWidth: node.stroke.width,
    projection: node.projection,
    visible: node.visible,
    opacity: node.opacity.kind === 'constant' ? node.opacity.value : 1.0,
    size: node.size.kind === 'constant' ? node.size.value : null,
    zoomOpacityStops: node.opacity.kind === 'zoom-interpolated' ? node.opacity.stops : null,
    zoomSizeStops: node.size.kind === 'zoom-interpolated' ? node.size.stops : null,
    shaderVariant,
    filterExpr: node.filter,
    geometryExpr: node.geometry,
  }
}

function colorToHex(color: ColorValue): string | null {
  if (color.kind === 'none') return null
  if (color.kind === 'constant') return rgbaToHex(color.rgba)
  return null
}
