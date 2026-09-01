// #1081 reland fix — VT point-label arms must thread perspective attenuation.
//
// The #1081 reland (perspective-ratio distance attenuation) wired ONLY Path 1
// (GeoJSON `host.rawDatasets` features): its point loop reads the per-copy
// `projected[2]` tuple slot and passes it to `stage.addLabel` + `dispatchIcon`.
// Path 2 (vector-tile sources — the PRIMARY label source) dropped the scale at
// BOTH its point-label arms, so a p85 globe pixel-diff probe showed the branch
// byte-identical (0.000%) to main: the feature was inert for vector tiles.
//
//   - globe/non-mercator arm: iterates `projectLonLatCopies` but never read
//     `projected[2]`;
//   - mercator arm: uses `projectMerc` (no tuple) and never consulted the
//     projector's `perspectiveScale()` scratch getter (which the FLAT arm's
//     projectMerc sets per call — render-loop-helpers.ts), and
//     `perspectiveScale` wasn't even destructured from makeLabelProjectors.
//
// The producer math is pinned by render-loop-helpers-perspective.test.ts; this
// file pins the CONSUMER wiring at the two VT dispatch sites (and guards Path 1
// against regression). Structural source-text assertions in the directory's
// established style (see AGENTS.md; a full LabelPass.execute() drive would need
// the whole device / collision / atlas surface — label-pass-inline-line.test.ts
// documents the same constraint). Line labels and overlays stay UNWIRED by
// design: PendingLabel documents `perspectiveScale: undefined → 1` for those.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Normalise CRLF→LF (repo checks out with autocrlf on Windows).
const SRC = readFileSync(resolve(__dirname, 'label-pass.ts'), 'utf8').replace(/\r\n/g, '\n')

// ── Slice the three point-label dispatch regions (anchors must exist — #996:
//    a gate pointing at moved/renamed code must fail loudly, not go vacuous). ──
const path1Idx = SRC.indexOf('host.rawDatasets.get(show.targetName)')
const vtIdx = SRC.indexOf('const vtEntry = host.vtSources.get(show.targetName)')
const globeArmIdx = SRC.indexOf("if (host.projectionName !== 'mercator')", vtIdx)
const mercArmIdx = SRC.indexOf('for (const wo of visibleWorldCopies)', globeArmIdx)
const mercArmEnd = SRC.indexOf('perfMarkEnd(_ldMark)', mercArmIdx)

// Path 1's point loop MOVED to dispatch-point-labels.ts (#777 IV3: label-pass
// was at its LOC ceiling, and the extraction paid for the ground-basis wiring).
// The guard follows the code rather than going vacuous where it used to sit —
// which is what this file's own #996 note demands, and what it did: the slice
// below stopped matching and the suite went red instead of quietly passing.
const POINT_SRC = readFileSync(resolve(__dirname, 'dispatch-point-labels.ts'), 'utf8').replace(
  /\r\n/g,
  '\n',
)
const path1 = SRC.slice(path1Idx, vtIdx)
const globeArm = SRC.slice(globeArmIdx, mercArmIdx)
const mercArm = SRC.slice(mercArmIdx, mercArmEnd)

describe('label-pass — VT point-label arms thread perspective attenuation (#1081)', () => {
  it('slice anchors exist (fail loudly on refactor, not vacuously)', () => {
    expect(path1Idx).toBeGreaterThan(-1)
    expect(vtIdx).toBeGreaterThan(path1Idx)
    expect(globeArmIdx).toBeGreaterThan(vtIdx)
    expect(mercArmIdx).toBeGreaterThan(globeArmIdx)
    expect(mercArmEnd).toBeGreaterThan(mercArmIdx)
  })

  it('perspectiveScale is destructured from makeLabelProjectors', () => {
    expect(SRC).toMatch(/const \{[^}]*\bperspectiveScale\b[^}]*\}\s*=\s*makeLabelProjectors\(/)
  })

  it('globe VT arm reads the per-copy tuple slot 3 (projected[2])', () => {
    expect(globeArm).toContain('const ps = projected[2]')
  })

  it('globe VT arm addLabel receives ps in the perspectiveScale slot (after pointCollisionId)', () => {
    expect(globeArm).toMatch(/pointCollisionId,\s*ps,\s*\)/)
  })

  it("globe VT arm dispatchIcon mirrors Path 1's trailing args (false, undefined, ps) + the symbol-fade id", () => {
    expect(globeArm).toMatch(
      /dispatchIcon\(\s*featDef,\s*projected\[0\],\s*projected\[1\],\s*0,\s*pairKey,\s*false,\s*undefined,\s*ps,\s*pointCollisionId,?\s*\)/,
    )
  })

  it('mercator VT arm reads perspectiveScale() AFTER the successful projectMerc call', () => {
    expect(mercArm).toContain('const ps = perspectiveScale()')
    // Scratch-getter ordering: projectMerc sets perspScale per call, so the read
    // must follow the projection (and no other projector call sits between —
    // addLabel / dispatchIcon are screen-space and never project).
    expect(mercArm.indexOf('const ps = perspectiveScale()')).toBeGreaterThan(
      mercArm.indexOf('projectMerc(mercX, mercY, wo * WORLD_MERC)'),
    )
  })

  it('mercator VT arm addLabel + dispatchIcon thread ps', () => {
    expect(mercArm).toMatch(/pointCollisionId,\s*ps,\s*\)/)
    expect(mercArm).toMatch(
      /dispatchIcon\(featDef, px, py, 0, pairKey, false, undefined, ps, pointCollisionId\)/,
    )
  })

  it('Path 1 (GeoJSON) still threads ps — now from dispatch-point-labels.ts', () => {
    expect(POINT_SRC).toContain('const ps = projected[2]')
    // The perspectiveScale slot still carries a per-copy value derived from the
    // projector's tuple; #2012 INC-5 made WHICH branch of MapLibre's
    // `perspective_ratio` it holds depend on the label's own alignment, so the pin
    // is on the slot and its two possible sources rather than on the bare name.
    expect(POINT_SRC).toMatch(
      /pairKey,\s*undefined,\s*(\/\/[^\n]*\n\s*)*align !== undefined \? align\.sizeScale : ps,\s*align\?\.basis,\s*\)/,
    )
    // The paired ICON keeps #1081's viewport branch verbatim — `ps`, not the
    // label's. icon-pitch-alignment is ADR-0012 D3 and is deliberately unwired, so
    // a future edit that "tidies" these onto one value has to fail here.
    expect(POINT_SRC).toContain(
      'deps.dispatchIcon(featDef, projected[0], projected[1], 0, pairKey, false, undefined, ps)',
    )
  })

  it('Path 1 still calls into label-pass, and the extracted module still exists', () => {
    // #996 again: both halves of the move must be reachable, or this file's
    // Path-1 coverage is asserting about a file nobody calls.
    expect(path1).toContain('dispatchPointLabel(')
    expect(POINT_SRC).toContain('export function dispatchPointLabel(')
  })
})
