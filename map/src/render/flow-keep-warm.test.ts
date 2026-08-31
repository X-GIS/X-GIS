import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// The flow-layer keep-alive (#1333). IBFV is a RECURSIVE filter: this frame's image is the next
// frame's history, so it advances ONLY on rendered frames. An on-demand loop that idles does not
// pause the animation — it stops it, and the trail sits frozen mid-flow until the user happens
// to interact again.
//
// This is one HALF of a two-gate obligation, and the halves fail DIFFERENTLY:
//   - keep-warm missing      -> the loop idles, so the advection never runs on a static camera
//   - advection step missing -> the loop is warm but nothing advects
// Arming one and not the other leaves a differently half-dead animation. The arrow drift paid
// for that lesson; the note on GraphicsManager.hasAnimatedGraphics records it.
//
// A structural test rather than a behavioural one: driving XGISMap.shouldRenderThisFrame needs a
// device, a camera and a canvas, and the thing worth pinning is that the gate EXISTS in the idle
// decision beside its siblings — which is exactly what a future refactor would silently drop.

const MAP_SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'map.ts'), 'utf8')

/** The idle decision's body — every `return true` in it is a keep-alive.
 *
 *  Anchored on the DEFINITION, not the first textual occurrence: `shouldRenderThisFrame` is
 *  mentioned in several comments and one callback far earlier in the file, and slicing from
 *  those would test a region that contains none of the gates — a vacuous pass waiting to
 *  happen. (It is how the first draft of this test failed.) */
function idleDecision(): string {
  const anchor = 'private shouldRenderThisFrame(): boolean {'
  const start = MAP_SRC.indexOf(anchor)
  expect(
    start,
    'the shouldRenderThisFrame DEFINITION must exist — the gate has nowhere to live without it',
  ).toBeGreaterThan(-1)
  // Bounded to the METHOD, not to a character budget. The budget was 4000 chars and it went
  // vacuous the moment the keep-alive list grew: #2122 added a sprite probe with the same
  // sibling-sized comment every other gate carries (+967 chars), and the flow gate — the very
  // thing this file exists to watch — fell OUT of the slice at offset 4269. The margin before
  // that was 608 chars, about seven comment lines, on a list that gains an entry per async
  // resource class (#1333 flow, #2116 glyphs, #2122 sprites). Same `indexOf('\n  }')` idiom as
  // raster-budget-1579.test.ts:76 and quality-flip-releases-drapers.test.ts:113 — a method's
  // own close is 2-space-indented under prettier, so nested blocks cannot end the slice early.
  const end = MAP_SRC.indexOf('\n  }', start)
  expect(
    end,
    'the shouldRenderThisFrame method must CLOSE — without its end the slice would swallow the file',
  ).toBeGreaterThan(start)
  return MAP_SRC.slice(start, end)
}

describe('flow-field keep-alive (#1333)', () => {
  it('THE KEEP-WARM GATE: the idle decision consults the flow field', () => {
    expect(idleDecision()).toContain('hasFlowField()')
  })

  it('sits beside its siblings, so the idle decision stays ONE list', () => {
    // If the flow gate drifted into a different method, a reader auditing "what keeps the loop
    // warm" would read a complete-looking list that is missing one.
    const body = idleDecision()
    for (const sibling of ['hasFadingTiles()', 'hasAnimatedGraphics()', 'hasPendingSourceWork()']) {
      expect(body, `${sibling} should share the idle decision with the flow gate`).toContain(
        sibling,
      )
    }
  })

  it('is OPTIONAL-CHAINED, so a map with no coverage renderer cannot throw in the loop', () => {
    // shouldRenderThisFrame runs every animation frame, including before any coverage source is
    // attached. A bare `this.coverageRenderer.hasFlowField()` would throw on frame 1 of every
    // map that never uses a coverage.
    expect(idleDecision()).toMatch(/coverageRenderer\?\.\s*hasFlowField\(\)/)
  })

  it('the two-gate lesson is recorded where the SECOND gate lives', () => {
    // The prose is the only thing telling a future reader that arming one gate is not enough.
    // If it is deleted, the next animated primitive repeats the arrow drift's mistake.
    const gm = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'graphics', 'graphics-manager.ts'),
      'utf8',
    )
    expect(gm).toContain('SECOND animation source')
    expect(gm).toMatch(/BOTH/)
  })
})
