// Pin `colorToXgis` hex-shape validation. Pre-fix any string starting
// with `#` passed through verbatim — `#zzz` / `#12345` landed in the
// emitted xgis verbatim, runtime parseHexColor regex-gated it and the
// layer silently rendered black with no compile-time warning.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('hex colour validation at convert time', () => {
  it('valid #rrggbb passes through (regression guard)', () => {
    const style = {
      version: 8,
      sources: {},
      layers: [
        { id: 'l', type: 'background', paint: { 'background-color': '#abcdef' } },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('#abcdef')
  })

  it('valid #rgb passes through (short form)', () => {
    const style = {
      version: 8,
      sources: {},
      layers: [
        { id: 'l', type: 'background', paint: { 'background-color': '#abc' } },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('#abc')
  })

  it('valid #rrggbbaa passes through (alpha form)', () => {
    const style = {
      version: 8,
      sources: {},
      layers: [
        { id: 'l', type: 'background', paint: { 'background-color': '#abcdef80' } },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('#abcdef80')
  })

  it('malformed #zzz drops from emitted background block (was silently black)', () => {
    const style = {
      version: 8,
      sources: {},
      layers: [
        { id: 'l', type: 'background', paint: { 'background-color': '#zzz' } },
      ],
    }
    const code = convertMapboxStyle(style as never)
    // Warning comment may mention the original; the BACKGROUND BLOCK
    // (or any fill directive) must not carry the bogus value.
    expect(code).not.toMatch(/background\s*\{[^}]*#zzz/)
    expect(code).not.toMatch(/fill\s*:?\s*#zzz/)
    expect(code).toMatch(/looks like a hex literal/)
  })

  it('malformed #12345 (5-char) drops from emitted block', () => {
    const style = {
      version: 8,
      sources: {},
      layers: [
        { id: 'l', type: 'background', paint: { 'background-color': '#12345' } },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/background\s*\{[^}]*#12345/)
    expect(code).not.toMatch(/fill\s*:?\s*#12345/)
    expect(code).toMatch(/looks like a hex literal/)
  })

  it('uppercase hex lowercases on emit', () => {
    const style = {
      version: 8,
      sources: {},
      layers: [
        { id: 'l', type: 'background', paint: { 'background-color': '#ABCDEF' } },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('#abcdef')
    expect(code).not.toContain('#ABCDEF')
  })
})
