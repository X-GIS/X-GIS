// ═══ AST Interpreter — AST를 실행 가능한 명령으로 변환 ═══

import type * as AST from '@xgis/compiler'
import type { ShowCommand } from './renderer'

export interface LoadCommand {
  name: string
  url: string
}

export interface SceneCommands {
  loads: LoadCommand[]
  shows: ShowCommand[]
}

/**
 * Interpret a parsed X-GIS program into executable commands.
 * MVP: handles let + load() and show blocks only.
 */
export function interpret(program: AST.Program): SceneCommands {
  const loads: LoadCommand[] = []
  const shows: ShowCommand[] = []

  for (const stmt of program.body) {
    if (stmt.kind === 'LetStatement') {
      const load = extractLoad(stmt)
      if (load) loads.push(load)
    } else if (stmt.kind === 'ShowStatement') {
      const show = extractShow(stmt)
      if (show) shows.push(show)
    }
  }

  return { loads, shows }
}

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
