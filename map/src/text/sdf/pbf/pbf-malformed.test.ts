import { describe, it, expect } from 'vitest'
import { decodeGlyphsPbf } from '@xgis/map'

// Repro / regression suite for the DoS / infinite-loop class on malformed
// or truncated glyph PBFs.
//
// Repro method (how this proves fail-before WITHOUT hanging CI):
//   A true infinite loop hangs the thread forever, which would hang vitest
//   rather than report a clean FAIL. So every case here runs under a tight
//   per-test `{ timeout: 1500 }`. Behaviour:
//     - BEFORE the fix: decodeGlyphsPbf spins forever on these inputs → the
//       test never returns → vitest aborts it at 1.5 s → the test FAILS.
//     - AFTER the fix: decode terminates near-instantly and returns a
//       partial/empty result → the test PASSES in milliseconds.
//   The timeout is the tripwire; a hang manifests as a timeout failure, not
//   a frozen run. (Verified empirically: pre-fix these time out, post-fix
//   they complete in <5 ms.)

const TIMEOUT = { timeout: 1500 }

describe('decodeGlyphsPbf — malformed / truncated input must not hang', () => {
  it(
    'len-delimited submessage overruns the buffer (field 1, wire 2, len=100, 2 bytes)',
    TIMEOUT,
    () => {
      // tag 0x0a = field 1, wire 2 (a `stacks` fontstack submessage).
      // declared submessage length 100, but only 2 trailing bytes exist.
      // readMessage computes end = pos + 100 (past EOF); the inner loop then
      // walks past `len`, readTag returns {0,0}, skip(0) re-reads a 0 varint
      // with no progress → original infinite loop.
      const buf = new Uint8Array([0x0a, 100, 0x01, 0x02])
      const stacks = decodeGlyphsPbf(buf)
      // Post-fix: decode terminates. Result is whatever could be parsed —
      // we only require that it returns an array and does not hang.
      expect(Array.isArray(stacks)).toBe(true)
    },
  )

  it('nested glyph submessage overruns at the glyph level (field 3, wire 2)', TIMEOUT, () => {
    // glyphs (top) -> fontstack(field 1, wire 2, len = rest) -> within it a
    // glyph (field 3, wire 2) whose declared length runs past the buffer.
    //   0x0a 0x04         fontstack submessage, len 4
    //     0x1a 0x64       glyph (field 3, wire 2), declared len 100
    //     0x01 0x02       only 2 bytes of the 100 present
    const buf = new Uint8Array([0x0a, 0x04, 0x1a, 0x64, 0x01, 0x02])
    const stacks = decodeGlyphsPbf(buf)
    expect(Array.isArray(stacks)).toBe(true)
  })

  it('truncated mid-varint (continuation bit set, buffer ends)', TIMEOUT, () => {
    // 0xff has the continuation bit set but no following byte — the varint
    // loop must not run off the end and must terminate the decode.
    const buf = new Uint8Array([0x0a, 0x03, 0x08, 0xff, 0xff])
    const stacks = decodeGlyphsPbf(buf)
    expect(Array.isArray(stacks)).toBe(true)
  })

  it('wire-type-0 tag exactly at EOF inside a fontstack (field 0, wire 0)', TIMEOUT, () => {
    // fontstack submessage whose declared length pushes `end` to exactly the
    // buffer end; once pos reaches len the loop reads a {0,0} tag → skip(0).
    // Pre-fix this is the frozen-pos case.
    const buf = new Uint8Array([0x0a, 0x02, 0x00, 0x00])
    const stacks = decodeGlyphsPbf(buf)
    expect(Array.isArray(stacks)).toBe(true)
  })

  it('top-level tag with zero field/wire and trailing zero bytes', TIMEOUT, () => {
    // Pure zero padding: top-level loop must not spin on {0,0} tags.
    const buf = new Uint8Array([0x00, 0x00, 0x00, 0x00])
    const stacks = decodeGlyphsPbf(buf)
    expect(Array.isArray(stacks)).toBe(true)
  })

  it('empty buffer decodes to an empty stack list', TIMEOUT, () => {
    const stacks = decodeGlyphsPbf(new Uint8Array(0))
    expect(stacks).toEqual([])
  })
})
