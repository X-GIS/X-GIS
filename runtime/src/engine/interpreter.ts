// ═══ AST Interpreter — AST를 실행 가능한 명령으로 변환 ═══

import type * as AST from '@xgis/compiler'
import { resolveUtilities } from '@xgis/compiler'
import type { ShowCommand } from './renderer'

export interface LoadCommand {
  name: string
  url: string
}

export interface SceneCommands {
  loads: LoadCommand[]
  shows: ShowCommand[]
  symbols?: { name: string; paths: string[] }[]
}

/**
 * Interpret a parsed X-GIS program into executable commands.
 * Handles both legacy (let/show) and new (source/layer) syntax.
 */
export function interpret(program: AST.Program): SceneCommands {
  const loads: LoadCommand[] = []
  const shows: ShowCommand[] = []
  const sources = new Map<string, SourceDef>()

  for (const stmt of program.body) {
    if (stmt.kind === 'LetStatement') {
      const load = extractLoad(stmt)
      if (load) loads.push(load)
    } else if (stmt.kind === 'ShowStatement') {
      const show = extractShow(stmt)
      if (show) shows.push(show)
    } else if (stmt.kind === 'SourceStatement') {
      const src = extractSource(stmt)
      if (src) sources.set(src.name, src)
    } else if (stmt.kind === 'LayerStatement') {
      const result = extractLayer(stmt, sources)
      if (result) {
        loads.push(result.load)
        shows.push(result.show)
      }
    }
  }

  return { loads, shows }
}

// ═══ New syntax: source/layer ═══

interface SourceDef {
  name: string
  type: string
  url: string
}

function extractSource(stmt: AST.SourceStatement): SourceDef | null {
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

function extractLayer(
  stmt: AST.LayerStatement,
  sources: Map<string, SourceDef>,
): { load: LoadCommand; show: ShowCommand } | null {
  // Find source reference
  let sourceName = ''
  for (const prop of stmt.properties) {
    if (prop.name === 'source' && prop.value.kind === 'Identifier') {
      sourceName = prop.value.name
    }
  }

  const sourceDef = sources.get(sourceName)
  if (!sourceDef) return null

  // Collect all utility items from all lines
  const allItems: AST.UtilityItem[] = []
  for (const line of stmt.utilities) {
    allItems.push(...line.items)
  }

  // Resolve utilities to properties
  const resolved = resolveUtilities(allItems)

  return {
    load: { name: sourceDef.name, url: sourceDef.url },
    show: {
      targetName: sourceDef.name,
      fill: resolved.fill,
      stroke: resolved.stroke,
      strokeWidth: resolved.strokeWidth,
      projection: resolved.projection,
      visible: resolved.visible,
      opacity: resolved.opacity,
    },
  }
}

// ═══ Legacy syntax: let/show ═══

function extractLoad(stmt: AST.LetStatement): LoadCommand | null {
  if (stmt.value.kind === 'FnCall') {
    const callee = stmt.value.callee
    if (callee.kind === 'Identifier' && callee.name === 'load') {
      const arg = stmt.value.args[0]
      if (arg && arg.kind === 'StringLiteral') {
        return { name: stmt.name, url: arg.value }
      }
    }
  }
  return null
}

function extractShow(stmt: AST.ShowStatement): ShowCommand | null {
  let targetName = ''
  if (stmt.target.kind === 'Identifier') {
    targetName = stmt.target.name
  }

  let fill: string | null = null
  let stroke: string | null = null
  let strokeWidth = 1
  let projection = 'mercator'
  let visible = true
  let opacity = 1.0

  for (const prop of stmt.block.properties) {
    if (prop.name === 'fill') {
      const val = prop.values[0]
      if (val && val.kind === 'ColorLiteral') {
        fill = val.value
      }
    } else if (prop.name === 'projection') {
      const val = prop.values[0]
      if (val && val.kind === 'Identifier') {
        projection = val.name
      }
    } else if (prop.name === 'visible') {
      const val = prop.values[0]
      if (val && val.kind === 'BoolLiteral') {
        visible = val.value
      }
    } else if (prop.name === 'opacity') {
      const val = prop.values[0]
      if (val && val.kind === 'NumberLiteral') {
        opacity = val.value
      }
    } else if (prop.name === 'stroke') {
      const val = prop.values[0]
      if (val && val.kind === 'ColorLiteral') {
        stroke = val.value
      }
      const widthVal = prop.values[1]
      if (widthVal && widthVal.kind === 'NumberLiteral') {
        strokeWidth = widthVal.value
      }
    }
  }

  return { targetName, fill, stroke, strokeWidth, projection, visible, opacity }
}
