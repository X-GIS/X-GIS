// #2012 INC-4 — the curved line-label dispatch site must actually feed the label
// plane. The guard #1081 taught this repo to write.
//
// The failure mode is specific and it has happened: a complete, correct chain fed
// from ONE of several dispatch sites, shipping a 0.000 % pixel diff and reading as
// "the feature has no visible effect" rather than as "the feature never ran"
// (label-pass-vt-perspective-wiring.test.ts is that autopsy). D1's own design says
// any increment touching a dispatch site owes a guard in that file's style, so
// this pins the six wires INC-4 adds at the VT curved-line site:
//
//   1. the pitch-0 MERC projector is built from the same p0 matrix and flat args
//      the basis producer uses, and ONLY when a frame can use it;
//   2. the layer gate goes through the SHARED authority (groundAlignsAtRuntime,
//      #2166 — it carries the spec chain AND this branch's tangent-rotation
//      requirement), not a local re-reading of the style;
//   3. the retained samples' merc coordinates are recorded in the projection loop
//      (nothing downstream can recover them — `_pmScratch` is an arc LENGTH);
//   4. the plane run is filled from those samples with the run's own world copy;
//   5. the emitter is handed the raw merc arc, so its cadence is derived from
//      the polyline it walks and cannot be measured elsewhere (design Q7);
//   6. the interned live twin and the merc arrays reach the emitter together.
//
// Structural source-text assertions, in this directory's established style: a full
// LabelPass.execute() drive would need the whole device / collision / atlas
// surface (label-pass-inline-line.test.ts documents the same constraint). Every
// slice anchor is asserted to exist first — #996: a gate pointing at moved code
// must fail loudly, not go vacuous.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = readFileSync(resolve(__dirname, 'label-pass.ts'), 'utf8').replace(/\r\n/g, '\n')
const CURVED = readFileSync(resolve(__dirname, 'dispatch-curved-line-labels.ts'), 'utf8').replace(
  /\r\n/g,
  '\n',
)

const gateIdx = SRC.indexOf('const groundAlignedLine =')
const projLoopIdx = SRC.indexOf('const proj = projectMercAny(sx, sy, wo)')
const planeIdx = SRC.indexOf('const planeOk =')
const emitIdx = SRC.indexOf('emitCurvedLineLabels(')
const emitEnd = SRC.indexOf('perfMarkEnd(', emitIdx)

const projLoop = SRC.slice(projLoopIdx, planeIdx)
const planeBlock = SRC.slice(planeIdx, emitIdx)
const emitBlock = SRC.slice(emitIdx, emitEnd)

