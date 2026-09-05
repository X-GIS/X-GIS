// A layer-type row must not justify its status with PROPERTY statuses (#2489).
//
// `symbol (icon-only)` sat at `partial` citing five reasons. Four had shipped
// (`icon-text-fit`, `icon-text-fit-padding`, `icon-padding`, `icon-keep-upright`
// all `supported`), the halo claim was wrong in both directions at once (text
// halo shipped; icon halo is `na`, so "deferred" describes a thing that will
// never be built), and the one live item — `icon-pitch-alignment` — already
// carries its own `unsupported` row. The layer-type row was counting it twice.
//
// WHY A TEST AND NOT JUST A FIXED NOTE. Nothing in CI could see this:
// `spec-coverage-drift.test.ts` matches row PRESENCE, not status correctness, so
// a note may rot for as long as nobody reads it. The mechanism that rotted is
// general — a layer-type note enumerating property statuses that then move
// underneath it — so the guard is against the mechanism, not this instance.
//
// The convention this pins is the one `layer-types.ts` already follows
// elsewhere: a LAYER-TYPE row describes ROUTING (does a layer of this type reach
// a renderer), and PROPERTY rows describe properties. `symbol (text)` and
// `circle` are both `supported` and neither enumerates its properties' gaps.
//
// NOTE the section id is `layers`, not the file name `layer-types`. The first
// draft of this file used the file name, so every lookup missed — and the guard
// below PASSED, having scanned an empty list. It was caught only because the
// row assertion failed loudly beside it. Hence the population assertion in the
// guard: a gate that does not prove its own population is the bug it guards
// against, one level up (#1625).

import { describe, it, expect } from 'vitest'
import { flattenCoverageBySection } from '../spec-coverage'

/** The section id for `layer-types.ts` — `layers`, NOT the file name. */
const LAYER_TYPES = 'layers'

/** `flattenCoverageBySection()` returns a FLAT `{ section, entry }[]`; group it
 *  so a row can be found by (section, name) — `resampling` exists in two
 *  sections, so a by-name lookup alone is the ambiguity #2216 already paid for. */
function rowsBySection(): Map<string, { name: string; status: string; note?: string }[]> {
  const out = new Map<string, { name: string; status: string; note?: string }[]>()
  for (const { section, entry } of flattenCoverageBySection()) {
    const list = out.get(section) ?? []
    list.push({ name: entry.name, status: entry.status, note: entry.note })
    out.set(section, list)
  }
  return out
}

describe('#2489 — symbol (icon-only) describes ROUTING, and the routing works', () => {
  it('the row is supported', () => {
    const rows = rowsBySection().get(LAYER_TYPES) ?? []
    const row = rows.find((r) => r.name === 'symbol (icon-only)')
    expect(row, 'the symbol (icon-only) row must exist').toBeDefined()
    // fail-before: 'partial', justified by four shipped properties, an `na` one,
    // and one that has its own row.
    expect(row!.status).toBe('supported')
  })

  // THE CONTROL, and for a record-correction it is the whole assertion. Nothing
  // in CI can see a status that is merely WRONG, so without this the change is
  // indistinguishable from one that flipped the property gaps too — which is the
  // actual risk of editing coverage rows.
  it('icon-pitch-alignment is STILL unsupported — the gap moved rows, it did not close', () => {
    const rows = rowsBySection().get('layout-symbol') ?? []
    const row = rows.find((r) => r.name === 'icon-pitch-alignment')
    expect(row, 'icon-pitch-alignment must still have its own row').toBeDefined()
    expect(row!.status).toBe('unsupported')
  })

  it('the four properties the old note called deferred really did ship', () => {
    // If any of these regressed, the old note would become true again and this
    // correction would be the wrong call — so they are asserted, not assumed.
    const rows = rowsBySection().get('layout-symbol') ?? []
    for (const name of [
      'icon-text-fit',
      'icon-text-fit-padding',
      'icon-padding',
      'icon-keep-upright',
    ]) {
      const row = rows.find((r) => r.name === name)
      expect(row, `${name} row must exist`).toBeDefined()
      expect(row!.status, `${name} was cited as deferred; it is supported`).toBe('supported')
    }
  })
})

// The GUARD, against the mechanism rather than this instance.
describe('#2489 — a layer-type note must not enumerate property statuses', () => {
  it('no layer-types note names a property whose own row disagrees with it', () => {
    const bySection = rowsBySection()
    const layerTypes = bySection.get(LAYER_TYPES) ?? []
    // Prove the population before scanning it — see the section-id note above.
    expect(layerTypes.length, `no rows under section "${LAYER_TYPES}"`).toBeGreaterThan(5)

    // Property names that own a row elsewhere. HYPHENATED ONLY: a row is also
    // named `name`, `has`, `pitch`, `coalesce`, and matching those against prose
    // is how the first draft of this guard produced ten false positives. Every
    // real Mapbox layout/paint property is hyphenated, so the filter costs
    // nothing and buys the whole difference between a gate and noise.
    const propertyStatus = new Map<string, string>()
    for (const [section, rows] of bySection) {
      if (section === LAYER_TYPES) continue
      for (const r of rows) {
        if (!r.name.includes('-')) continue
        if (!propertyStatus.has(r.name)) propertyStatus.set(r.name, r.status)
      }
    }
    expect(propertyStatus.size, 'no hyphenated property rows to scan against').toBeGreaterThan(50)

    const DEFERRAL = /deferred|not yet|pending|remainder|still partial/i

    const offenders: string[] = []
    for (const row of layerTypes) {
      if (!row.note) continue
      // Scope to the DEFERRAL SENTENCE, not the whole note. A note legitimately
      // names properties it DOES carry (`icon-image`, `text-field` in this very
      // row); the rot is specifically "X is deferred" outliving X shipping, and
      // only the sentence carrying the deferral can express that.
      for (const sentence of row.note.split(/(?<=[.;])\s+/)) {
        if (!DEFERRAL.test(sentence)) continue
        for (const [prop, status] of propertyStatus) {
          // Word boundary on both ends so `icon-padding` does not match inside
          // `icon-padding-foo`, and a prefix like `icon-text-fit` does not fire
          // on `icon-text-fit-padding`.
          if (!new RegExp(`(^|[^\\w-])${prop}([^\\w-]|$)`).test(sentence)) continue
          if (status === 'supported' || status === 'na') {
            offenders.push(
              `layer-types "${row.name}" defers "${prop}", but that property's own row ` +
                `is "${status}" — the note outlived the gap:\n    "${sentence.trim()}"`,
            )
          }
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })
})
