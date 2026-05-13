// Diagnostic: count match expressions and "trivial" matches (all arms
// produce the same value) on real OFM fixtures. Drives the decision
// of how complex fold-trivial-case needs to be.

import { describe, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Lexer } from '../../lexer/lexer'
import { Parser } from '../../parser/parser'
import { lower } from '../lower'
import { optimize } from '../optimize'
import { convertMapboxStyle } from '../../convert/mapbox-to-xgis'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIX = join(HERE, '..', '..', '__tests__', 'fixtures')

function probeMatchExprs(fixture: string) {
  const json = JSON.parse(readFileSync(join(FIX, fixture), 'utf8'))
  const xgis = convertMapboxStyle(json, { warn: () => {} })
  const tokens = new Lexer(xgis).tokenize()
  const program = new Parser(tokens).parse()
  const scene = optimize(lower(program), program)
  let anyMatch = 0
  let trivial = 0
  const examples: string[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function inspect(node: any, label: string) {
    if (!node) return
    if (node.kind === 'data-driven' && node.expr?.ast) {
      const ast = node.expr.ast
      if (ast.kind === 'FnCall' && ast.matchBlock) {
        anyMatch++
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const arms = ast.matchBlock.arms as { value: unknown }[]
        if (arms.length > 1) {
          const first = JSON.stringify(arms[0]!.value)
          const allSame = arms.every(a => JSON.stringify(a.value) === first)
          if (allSame) {
            trivial++
            if (examples.length < 5) examples.push(label)
          }
        }
      }
    }
  }
  for (const rn of scene.renderNodes) {
    inspect(rn.fill, `${rn.name}:fill`)
    inspect(rn.stroke.color, `${rn.name}:strokeColor`)
    inspect(rn.stroke.width, `${rn.name}:strokeWidth`)
    inspect(rn.opacity, `${rn.name}:opacity`)
    inspect(rn.size, `${rn.name}:size`)
  }
  return { anyMatch, trivial, examples }
}

describe('match expression statistics on real fixtures', () => {
  for (const fixture of ['openfreemap-bright.json', 'openfreemap-liberty.json', 'openfreemap-positron.json']) {
    it(`reports counts for ${fixture}`, () => {
      const stats = probeMatchExprs(fixture)
      // eslint-disable-next-line no-console
      console.log(`[${fixture}] match exprs: ${stats.anyMatch}, trivial: ${stats.trivial}, examples: ${stats.examples.join(' | ')}`)
    })
  }
})
