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

  it("globe VT arm dispatchIcon mirrors Path 1's trailing args (false, undefined, ps)", () => {
    expect(globeArm).toMatch(
      /dispatchIcon\(\s*featDef,\s*projected\[0\],\s*projected\[1\],\s*0,\s*pairKey,\s*false,\s*undefined,\s*ps,?\s*\)/,
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
    expect(mercArm).toContain('dispatchIcon(featDef, px, py, 0, pairKey, false, undefined, ps)')
  })

  it('Path 1 (GeoJSON) wiring is unchanged — guard, green before and after', () => {
    expect(path1).toContain('const ps = projected[2]')
    expect(path1).toMatch(/pairKey,\s*undefined,\s*ps,\s*\)/)
    expect(path1).toContain(
      'dispatchIcon(featDef, projected[0], projected[1], 0, pairKey, false, undefined, ps)',
    )
  })
})
