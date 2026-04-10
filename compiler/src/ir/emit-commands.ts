// ═══ IR → SceneCommands Bridge ═══
// Converts IR Scene to the existing runtime SceneCommands format.
// This bridge allows the runtime to consume IR without changes.

import type { Scene, RenderNode, ColorValue } from './render-node'
import { rgbaToHex } from './render-node'

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
  return {
    targetName: node.sourceRef,
    fill: colorToHex(node.fill),
    stroke: colorToHex(node.stroke.color),
    strokeWidth: node.stroke.width,
    projection: node.projection,
    visible: node.visible,
    opacity: node.opacity.kind === 'constant' ? node.opacity.value : 1.0,
  }
}

function colorToHex(color: ColorValue): string | null {
  if (color.kind === 'none') return null
  if (color.kind === 'constant') return rgbaToHex(color.rgba)
  return null
}
