// Diagnostic: count how many RenderNodes get eliminated on real
// styles. Mirror of fold-stats — gives us a confidence signal
// before wiring deadLayerElimPass into optimize().

import { describe, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Lexer } from '../../lexer/lexer'
import { Parser } from '../../parser/parser'
import { lower } from '../lower'
import { optimize } from '../optimize'
import { convertMapboxStyle } from '../../convert/mapbox-to-xgis'
import { deadLayerElimPass } from './dead-layer-elim'
import type { Scene } from '../render-node'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIX = join(HERE, '..', '..', '__tests__', 'fixtures')

function compileFixture(path: string): Scene {
  const json = JSON.parse(readFileSync(path, 'utf8'))
  const xgis = convertMapboxStyle(json)
  const tokens = new Lexer(xgis).tokenize()
  const program = new Parser(tokens).parse()
  return optimize(lower(program), program)
}

describe('dead-layer-elim — fixture statistics', () => {
  for (const fixture of ['openfreemap-bright.json', 'openfreemap-liberty.json', 'openfreemap-positron.json']) {
    it(`reports drop counts on ${fixture}`, () => {
      const before = compileFixture(join(FIX, fixture))
      const after = deadLayerElimPass.run(before)
      const dropped = before.renderNodes.length - after.renderNodes.length
      const droppedNames: string[] = []
      const liveNames = new Set(after.renderNodes.map(n => n.name))
      for (const n of before.renderNodes) {
        if (!liveNames.has(n.name) && droppedNames.length < 10) {
          droppedNames.push(n.name)
        }
      }
      // eslint-disable-next-line no-console
      console.log(`[${fixture}] ${before.renderNodes.length} → ${after.renderNodes.length} (dropped ${dropped}). examples: ${droppedNames.join(', ')}`)
    })
  }
})
