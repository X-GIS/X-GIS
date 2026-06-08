import { describe, expect, it } from 'vitest'
import { XGISMap } from './map'
import { DirtyDomain, type DirtyTracker } from './state/dirty'

// ═══ S14 — granular dirty tagging (INERT) ══════════════════════════
//
// PINS the per-domain bits the raw `_needsRender = true` bypass sites now
// tag on the map's `_dirty` tracker, converted to route through the private
// `_markDirty(domains)` helper. These are NOT render-behaviour tests — at S14
// `shouldRenderThisFrame()` still reads `_needsRender`, never `_dirty`, so
// output is byte-identical. They lock the TAGGING contract the S16 label-skip
// consumer will read: text overlays tag LABEL and nothing else; `_markDirty`
// also re-arms `_needsRender` so the next frame still draws (inertness).
//
// Device-free: overlay add/remove and the helper touch no GPU state, so this
// runs synchronously like the render-path characterization spec.

function mockCanvas(width = 1200, height = 800): HTMLCanvasElement {
  return { width, height } as unknown as HTMLCanvasElement
}

/** Private seam: the `_dirty` tracker + `_needsRender` flag are private; the
 *  characterization specs establish this single-cast access pattern. */
interface DirtySeam {
  _dirty: DirtyTracker
  _needsRender: boolean
}
function seam(map: XGISMap): DirtySeam {
  return map as unknown as DirtySeam
}

/** Clear both the bitset and the render flag so a single edit's effect is
 *  isolated (a fresh map starts DIRTY_ALL + _needsRender=true). */
function clean(map: XGISMap): DirtySeam {
  const s = seam(map)
  s._dirty.clear()
  s._needsRender = false
  return s
}

describe('S14 granular dirty tagging — text overlays tag LABEL only', () => {
  it('addOverlay tags LABEL and re-arms _needsRender, nothing else', () => {
    const map = new XGISMap(mockCanvas())
    const s = clean(map)
    map.addOverlay({ text: 'hello', anchor: [0, 0] })
    expect(s._dirty.peek(DirtyDomain.LABEL)).toBe(true)
    expect(s._needsRender).toBe(true)
    // Granular: the camera/source/projection domains stay clean.
    expect(s._dirty.peek(DirtyDomain.CAMERA)).toBe(false)
    expect(s._dirty.peek(DirtyDomain.SOURCE)).toBe(false)
    expect(s._dirty.peek(DirtyDomain.PROJECTION)).toBe(false)
    expect(s._dirty.peek(DirtyDomain.STYLE)).toBe(false)
  })

  it('overlay handle.remove() tags LABEL', () => {
    const map = new XGISMap(mockCanvas())
    const handle = map.addOverlay({ text: 'x', anchor: [10, 20] })
    const s = clean(map)
    handle.remove()
    expect(s._dirty.peek(DirtyDomain.LABEL)).toBe(true)
    expect(s._needsRender).toBe(true)
    expect(s._dirty.peek(DirtyDomain.CAMERA)).toBe(false)
  })

  it('clearOverlays() tags LABEL when overlays exist', () => {
    const map = new XGISMap(mockCanvas())
    map.addOverlay({ text: 'a', anchor: [0, 0] })
    const s = clean(map)
    map.clearOverlays()
    expect(s._dirty.peek(DirtyDomain.LABEL)).toBe(true)
    expect(s._needsRender).toBe(true)
  })

  it('clearOverlays() on an empty map is a no-op (no tag, no render)', () => {
    // PIN: the early `length === 0` return runs BEFORE _markDirty, so an
    // empty clear neither dirties LABEL nor re-arms the frame.
    const map = new XGISMap(mockCanvas())
    const s = clean(map)
    map.clearOverlays()
    expect(s._dirty.peek(DirtyDomain.LABEL)).toBe(false)
    expect(s._needsRender).toBe(false)
  })
})

describe('S16 consumer skip — consumeLabelDirty() read-and-clear', () => {
  it('returns true while LABEL is dirty, then clears it (next call false)', () => {
    // PIN: the label pass calls this once per frame; the read-and-clear is
    // what lets a clean next frame skip re-collision. A fresh map starts
    // DIRTY_ALL, so the first consume sees LABEL set.
    const map = new XGISMap(mockCanvas())
    expect(map.consumeLabelDirty()).toBe(true)
    expect(map.consumeLabelDirty()).toBe(false)
  })

  it('an overlay edit between frames re-tags LABEL → next consume is true', () => {
    // PIN: the skip is correct only if edits re-dirty LABEL after a consume.
    const map = new XGISMap(mockCanvas())
    map.consumeLabelDirty() // drain the construction-time DIRTY_ALL
    expect(map.consumeLabelDirty()).toBe(false)
    map.addOverlay({ text: 'x', anchor: [0, 0] })
    expect(map.consumeLabelDirty()).toBe(true)
    expect(map.consumeLabelDirty()).toBe(false)
  })

  it('consumeLabelDirty() clears ONLY the LABEL domain', () => {
    // PIN: it must not steal other domains (e.g. STYLE) that other future
    // consumers own. invalidate() tags ALL; consuming LABEL leaves the rest.
    const map = new XGISMap(mockCanvas())
    const s = seam(map)
    s._dirty.clear()
    map.invalidate() // tags DIRTY_ALL
    expect(map.consumeLabelDirty()).toBe(true)
    expect(s._dirty.peek(DirtyDomain.LABEL)).toBe(false)
    expect(s._dirty.peek(DirtyDomain.STYLE)).toBe(true)
    expect(s._dirty.peek(DirtyDomain.CAMERA)).toBe(true)
  })
})
