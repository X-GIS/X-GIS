// ═══ #1580 leg E — missingIconNames was the uncapped icon twin ═══
//
// `IconStage` is a large class only ever driven through the full Map/
// label-pass integration (no test constructs it directly), so this gate
// follows the established source-text pattern for "does the guard exist at
// every call site" checks (mip-scope-invariant.test.ts, raster-budget-1579
// leg B) rather than standing up a full IconStage harness.
//
// With data-driven `icon-image` the name domain is feature data, not the
// sprite sheet — an unbounded corpus of misses grew `missingIconNames`
// forever. The text twin (`dispatchedLabelTexts`, text-stage-diagnostics.ts)
// was already capped at 256 for exactly this reason; `missingIconNames` was
// the sibling the #1368 sweep never reached.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('./icon-stage.ts', import.meta.url)), 'utf8')

describe('#1580 leg E — missingIconNames.add() is guarded at every call site', () => {
  it('both .add() sites are capped at 256, matching the text twin', () => {
    const addCalls = [...src.matchAll(/this\.missingIconNames\.add\(/g)]
    expect(
      addCalls.length,
      'both known call sites must still exist — a rename invalidates this gate',
    ).toBe(2)
    for (const m of addCalls) {
      // The guard must appear on the SAME line as the .add() call — this
      // repo's established style for this exact check (icon-stage.ts wraps
      // each `if (atlasLoaded) this.missingIconNames.add(...)` as one line).
      const lineStart = src.lastIndexOf('\n', m.index) + 1
      const lineEnd = src.indexOf('\n', m.index)
      const line = src.slice(lineStart, lineEnd)
      expect(line, `call site at offset ${m.index} must be capped`).toContain(
        'this.missingIconNames.size < 256',
      )
    }
  })

  it('CONTROL — dispatchedIconNames stays unguarded here: bounded by the atlas name set, not this cap', () => {
    // Correction on record (#1580): dispatchedIconNames is NOT unbounded —
    // its add() requires host.get(name) to succeed, so it is already bounded
    // by the atlas's own name set. Adding a redundant cap here would hide a
    // future regression in that reasoning rather than catch one.
    const addCalls = [...src.matchAll(/this\.dispatchedIconNames\.add\(/g)]
    expect(addCalls.length).toBeGreaterThan(0)
    for (const m of addCalls) {
      const lineStart = src.lastIndexOf('\n', m.index) + 1
      const lineEnd = src.indexOf('\n', m.index)
      const line = src.slice(lineStart, lineEnd)
      expect(line).not.toContain('.size < 256')
    }
  })
})
