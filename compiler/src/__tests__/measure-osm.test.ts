import { describe, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { optimize } from '../ir/optimize'
import { readFileSync } from 'fs'
import { resolve } from 'path'

describe('measure: real osm-style.xgis merge result', () => {
  it('reports input vs output layer count', () => {
    const path = resolve(__dirname, '../../../playground/src/examples/osm-style.xgis')
    const src = readFileSync(path, 'utf-8')
    const tokens = new Lexer(src).tokenize()
    const ast = new Parser(tokens).parse()
    const lowered = lower(ast)
    const optimized = optimize(lowered, ast)
    // eslint-disable-next-line no-console
    console.log(`Input: ${lowered.renderNodes.length} layers`)
    for (let i = 0; i < lowered.renderNodes.length; i++) {
      const n = lowered.renderNodes[i]
      // eslint-disable-next-line no-console
      console.log(`  ${i}: ${n.name} [${n.sourceLayer ?? '-'}]`)
    }
    // eslint-disable-next-line no-console
    console.log(`\nOutput: ${optimized.renderNodes.length} layers`)
    for (let i = 0; i < optimized.renderNodes.length; i++) {
      const n = optimized.renderNodes[i]
      // eslint-disable-next-line no-console
      console.log(`  ${i}: ${n.name} [${n.sourceLayer ?? '-'}] fill=${n.fill.kind} stroke=${n.stroke.color.kind}`)
    }
    // eslint-disable-next-line no-console
    console.log(`\nReduction: ${lowered.renderNodes.length} → ${optimized.renderNodes.length} (${((1 - optimized.renderNodes.length/lowered.renderNodes.length)*100).toFixed(1)}%)`)
  })
})
