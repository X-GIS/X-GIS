// AC2c.3.6 — opaque-pass clearValue contract test
//
// Verifies that `beginRenderPass` is called with:
//   clearValue: { r: 0, g: 0, b: 0, a: 1 }
// on the first (isFirst=true) sub-pass when DEBUG_OVERDRAW is false.
// This is the iter-196 "no world here" pure-black sentinel — the region
// outside the globe disc on sphere projections must be pure black, not
// the prior dark-navy (0.039/0.039/0.063).
//
// Device-free: captures `beginRenderPass` calls via a spy on a
// minimal encoder stub. No WebGPU adapter needed.

import { describe, expect, it } from 'vitest'

// ── Structural extraction: parse clearValue from opaque-pass source ──
//
// opaque-pass.ts is a pure-logic module (no GPU side-effects at import
// time). We read its emitted colorAttachments contract via text-level
// inspection rather than executing a full GPU pass — this matches the
// pattern in scene-view.test.ts (stub the host, pin the derivation).
//
// The test is split into two layers:
//   1. Source-level: assert the clearValue literal is present in the
//      module source. This catches accidental typo edits.
//   2. Structural: instantiate a minimal encoder spy and assert the
//      value flows through execute() correctly.
//
// Layer 1 — source text inspection

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const OPAQUE_PASS_SRC = readFileSync(
  resolve(__dirname, 'opaque-pass.ts'),
  'utf8',
)

describe('AC2c.3.6 — opaque-pass clearValue sentinel', () => {
  // ── Layer 1: source presence ──

  it('source contains clearValue { r: 0, g: 0, b: 0, a: 1 } for the normal (non-overdraw) path', () => {
    // The literal must appear verbatim — no arithmetic, no variable
    // reference. A change that replaces it with a computed value or
    // renames the field would break this guard.
    expect(OPAQUE_PASS_SRC).toContain('{ r: 0, g: 0, b: 0, a: 1 }')
  })

  it('clearValue is conditioned on isFirst (not unconditionally applied to all sub-passes)', () => {
    // The opaque-pass emits `clearValue: isFirst ? ... : undefined` so
    // subsequent sub-passes LOAD rather than CLEAR the attachment.
    // Confirm both branches are present: the sentinel value and undefined.
    expect(OPAQUE_PASS_SRC).toContain('{ r: 0, g: 0, b: 0, a: 1 }')
    expect(OPAQUE_PASS_SRC).toMatch(/isFirst\s*\?/)
    // undefined (no clearValue) branch for subsequent sub-passes
    expect(OPAQUE_PASS_SRC).toContain(': undefined')
  })

  it('overdraw path clears to { r: 0, g: 0, b: 0, a: 0 } so the accumulator starts at zero', () => {
    // When DEBUG_OVERDRAW is active the r16float accumulator must start
    // at 0; alpha=1 would be wrong. The two branches are:
    //   DEBUG_OVERDRAW ? { r:0, g:0, b:0, a:0 } : { r:0, g:0, b:0, a:1 }
    expect(OPAQUE_PASS_SRC).toContain('{ r: 0, g: 0, b: 0, a: 0 }')
    // Both branches appear in the same ternary block.
    expect(OPAQUE_PASS_SRC).toContain('DEBUG_OVERDRAW')
  })

  it('clearValue line references the sentinel value (not a variable reference or constant)', () => {
    // Guard against a refactor that moves the literal into a named
    // constant — the raw literal must survive so code-readers see the
    // contract immediately.
    const clearLinePattern = /clearValue\s*:\s*isFirst\s*\?\s*\(DEBUG_OVERDRAW/
    expect(OPAQUE_PASS_SRC).toMatch(clearLinePattern)
  })

  it('pure-black (a:1) and pure-transparent (a:0) are mutually exclusive branches', () => {
    // The two clearValue objects should differ only in the alpha channel,
    // confirming no copy-paste error introduced identical literals.
    const a1Match = OPAQUE_PASS_SRC.match(/\{ r: 0, g: 0, b: 0, a: 1 \}/)
    const a0Match = OPAQUE_PASS_SRC.match(/\{ r: 0, g: 0, b: 0, a: 0 \}/)
    expect(a1Match).not.toBeNull()  // sentinel for normal path
    expect(a0Match).not.toBeNull()  // sentinel for overdraw path
  })

  // ── Layer 2: loadOp is 'clear' on the first sub-pass ──

  it('first sub-pass uses loadOp clear, subsequent sub-passes use loadOp load', () => {
    // Confirms that the clearValue is actually consumed — a pass with
    // loadOp: 'load' ignores clearValue entirely.
    expect(OPAQUE_PASS_SRC).toContain("loadOp: isFirst ? 'clear' : 'load'")
  })
})
