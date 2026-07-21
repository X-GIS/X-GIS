// ═══ #1177 — S16 replay-correction consumer wiring in label-pass ═══
//
// The solve math is proven in label-replay-transform.test.ts; this file pins
// the CONSUMER wiring inside LabelPass.execute():
//   - the skip state carries the reference samples + solve scratch,
//   - a MISS (prepare) frame re-samples refs through the SAME projector
//     family that places the labels (projectMercAny — single authority),
//   - a HIT (replay) frame solves prepared→current and hands the transform
//     to all four stage/iStage render calls (WebGPU + forced-WebGL2 arms),
//   - a MISS frame renders with `undefined` (identity) — labelReplay is only
//     assigned under the canSkipLabelPrepare guard.
// Structural source-text assertions in the directory's established style
// (label-pass-vt-perspective-wiring.test.ts documents the constraint: a full
// LabelPass.execute() drive needs the whole device / collision / atlas
// surface).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Normalise CRLF→LF (repo checks out with autocrlf on Windows).
const SRC = readFileSync(resolve(__dirname, 'label-pass.ts'), 'utf8').replace(/\r\n/g, '\n')

// ── Slice anchors (#996: fail loudly on refactor, not vacuously). ──
const missBlockIdx = SRC.indexOf('host._labelDispatchMisses++')
const postSkipIdx = SRC.indexOf('const _postSkip = this._skipState.get(host)')
const replaySolveIdx = SRC.indexOf('let labelReplay: LabelReplayTransform | undefined')
const rhiRenderIdx = SRC.indexOf('stage.render(ctx.rhiPass,')
const encoderRenderIdx = SRC.indexOf('stage.render(tPass,')

const missBlock = SRC.slice(missBlockIdx, postSkipIdx)
const solveBlock = SRC.slice(replaySolveIdx, replaySolveIdx + 600)

describe('label-pass — S16 replay-correction wiring (#1177)', () => {
  it('slice anchors exist (fail loudly on refactor, not vacuously)', () => {
    expect(missBlockIdx).toBeGreaterThan(-1)
    expect(postSkipIdx).toBeGreaterThan(missBlockIdx)
    expect(replaySolveIdx).toBeGreaterThan(postSkipIdx)
    expect(rhiRenderIdx).toBeGreaterThan(replaySolveIdx)
    expect(encoderRenderIdx).toBeGreaterThan(rhiRenderIdx)
  })

  it('skip state carries the replay refs + caller-owned solve scratch', () => {
    expect(SRC).toContain('replayRefs: Float64Array')
    expect(SRC).toContain('replayRefsValid: boolean')
    expect(SRC).toContain('replayOut: LabelReplayTransform')
    // Fresh-state literal allocates the fixed-size refs buffer once per host.
    expect(SRC).toContain('replayRefs: new Float64Array(REPLAY_REFS_LEN)')
  })

  it('MISS frames re-sample refs through projectMercAny (the label projector family)', () => {
    expect(missBlock).toMatch(
      /replayRefsValid = sampleReplayRefs\(\s*projectMercAny,\s*c\.centerX,\s*c\.centerY,\s*_mpp,/,
    )
  })

  it('HIT frames solve prepared→current, gated on canSkipLabelPrepare + refs validity', () => {
    expect(solveBlock).toContain('canSkipLabelPrepare &&')
    expect(solveBlock).toContain('_postSkip.replayRefsValid &&')
    expect(solveBlock).toMatch(
      /solveReplayTransform\(_postSkip\.replayRefs,\s*projectMercAny,\s*_postSkip\.replayOut\)/,
    )
    expect(solveBlock).toContain('labelReplay = _postSkip.replayOut')
  })

  it('all four render calls receive the transform (icons + text, both backends)', () => {
    expect(SRC).toMatch(
      /iStage\?\.render\(ctx\.rhiPass, \{ width: ctx\.w, height: ctx\.h \}, labelReplay\)/,
    )
    expect(SRC).toMatch(
      /stage\.render\(ctx\.rhiPass, \{ width: ctx\.w, height: ctx\.h \}, labelReplay\)/,
    )
    expect(SRC).toMatch(
      /iStage\?\.render\(tPass, \{ width: ctx\.w, height: ctx\.h \}, labelReplay\)/,
    )
    expect(SRC).toMatch(/stage\.render\(tPass, \{ width: ctx\.w, height: ctx\.h \}, labelReplay\)/)
  })

  it('labelReplay is assigned ONLY under the skip guard (miss ⇒ undefined ⇒ identity)', () => {
    // Exactly one assignment site, and it sits inside the canSkipLabelPrepare
    // conditional — a prepared frame must never render with a stale transform.
    const assignments = SRC.match(/labelReplay = /g) ?? []
    expect(assignments.length).toBe(1)
  })
})
