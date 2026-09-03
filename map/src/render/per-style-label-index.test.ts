// #2309 — the per-style label index that replaced a full-map walk in the fill
// draw path.
//
// `recordFillDraw` matches a draw pipeline to its Material twin: identity first
// (`perStyle.get(pipeline)`), then a dual-instance LABEL fallback. The fallback
// used to walk the whole `perStyle` map. Measured on OFM Bright z14.7: identity
// missed on 48 of 52 draws, each miss then walked all 160 entries and matched
// NOTHING — 698 iterations a frame that cannot succeed, growing with style count
// (`registerFillMaterials` adds 4 entries per shader variant).
//
// The walk it replaces was, verbatim:
//
//     for (const [k, v] of eff.perStyle) {
//       if (pipeline === k || (!!pipeline.label && !!k && pipeline.label === k.label)) {
//         ps = v
//         break
//       }
//     }
//
// run ONLY after `perStyle.get(pipeline)` had already missed — so the identity
// arm could never fire and the walk was purely "the first entry whose label
// matches". These tests hold the index to exactly that, including the two edge
// cases the naive `Map<string, entry>` gets wrong.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Material, RhiPipelineHandle } from '@xgis/engine'
import {
  indexPerStyleByLabel,
  type PerStyleLabelOwner,
  type PerStyleTwin,
} from './material/per-style-label-index'

const HERE = dirname(fileURLToPath(import.meta.url))

/** A stand-in twin — nothing here touches the Material, only its identity. */
function twin(variant: number): PerStyleTwin {
  return { mat: { id: `mat-${variant}` } as unknown as Material, variant }
}
function pipe(label: string): RhiPipelineHandle {
  return { label }
}

/** The walk the index replaces, kept here as the reference implementation the
 *  differential test compares against. Mirrors the call site: identity `get`
 *  first, then the label walk. */
function walkLookup(
  map: Map<RhiPipelineHandle, PerStyleTwin>,
  pipeline: RhiPipelineHandle,
): PerStyleTwin | undefined {
  const hit = map.get(pipeline)
  if (hit) return hit
  if (!pipeline.label) return undefined
  for (const [k, v] of map) {
    if (pipeline === k || (!!pipeline.label && !!k && pipeline.label === k.label)) return v
  }
  return undefined
}

/** The shipped lookup, spelled exactly as `recordFillDraw` spells it. */
function indexLookup(
  map: Map<RhiPipelineHandle, PerStyleTwin>,
  byLabel: Map<string, PerStyleLabelOwner>,
  pipeline: RhiPipelineHandle,
): PerStyleTwin | undefined {
  return map.get(pipeline) ?? (pipeline.label ? byLabel.get(pipeline.label)?.entry : undefined)
}

/** Build a map + its index through the single write path, as the factory does. */
function build(entries: [RhiPipelineHandle, PerStyleTwin][]): {
  map: Map<RhiPipelineHandle, PerStyleTwin>
  byLabel: Map<string, PerStyleLabelOwner>
} {
  const map = new Map<RhiPipelineHandle, PerStyleTwin>()
  const byLabel = new Map<string, PerStyleLabelOwner>()
  for (const [k, v] of entries) {
    map.set(k, v)
    indexPerStyleByLabel(byLabel, k, v)
  }
  return { map, byLabel }
}