describe('label-pass — the curved line site feeds the label plane (#2012 INC-4)', () => {
  it('slice anchors exist (fail loudly on refactor, not vacuously)', () => {
    expect(gateIdx).toBeGreaterThan(-1)
    expect(projLoopIdx).toBeGreaterThan(gateIdx)
    expect(planeIdx).toBeGreaterThan(projLoopIdx)
    expect(emitIdx).toBeGreaterThan(planeIdx)
    expect(emitEnd).toBeGreaterThan(emitIdx)
  })

  it('1. builds the pitch-0 merc projector from the p0 matrix + the SAME flat args', () => {
    // Pairing it with any other frame would put the plane in a different one from
    // its own anchors — the reason `flatArgs` is a named object at all.
    expect(SRC).toMatch(
      /const groundMercPitch0 =\s*host\.camera\.pitch > 0 && flatArgs !== undefined\s*\?\s*makeGroundMercProjector\(p0Mvp, w, h, flatArgs\)\s*:\s*undefined/,
    )
    // The basis producer must still take the same pair, or the plane and the
    // basis describe different cameras.
    expect(SRC).toContain('makeGroundBasisFor(host.camera, liveMvp, p0Mvp, w, h, flatArgs)')
  })

  it('2. gates the layer through the shared spec authority, not a local re-read', () => {
    // #2166 — the gate used to spell HALF the condition here (the spec chain via
    // resolvePitchAlignment) and the other half (`useTangentRotation`) beside it,
    // which is exactly the local re-read this test exists to forbid: the converter
    // could not see the tangent-rotation half and so warned about labels the
    // runtime ground-projects. `groundAlignsAtRuntime` carries BOTH halves, and
    // both callers read it, so there is nothing left here to drift.
    expect(SRC).toMatch(
      /const groundAlignedLine =\s*groundMercPitch0 !== undefined &&\s*groundAlignsAtRuntime\(/,
    )
    expect(SRC).toMatch(
      /groundAlignsAtRuntime\(\s*effectiveDef\.placement,\s*effectiveDef\.rotationAlignment,\s*effectiveDef\.pitchAlignment,\s*\)/,
    )
    // The local re-read must be GONE, not merely joined: a second copy of the
    // chain here is what let the warning and the behaviour disagree.
    expect(SRC).not.toContain('resolvePitchAlignment(')
    // From @xgis/compiler — the same function the converter's runtime-gap warning
    // calls, so the set the converter reports is the set handled here.
    expect(SRC).toMatch(/import \{[^}]*\bgroundAlignsAtRuntime\b[^}]*\} from '@xgis\/compiler'/s)
  })

  it('3. records each RETAINED sample’s merc coordinate inside the projection loop', () => {
    // Must be in the retain branch, beside the screen/arc writes: `_pmScratch` is
    // an arc LENGTH and the retained run can start mid-polyline, so nothing
    // downstream can recover the sample's own ground point.
    expect(projLoop).toMatch(
      /_pmScratch\[pn\] = accM \+ segLenM \* t[\s\S]*if \(groundAlignedLine\) \{\s*_pmxScratch\[pn\] = sx\s*_pmyScratch\[pn\] = sy\s*\}[\s\S]*pn\+\+/,
    )
  })

  it('4. fills the plane from those samples, in the run’s OWN world copy', () => {
    expect(planeBlock).toMatch(
      /projectRunToLabelPlane\(\s*_pmxScratch,\s*_pmyScratch,\s*pn,\s*wo,\s*groundMercPitch0!,\s*_p0xScratch,\s*_p0yScratch,\s*\)/,
    )
    // Gated, so a viewport layer never pays for it.
    expect(planeBlock).toMatch(/const planeOk =\s*groundAlignedLine &&/)
  })

  it('5. hands the emitter the raw merc arc, so the cadence CANNOT be measured elsewhere (design Q7)', () => {
    expect(planeBlock).toContain('const walkX = planeOk ? _p0xScratch : _pxScratch')
    expect(planeBlock).toContain('const walkY = planeOk ? _p0yScratch : _pyScratch')
    // The curved run carries the arc length + tile entry, NOT a pre-computed
    // total/phase: `emitCurvedLineLabels` derives both from the polyline it walks,
    // which is what makes the Q7 mistake unrepresentable rather than merely gated.
    expect(emitBlock).toContain('mercArc: _pmScratch')
    expect(emitBlock).toContain('tileEntryM,')
    expect(emitBlock).not.toContain('worldPhasePx')
    expect(CURVED).toMatch(
      /const \{ total, worldPhasePx \} = measureRunCadence\(\s*run\.polyX,\s*run\.polyY,\s*run\.mercArc,\s*run\.pn,\s*run\.tileEntryM,\s*\)/,
    )
    // label-pass keeps ONE cadence call, for the viewport branch, which never
    // leaves the live screen.
    expect(SRC.match(/measureRunCadence\(/g)!.length).toBe(1)
    expect(planeBlock).toMatch(
      /measureRunCadence\(\s*_pxScratch,\s*_pyScratch,\s*_pmScratch,\s*pn,\s*tileEntryM,\s*\)/,
    )
    // The raw prefix-sum must not be reachable from label-pass at all — one
    // authority for "where does the world lattice start".
    expect(SRC).not.toContain('mercOffsetToScreenOffset(')
  })

  it('6. interns the live twin WITH the walk polyline and passes both to the emitter', () => {
    // One call, one count: two interns could disagree about `pn`.
    expect(SRC).toMatch(/stage\.internCurvedPolyline\(walkX, walkY, pn, _pxScratch, _pyScratch\)/)
    expect(SRC).toMatch(
      /liveX: _interned\[2\],\s*liveY: _interned\[3\],\s*mercX: _pmxScratch,\s*mercY: _pmyScratch,\s*groundBasisFor,/,
    )
    // Walk polyline in slots 0/1 either way.
    expect(emitBlock).toContain('polyX: _interned[0]')
    expect(emitBlock).toContain('polyY: _interned[1]')
  })

  it('leaves the run BILLBOARDING when any of the four preconditions fails', () => {
    // planeOk is the single conjunction, so there is one place to reason about:
    // no ground layer, no pitch, no flat projection, or an unimageable sample.
    expect(planeBlock).toMatch(/const planeOk =\s*groundAlignedLine &&\s*projectRunToLabelPlane\(/)
    expect(SRC).toMatch(/\.\.\.\(planeOk\s*\?\s*\{/)
  })

  it('the extracted module is the one being called (both halves reachable — #996)', () => {
    expect(SRC).toContain('emitCurvedLineLabels(')
    expect(SRC).toContain('curvedRunIdentity(')
    expect(CURVED).toContain('export function emitCurvedLineLabels(')
    expect(CURVED).toContain('export function curvedRunIdentity(')
    expect(CURVED).toContain('export function projectRunToLabelPlane(')
    expect(CURVED).toContain('export function measureRunCadence(')
  })

  it('the emitter reads the merc sample at the CORRESPONDENCE, not at the run start', () => {
    // `_sampleOut[3]/[4]` are the (segment, fraction) the anchor resolved to; the
    // basis must be derived at that ground point, not at sample 0 (which would be
    // one basis per RUN and would reintroduce the far-field error INC-1 removed).
    expect(CURVED).toMatch(
      /const i = _sampleOut\[3\][\s\S]*const t = _sampleOut\[4\][\s\S]*const gx = mx\[i\]! \+ \(mx\[i \+ 1\]! - mx\[i\]!\) \* t/,
    )
    // #2012 INC-5 — the producer now yields the basis AND its size multiplier in
    // one call, so the pin is on the CALL (which is what carries the ground point)
    // rather than on the assignment it used to be spelled as.
    expect(CURVED).toContain('run.groundBasisFor?.(run.featDef, lon, lat)')
    expect(CURVED).toContain('_groundArgs.basis = align?.basis')
    // Both halves come off the SAME call — a second call would be a second
    // projection AND could be handed a different ground point.
    expect((CURVED.match(/run\.groundBasisFor\?\./g) ?? []).length).toBe(1)
  })
})
