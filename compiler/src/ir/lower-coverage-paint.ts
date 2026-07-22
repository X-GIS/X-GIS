// ═══ Coverage paint from a `style:` preset (#1272 E-②) ═══
//
// A `preset` may carry coverage portrayal (`ramp:`/`range:`), so a layer applies the
// official S-111 speed palette via one `style:` reference. This resolves a coverage
// layer's FINAL ramp/range: the layer's OWN paint always wins; the referenced preset fills
// only what the layer left unset. Extracted from `lowerLayer` to keep lower.ts off its
// god-file ceiling (CLAUDE.md §12).

import type * as AST from '../parser/ast'

export interface CoveragePaint {
  ramp?: string
  range?: readonly [number, number]
}

/** Merge a `style:`-referenced preset's coverage paint under the layer's own. `presetName`
 *  is the `style:` target ('' when the layer has none); `presetProps` is that preset's block
 *  properties (undefined when the name resolves to no preset). A malformed `range:` in the
 *  preset fails LOUDLY, naming the preset + the layer that pulled it in. */
export function resolveCoveragePaint(
  presetName: string,
  presetProps: readonly AST.BlockProperty[] | undefined,
  own: CoveragePaint,
  layerName: string,
): CoveragePaint {
  let { ramp, range } = own
  if (!presetProps || (ramp !== undefined && range !== undefined)) return { ramp, range }
  for (const prop of presetProps) {
    if (ramp === undefined && prop.name === 'ramp' && prop.value.kind === 'StringLiteral') {
      ramp = prop.value.value
    } else if (range === undefined && prop.name === 'range') {
      const els = prop.value.kind === 'ArrayLiteral' ? prop.value.elements : null
      if (
        !els ||
        els.length !== 2 ||
        els[0]!.kind !== 'NumberLiteral' ||
        els[1]!.kind !== 'NumberLiteral'
      ) {
        throw new Error(
          `preset "${presetName}" (referenced by layer "${layerName}"): 'range' must be a ` +
            `two-number array (e.g. \`range: [0, 40]\`).`,
        )
      }
      range = [els[0].value, els[1].value]
    }
  }
  return { ramp, range }
}