describe('indexPerStyleByLabel — the walk it replaces, exactly (#2309)', () => {
  it('first registration wins, mirroring the walk`s `break` on the first match', () => {
    // Two DISTINCT pipeline objects sharing a label. The walk returned the
    // first one it reached; a plain last-writer-wins index would return the
    // second, silently swapping the Material twin under a dual-instance draw.
    const first = pipe('fill-pipeline')
    const second = pipe('fill-pipeline')
    const { byLabel } = build([
      [first, twin(0)],
      [second, twin(1)],
    ])
    expect(byLabel.get('fill-pipeline')?.entry.variant).toBe(0)
    expect(byLabel.get('fill-pipeline')?.key).toBe(first)
  })

  it('a re-write of the OWNING key updates the value', () => {
    // Live case, not defensive: the no-pick pipelines ARE the pickable ones when
    // picking is off, so `registerFillMaterials` re-sets an existing key
    // (pipeline-factory.ts documents that .set as idempotent). If the index
    // refused to re-point, it would serve a Material the map no longer holds.
    const key = pipe('fill-pipeline-extruded')
    const byLabel = new Map<string, PerStyleLabelOwner>()
    indexPerStyleByLabel(byLabel, key, twin(0))
    indexPerStyleByLabel(byLabel, key, twin(1))
    expect(byLabel.get('fill-pipeline-extruded')?.entry.variant).toBe(1)
  })

  it('an empty label is never indexed, matching the walk`s `!!pipeline.label` guard', () => {
    const byLabel = new Map<string, PerStyleLabelOwner>()
    indexPerStyleByLabel(byLabel, pipe(''), twin(0))
    expect(byLabel.size).toBe(0)
  })

  it('agrees with the walk on EVERY probe, over a map shaped like the real one', () => {
    // The factory registers 4 entries per shader variant, all variant-distinct
    // labels, plus the no-pick quartet that re-uses two of them. 160 entries was
    // the measured size on OFM Bright; 12 variants reproduces the shape.
    const entries: [RhiPipelineHandle, PerStyleTwin][] = []
    const probes: RhiPipelineHandle[] = []
    for (let v = 0; v < 12; v++) {
      for (const suffix of ['', '-fallback', '-ground', '-ground-fallback']) {
        const k = pipe(`fill-pipeline-v${v}${suffix}`)
        entries.push([k, twin(v)])
        probes.push(k) // identity probe — must hit the map, never the index
        probes.push(pipe(`fill-pipeline-v${v}${suffix}`)) // twin-instance probe
      }
    }
    // Duplicate-label pair and an empty-label pipeline, the two shapes where a
    // naive index diverges.
    const dupFirst = pipe('shared-label')
    const dupSecond = pipe('shared-label')
    entries.push([dupFirst, twin(90)], [dupSecond, twin(91)])
    probes.push(dupFirst, dupSecond, pipe('shared-label'), pipe(''), pipe('absent-label'))

    const { map, byLabel } = build(entries)
    expect(map.size).toBe(50)
    for (const p of probes) {
      expect(indexLookup(map, byLabel, p), `probe ${p.label || '<empty>'}`).toBe(walkLookup(map, p))
    }
  })
})

describe('the label index cannot drift from its map (#2309)', () => {
  const FACTORY = readFileSync(join(HERE, 'pipeline-factory.ts'), 'utf8')
  const MATERIAL = readFileSync(join(HERE, 'material/polygon-fill-material.ts'), 'utf8')

  it('every write to either per-style map goes through the indexing setter', () => {
    // The index is write-through, not derived-and-invalidated: `size` cannot
    // detect a re-set of an existing key (#2165). That only holds if no caller
    // reaches the raw map. `setPerStyle` / `setPerStyleExtrude` are the two
    // permitted `.set` bodies; everything else must call them.
    const raw = [...FACTORY.matchAll(/this\._fillPerStyle(?:Extrude)?\.set\(/g)]
    expect(raw.length, 'raw .set sites (only the two setter bodies may have one)').toBe(2)
    for (const name of ['setPerStyle', 'setPerStyleExtrude']) {
      const at = FACTORY.indexOf(`private ${name}(`)
      expect(at, `${name} must exist`).toBeGreaterThan(-1)
      const body = FACTORY.slice(at, FACTORY.indexOf('\n  }', at))
      expect(body, `${name} must index`).toContain('indexPerStyleByLabel(')
    }
    // Non-vacuity: the call sites that used to hold the raw `.set` still exist.
    expect([...FACTORY.matchAll(/this\.setPerStyle\(/g)].length).toBe(8)
    expect([...FACTORY.matchAll(/this\.setPerStyleExtrude\(/g)].length).toBe(4)
  })

  it('clearing the maps clears the indexes in the same authority', () => {
    const at = FACTORY.indexOf('this._fillPerStyle.clear()')
    expect(at, 'the clear site must exist').toBeGreaterThan(-1)
    const block = FACTORY.slice(at, at + 400)
    expect(block).toContain('this._fillPerStyleExtrude.clear()')
    expect(block).toContain('this._fillPerStyleByLabel.clear()')
    expect(block).toContain('this._fillPerStyleExtrudeByLabel.clear()')
  })

  it('the draw path no longer walks either per-style map', () => {
    expect(MATERIAL).not.toMatch(/for \(const \[k, v\] of eff\.perStyle/)
    // Non-vacuity: the lookups that replaced the walks are there.
    expect(MATERIAL).toContain('eff.perStyleByLabel?.get(pipeline.label)?.entry')
    expect(MATERIAL).toContain('eff.perStyleExtrudeByLabel?.get(pipeline.label)?.entry')
  })
})
