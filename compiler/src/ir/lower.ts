// ═══ AST → IR Lowering Pass ═══
// Converts parsed AST into the intermediate representation (Scene).
// Handles both legacy (let/show) and new (source/layer) syntax.

import type * as AST from '../parser/ast'
import { resolveColor } from '../tokens/colors'
import {
  type Scene,
  type SourceDef,
  type RenderNode,
  type ColorValue,
  colorNone,
  colorConstant,
  opacityConstant,
  hexToRgba,
} from './render-node'

/**
 * Lower an AST Program into an IR Scene.
 */
export function lower(program: AST.Program): Scene {
  const sources: SourceDef[] = []
  const renderNodes: RenderNode[] = []
  const sourceMap = new Map<string, SourceDef>()

  for (const stmt of program.body) {
    switch (stmt.kind) {
      case 'SourceStatement': {
        const src = lowerSource(stmt)
        if (src) {
          sources.push(src)
          sourceMap.set(src.name, src)
        }
        break
      }
      case 'LayerStatement': {
        const node = lowerLayer(stmt, sourceMap)
        if (node) {
          // If the source was referenced but not yet added, add it
          if (!sources.find(s => s.name === node.sourceRef)) {
            const src = sourceMap.get(node.sourceRef)
            if (src) sources.push(src)
          }
          renderNodes.push(node)
        }
        break
      }
      case 'LetStatement': {
        const src = lowerLetAsSource(stmt)
        if (src) {
          sources.push(src)
          sourceMap.set(src.name, src)
        }
        break
      }
      case 'ShowStatement': {
        const node = lowerShow(stmt)
        if (node) renderNodes.push(node)
        break
      }
    }
  }

  return { sources, renderNodes }
}

// ═══ New syntax lowering ═══

function lowerSource(stmt: AST.SourceStatement): SourceDef | null {
  let type = 'geojson'
  let url = ''

  for (const prop of stmt.properties) {
    if (prop.name === 'type' && prop.value.kind === 'Identifier') {
      type = prop.value.name
    } else if (prop.name === 'url' && prop.value.kind === 'StringLiteral') {
      url = prop.value.value
    }
  }

  if (!url) return null
  return { name: stmt.name, type, url }
}

function lowerLayer(stmt: AST.LayerStatement, sourceMap: Map<string, SourceDef>): RenderNode | null {
  // Extract block properties
  let sourceRef = ''
  let zOrder = 0

  for (const prop of stmt.properties) {
    if (prop.name === 'source' && prop.value.kind === 'Identifier') {
      sourceRef = prop.value.name
    } else if (prop.name === 'z-order' && prop.value.kind === 'NumberLiteral') {
      zOrder = prop.value.value
    }
  }

  if (!sourceRef || !sourceMap.has(sourceRef)) return null

  // Process utility lines
  let fill: ColorValue = colorNone()
  let strokeColor: ColorValue = colorNone()
  let strokeWidth = 1
  let opacity = 1.0
  let projection = 'mercator'
  let visible = true

  for (const line of stmt.utilities) {
    for (const item of line.items) {
      // Skip modifier items for Phase 0
      if (item.modifier) continue

      const name = item.name

      if (name.startsWith('fill-')) {
        const hex = resolveColor(name.slice(5))
        if (hex) fill = colorConstant(...hexToRgba(hex))
      } else if (name.startsWith('stroke-')) {
        const rest = name.slice(7)
        const num = parseFloat(rest)
        if (!isNaN(num) && rest === String(num)) {
          strokeWidth = num
        } else {
          const hex = resolveColor(rest)
          if (hex) strokeColor = colorConstant(...hexToRgba(hex))
        }
      } else if (name.startsWith('opacity-')) {
        const num = parseFloat(name.slice(8))
        if (!isNaN(num)) {
          opacity = num <= 1 ? num : num / 100
        }
      } else if (name.startsWith('projection-')) {
        projection = name.slice(11)
      } else if (name === 'hidden') {
        visible = false
      } else if (name === 'visible') {
        visible = true
      }
    }
  }

  return {
    name: stmt.name,
    sourceRef,
    zOrder,
    fill,
    stroke: { color: strokeColor, width: strokeWidth },
    opacity: opacityConstant(opacity),
    projection,
    visible,
  }
}

// ═══ Legacy syntax lowering ═══

function lowerLetAsSource(stmt: AST.LetStatement): SourceDef | null {
  if (stmt.value.kind !== 'FnCall') return null
  const callee = stmt.value.callee
  if (callee.kind !== 'Identifier' || callee.name !== 'load') return null
  const arg = stmt.value.args[0]
  if (!arg || arg.kind !== 'StringLiteral') return null

  // Detect type from URL pattern
  const url = arg.value
  const type = url.includes('{z}') ? 'raster' : 'geojson'

  return { name: stmt.name, type, url }
}

function lowerShow(stmt: AST.ShowStatement): RenderNode | null {
  let targetName = ''
  if (stmt.target.kind === 'Identifier') {
    targetName = stmt.target.name
  }
  if (!targetName) return null

  let fill: ColorValue = colorNone()
  let strokeColor: ColorValue = colorNone()
  let strokeWidth = 1
  let opacity = 1.0
  let projection = 'mercator'
  let visible = true

  for (const prop of stmt.block.properties) {
    if (prop.name === 'fill') {
      const val = prop.values[0]
      if (val?.kind === 'ColorLiteral') {
        fill = colorConstant(...hexToRgba(val.value))
      }
    } else if (prop.name === 'stroke') {
      const val = prop.values[0]
      if (val?.kind === 'ColorLiteral') {
        strokeColor = colorConstant(...hexToRgba(val.value))
      }
      const widthVal = prop.values[1]
      if (widthVal?.kind === 'NumberLiteral') {
        strokeWidth = widthVal.value
      }
    } else if (prop.name === 'opacity') {
      const val = prop.values[0]
      if (val?.kind === 'NumberLiteral') opacity = val.value
    } else if (prop.name === 'projection') {
      const val = prop.values[0]
      if (val?.kind === 'Identifier') projection = val.name
    } else if (prop.name === 'visible') {
      const val = prop.values[0]
      if (val?.kind === 'BoolLiteral') visible = val.value
    }
  }

  return {
    name: targetName,
    sourceRef: targetName,
    zOrder: 0,
    fill,
    stroke: { color: strokeColor, width: strokeWidth },
    opacity: opacityConstant(opacity),
    projection,
    visible,
  }
}
