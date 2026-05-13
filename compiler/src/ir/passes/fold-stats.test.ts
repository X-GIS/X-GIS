// Diagnostic: count how many trivial-stops fold on real-world styles.
// Helps gauge integration risk — if the fold rarely fires, downstream
// kind-branching can't cause much divergence.

import { describe, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Lexer } from '../../lexer/lexer'
import { Parser } from '../../parser/parser'
import { lower } from '../lower'
import { optimize } from '../optimize'
import { convertMapboxStyle } from '../../convert/mapbox-to-xgis'
import { foldTrivialStopsPass } from './fold-trivial-stops'
import type { Scene } from '../render-node'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIX = join(HERE, '..', '..', '__tests__', 'fixtures')

function compileFixture(path: string): Scene {
  const json = JSON.parse(readFileSync(path, 'utf8'))
  const xgis = convertMapboxStyle(json, { warn: () => {} })
  const tokens = new Lexer(xgis).tokenize()
  const program = new Parser(tokens).parse()
  return optimize(lower(program), program)
}

function countFolds(before: Scene, after: Scene): {
  total: number
  perSlot: Record<string, number>
  examples: string[]
} {
  let total = 0
  const perSlot: Record<string, number> = {}
  const examples: string[] = []
  for (let i = 0; i < before.renderNodes.length; i++) {
    const b = before.renderNodes[i]!
    const a = after.renderNodes[i]!
    const layerLabel = b.name ?? `node[${i}]`
    if (a.fill !== b.fill) { total++; perSlot.fill = (perSlot.fill ?? 0) + 1; if (examples.length < 5) examples.push(`${layerLabel}: fill`) }
    if (a.stroke.color !== b.stroke.color) { total++; perSlot.strokeColor = (perSlot.strokeColor ?? 0) + 1; if (examples.length < 5) examples.push(`${layerLabel}: strokeColor`) }
    if (a.stroke.width !== b.stroke.width) { total++; perSlot.strokeWidth = (perSlot.strokeWidth ?? 0) + 1; if (examples.length < 5) examples.push(`${layerLabel}: strokeWidth`) }
    if (a.opacity !== b.opacity) { total++; perSlot.opacity = (perSlot.opacity ?? 0) + 1; if (examples.length < 5) examples.push(`${layerLabel}: opacity`) }
    if (a.size !== b.size) { total++; perSlot.size = (perSlot.size ?? 0) + 1; if (examples.length < 5) examples.push(`${layerLabel}: size`) }
  }
  return { total, perSlot, examples }
}

describe('fold-trivial-stops — fixture statistics', () => {
  for (const fixture of ['openfreemap-bright.json', 'openfreemap-liberty.json', 'openfreemap-positron.json']) {
    it(`reports fold counts on ${fixture}`, () => {
      const before = compileFixture(join(FIX, fixture))
      const after = foldTrivialStopsPass.run(before)
      const stats = countFolds(before, after)
      // eslint-disable-next-line no-console
      console.log(`[${fixture}] folds: ${stats.total}, per slot: ${JSON.stringify(stats.perSlot)}, examples: ${stats.examples.join(' | ')}`)
    })
  }
})
