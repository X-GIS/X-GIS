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
  type SizeValue,
  type OpacityValue,
  type ZoomStop,
  type ConditionalBranch,
  colorNone,
  colorConstant,
  opacityConstant,
  sizeNone,
  sizeConstant,
  hexToRgba,
} from './render-node'

/**
 * Lower an AST Program into an IR Scene.
 */
export function lower(program: AST.Program): Scene {
  const sources: SourceDef[] = []
  const renderNodes: RenderNode[] = []
  const sourceMap = new Map<string, SourceDef>()
  const presetMap = new Map<string, AST.UtilityLine[]>()
  const styleMap = new Map<string, AST.StyleProperty[]>()

  // First pass: collect presets and styles
  for (const stmt of program.body) {
    if (stmt.kind === 'PresetStatement') {
      presetMap.set(stmt.name, stmt.utilities)
    } else if (stmt.kind === 'StyleStatement') {
      styleMap.set(stmt.name, stmt.properties)
    }
  }

  for (const stmt of program.body) {
    switch (stmt.kind) {
      case 'PresetStatement':
      case 'StyleStatement':
        break // already processed in first pass
      case 'SourceStatement': {
        const src = lowerSource(stmt)
        if (src) {
          sources.push(src)
          sourceMap.set(src.name, src)
        }
        break
      }
      case 'LayerStatement': {
        const node = lowerLayer(stmt, sourceMap, presetMap, styleMap)
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

function lowerLayer(
  stmt: AST.LayerStatement,
  sourceMap: Map<string, SourceDef>,
  presetMap: Map<string, AST.UtilityLine[]>,
  styleMap: Map<string, AST.StyleProperty[]>,
): RenderNode | null {
  // Extract block properties
  let sourceRef = ''
  let zOrder = 0
  let styleRef = ''
  let filterExpr: import('../parser/ast').Expr | null = null

  for (const prop of stmt.properties) {
    if (prop.name === 'source' && prop.value.kind === 'Identifier') {
      sourceRef = prop.value.name
    } else if (prop.name === 'z-order' && prop.value.kind === 'NumberLiteral') {
      zOrder = prop.value.value
    } else if (prop.name === 'style' && prop.value.kind === 'Identifier') {
      styleRef = prop.value.name
    } else if (prop.name === 'filter') {
      filterExpr = prop.value
    }
  }

  if (!sourceRef || !sourceMap.has(sourceRef)) return null

  // Expand presets: apply-name → inline preset's utility items
  const expandedUtilities = expandPresets(stmt.utilities, presetMap)

  // Process utility lines
  let fill: ColorValue = colorNone()
  let strokeColor: ColorValue = colorNone()
  let strokeWidth = 1
  let opacity: OpacityValue = opacityConstant(1.0)
  let size: SizeValue = sizeNone()
  let projection = 'mercator'
  let visible = true

  // Cascade order: named style → inline CSS → utilities
  // 1. Apply named style (lowest priority)
  if (styleRef) {
    const namedProps = styleMap.get(styleRef)
    if (namedProps) {
      const result = applyStyleProperties(namedProps, fill, strokeColor, strokeWidth, opacity, projection, visible)
      fill = result.fill; strokeColor = result.strokeColor; strokeWidth = result.strokeWidth
      opacity = result.opacity; projection = result.projection; visible = result.visible
    }
  }

  // 2. Apply inline CSS-like properties (overrides named style)
  if (stmt.styleProperties.length > 0) {
    const result = applyStyleProperties(stmt.styleProperties, fill, strokeColor, strokeWidth, opacity, projection, visible)
    fill = result.fill; strokeColor = result.strokeColor; strokeWidth = result.strokeWidth
    opacity = result.opacity; projection = result.projection; visible = result.visible
  }

  // Collectors for modifier-based values
  const fillBranches: ConditionalBranch<ColorValue>[] = []
  const opacityZoomStops: ZoomStop<number>[] = []
  const sizeZoomStops: ZoomStop<number>[] = []

  for (const line of expandedUtilities) {
    for (const item of line.items) {
      const name = item.name
      const mod = item.modifier

      // ── Modifier items ──
      if (mod) {
        // Zoom modifier: z8:opacity-40, z14:size-12
        const zoomMatch = mod.match(/^z(\d+)$/)
        if (zoomMatch) {
          const zoom = parseInt(zoomMatch[1])
          if (name.startsWith('opacity-')) {
            const num = parseFloat(name.slice(8))
            if (!isNaN(num)) {
              opacityZoomStops.push({ zoom, value: num <= 1 ? num : num / 100 })
            }
          } else if (name.startsWith('size-')) {
            const num = parseFloat(name.slice(5))
            if (!isNaN(num)) {
              sizeZoomStops.push({ zoom, value: num })
            }
          }
          continue
        }

        // Data modifier: friendly:fill-green-500
        if (name.startsWith('fill-')) {
          const hex = resolveColor(name.slice(5))
          if (hex) {
            fillBranches.push({ field: mod, value: colorConstant(...hexToRgba(hex)) })
          }
        }
        continue
      }

      // ── Unmodified items ──

      // Data binding: fill-[expr], size-[expr], opacity-[expr]
      if (item.binding) {
        if (name === 'fill') {
          fill = { kind: 'data-driven', expr: { ast: item.binding } }
        } else if (name === 'size') {
          size = { kind: 'data-driven', expr: { ast: item.binding } }
        } else if (name === 'opacity') {
          opacity = { kind: 'data-driven', expr: { ast: item.binding } }
        }
        continue
      }

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
          const val = num <= 1 ? num : num / 100
          opacity = opacityConstant(val)
        }
      } else if (name.startsWith('size-')) {
        const num = parseFloat(name.slice(5))
        if (!isNaN(num)) {
          size = sizeConstant(num)
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

  // Build conditional fill if branches exist
  if (fillBranches.length > 0) {
    fill = { kind: 'conditional', branches: fillBranches, fallback: fill }
  }

  // Build zoom-interpolated opacity if stops exist
  if (opacityZoomStops.length > 0) {
    opacityZoomStops.sort((a, b) => a.zoom - b.zoom)
    opacity = { kind: 'zoom-interpolated', stops: opacityZoomStops }
  }

  // Build zoom-interpolated size if stops exist
  if (sizeZoomStops.length > 0) {
    sizeZoomStops.sort((a, b) => a.zoom - b.zoom)
    size = { kind: 'zoom-interpolated', stops: sizeZoomStops }
  }

  return {
    name: stmt.name,
    sourceRef,
    zOrder,
    fill,
    stroke: { color: strokeColor, width: strokeWidth },
    opacity,
    size,
    projection,
    visible,
    filter: filterExpr ? { ast: filterExpr } : null,
  }
}

/**
 * Apply CSS-like style properties to rendering values.
 * Resolves color names (via Tailwind palette), hex colors, and numbers.
 */
function applyStyleProperties(
  props: AST.StyleProperty[],
  fill: ColorValue,
  strokeColor: ColorValue,
  strokeWidth: number,
  opacity: OpacityValue,
  projection: string,
  visible: boolean,
): { fill: ColorValue; strokeColor: ColorValue; strokeWidth: number; opacity: OpacityValue; projection: string; visible: boolean } {
  for (const prop of props) {
    switch (prop.name) {
      case 'fill': {
        const hex = resolveColor(prop.value) ?? (prop.value.startsWith('#') ? prop.value : null)
        if (hex) fill = colorConstant(...hexToRgba(hex))
        break
      }
      case 'stroke': {
        const hex = resolveColor(prop.value) ?? (prop.value.startsWith('#') ? prop.value : null)
        if (hex) strokeColor = colorConstant(...hexToRgba(hex))
        break
      }
      case 'stroke-width': {
        const num = parseFloat(prop.value)
        if (!isNaN(num)) strokeWidth = num
        break
      }
      case 'opacity': {
        const num = parseFloat(prop.value)
        if (!isNaN(num)) opacity = opacityConstant(num <= 1 ? num : num / 100)
        break
      }
      case 'size': {
        // size is not currently in the return signature but utilities handle it
        break
      }
      case 'projection': {
        projection = prop.value
        break
      }
      case 'visible': {
        visible = prop.value === 'true'
        break
      }
    }
  }
  return { fill, strokeColor, strokeWidth, opacity, projection, visible }
}

/**
 * Expand apply-presetName items by inlining the preset's utility lines.
 * Preset items come first (lower priority), layer items come after (override).
 */
function expandPresets(
  utilities: AST.UtilityLine[],
  presetMap: Map<string, AST.UtilityLine[]>,
): AST.UtilityLine[] {
  const result: AST.UtilityLine[] = []

  for (const line of utilities) {
    const expandedItems: AST.UtilityItem[] = []

    for (const item of line.items) {
      if (item.name.startsWith('apply-') && !item.modifier) {
        const presetName = item.name.slice(6)
        const preset = presetMap.get(presetName)
        if (preset) {
          // Inline preset lines before current line's remaining items
          result.push(...preset)
        }
      } else {
        expandedItems.push(item)
      }
    }

    if (expandedItems.length > 0) {
      result.push({ kind: 'UtilityLine', items: expandedItems, line: line.line })
    }
  }

  return result
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
    size: sizeNone(),
    projection,
    visible,
    filter: null,
  }
}
