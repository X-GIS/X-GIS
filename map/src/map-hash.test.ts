import { describe, expect, it } from 'vitest'
import { formatHash, parseHash, updateHashFragment } from './map-hash'

// #1268 — URL hash camera sync. Pure format/parse/merge; the boot-seed +
// move-end write lifecycle lives in map.ts (driven by these helpers).

describe('formatHash', () => {
  it('emits zoom/lat/lon and OMITS a zero bearing + pitch', () => {
    expect(formatHash({ zoom: 5, lat: 37.5, lon: 127, bearing: 0, pitch: 0 })).toBe('5/37.5/127')
  })

  it('appends bearing when non-zero, pitch only when non-zero', () => {
    expect(formatHash({ zoom: 5, lat: 0, lon: 0, bearing: 30, pitch: 0 })).toBe('5/0/0/30')
    expect(formatHash({ zoom: 5, lat: 0, lon: 0, bearing: 30, pitch: 60 })).toBe('5/0/0/30/60')
  })

  it('keeps the bearing slot when pitch is set even if bearing is 0', () => {
    expect(formatHash({ zoom: 5, lat: 0, lon: 0, bearing: 0, pitch: 60 })).toBe('5/0/0/0/60')
  })

  it('rounds zoom to 2 dp and scales lat/lon precision with zoom (short low-zoom links)', () => {
    const low = formatHash({ zoom: 1, lat: 37.123456789, lon: 127.123456789, bearing: 0, pitch: 0 })
    const high = formatHash({
      zoom: 18,
      lat: 37.123456789,
      lon: 127.123456789,
      bearing: 0,
      pitch: 0,
    })
    const lowLat = low.split('/')[1]!
    const highLat = high.split('/')[1]!
    expect(lowLat.split('.')[1]!.length).toBeLessThan(highLat.split('.')[1]!.length)
    expect(formatHash({ zoom: 5.678, lat: 0, lon: 0, bearing: 0, pitch: 0 })).toBe('5.68/0/0')
  })
})

describe('parseHash', () => {
  it('parses a 3-component fragment (with or without the #)', () => {
    expect(parseHash('#5/37.5/127', '')).toEqual({
      zoom: 5,
      lat: 37.5,
      lon: 127,
      bearing: 0,
      pitch: 0,
    })
    expect(parseHash('5/37.5/127', '')).toEqual({
      zoom: 5,
      lat: 37.5,
      lon: 127,
      bearing: 0,
      pitch: 0,
    })
  })

  it('parses bearing + pitch when present', () => {
    expect(parseHash('#5/0/0/30/60', '')).toEqual({
      zoom: 5,
      lat: 0,
      lon: 0,
      bearing: 30,
      pitch: 60,
    })
  })

  it('returns null for a foreign / empty / malformed fragment (never throws)', () => {
    expect(parseHash('', '')).toBeNull()
    expect(parseHash('#', '')).toBeNull()
    expect(parseHash('#foo=bar', '')).toBeNull()
    expect(parseHash('#5/37.5', '')).toBeNull() // too few
    expect(parseHash('#5/37.5/127/0/0/9', '')).toBeNull() // too many
    expect(parseHash('#a/b/c', '')).toBeNull() // non-numeric
  })

  it('rejects out-of-range lat/lon so a non-ours fragment cannot drive the camera wild', () => {
    expect(parseHash('#5/200/0', '')).toBeNull()
    expect(parseHash('#5/0/999', '')).toBeNull()
  })

  it('reads only the namespaced segment (among &-joined params)', () => {
    expect(parseHash('#map=5/37.5/127', 'map')).toEqual({
      zoom: 5,
      lat: 37.5,
      lon: 127,
      bearing: 0,
      pitch: 0,
    })
    expect(parseHash('#other=1/2/3&map=5/37.5/127', 'map')).toEqual({
      zoom: 5,
      lat: 37.5,
      lon: 127,
      bearing: 0,
      pitch: 0,
    })
    expect(parseHash('#other=1/2/3', 'map')).toBeNull() // our ns absent
  })
})

describe('round-trip is sub-pixel-exact', () => {
  it('parse(format(cam)) recovers the camera within the zoom-scaled precision', () => {
    for (const zoom of [0, 4, 10, 16, 22]) {
      const cam = { zoom, lat: 37.5665123, lon: 126.9779876, bearing: 45, pitch: 30 }
      const back = parseHash(`#${formatHash(cam)}`, '')!
      expect(back).not.toBeNull()
      // deg/pixel = 360/(512·2^zoom); the recovered center must be within a pixel.
      const tol = 360 / (512 * Math.pow(2, zoom))
      expect(Math.abs(back.lat - cam.lat)).toBeLessThan(tol)
      expect(Math.abs(back.lon - cam.lon)).toBeLessThan(tol)
      expect(back.zoom).toBe(zoom)
    }
  })
})

describe('updateHashFragment', () => {
  it('unnamespaced OWNS the whole fragment', () => {
    expect(updateHashFragment('#anything=here', '', '5/0/0')).toBe('5/0/0')
  })

  it('namespaced replaces its own segment and preserves siblings', () => {
    // A fresh fragment.
    expect(updateHashFragment('', 'map', '5/0/0')).toBe('map=5/0/0')
    // A sibling namespace (distinct maps don't fight).
    expect(updateHashFragment('#other=1/2/3', 'map', '5/0/0')).toBe('other=1/2/3&map=5/0/0')
    // Re-writing our own ns replaces, doesn't duplicate.
    expect(updateHashFragment('#map=1/2/3&other=9/9/9', 'map', '5/0/0')).toBe(
      'other=9/9/9&map=5/0/0',
    )
  })

  it('two namespaced maps writing in sequence both survive', () => {
    let frag = ''
    frag = updateHashFragment(`#${frag}`, 'a', '5/0/0')
    frag = updateHashFragment(`#${frag}`, 'b', '9/1/1')
    expect(parseHash(`#${frag}`, 'a')).toMatchObject({ zoom: 5 })
    expect(parseHash(`#${frag}`, 'b')).toMatchObject({ zoom: 9 })
  })
})
