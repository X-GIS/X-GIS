// ═══ Scene / seam / overlay partition — a pass reads the geometry its ROLE names ═══
//
// `FrameContext` carries two target geometries (`scene` / `screen`). They are equal today; the
// split exists so that when the adaptive-DPR ladder shrinks the scene and leaves the overlay
// native (docs/architecture/design/overlay-native-resolution.md), a pass reading the wrong one
// is a bug that has already been caught rather than a half-pixel nobody notices.
//
// The design names this the load-bearing mitigation, because the change introduces a SECOND
// device-pixel-ratio into a codebase whose own comment (quality.ts:340) argues the single-DPR
// arrangement is precisely what makes the swapchain and the frame math unable to disagree.
// CLAUDE.md §12's "second ratchet" is the same shape: two authorities drift, silently.
//
// So the partition is DERIVED (SCENE_PASSES = PASS_CHAIN_ORDER − OVERLAY_PASSES − SEAM_PASSES;
// the seam is #1429 INC-2's upscale, which reads BOTH sides) and this gate proves three things
// a reviewer would otherwise have to take on trust:
//
//   1. the two sets cover PASS_CHAIN_ORDER exactly — no pass in both, none in neither, so a
//      pass added tomorrow cannot be silently role-less;
//   2. every label's source file RESOLVES — §12's lesson that a path-keyed allowlist dies
//      quietly when the files move, and the gate then sits vacuously green;
//   3. each pass's source reads ONLY its role's geometry.
//
// Plus a non-vacuity check on (3): a rule of the form "file must not contain X" passes
// trivially for a file that reads no geometry at all, so the gate also requires that the reads
// it is policing actually exist.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PASS_CHAIN_ORDER,
  OVERLAY_PASSES,
  SCENE_PASSES,
  SEAM_PASSES,
  type PassLabel,
} from './pass-order'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Pass label → the module that implements it. Keyed by label, not by path, so a rename shows
 *  up here as a missing file (assertion 2) rather than as a rule that quietly stops matching. */
const PASS_SOURCE: Record<PassLabel, string> = {
  background: 'background-pass.ts',
  atmosphere: 'atmosphere-pass.ts',
  flow: 'flow-pass.ts',
  opaque: 'opaque-pass.ts',
  oit: 'oit-pass.ts',
  translucent: 'translucent-pass.ts',
  hillshade: 'hillshade-pass.ts',
  points: 'points-pass.ts',
  'scene-upscale': 'scene-upscale-pass.ts',
  labels: 'label-pass.ts',
  heatmap: 'heatmap-pass.ts',
  'overdraw-compose': 'overdraw-compose-pass.ts',
  graphics: 'graphics-pass.ts',
}

/** Comment-stripped module source — the geometry-read rules below must match
 *  CODE, not prose (review MINOR-2: a doc comment naming `ctx.scene` would
 *  otherwise satisfy the seam's dual-read rule vacuously). Line + block
 *  comments only; string literals in these modules never contain `ctx.`. */
const source = (label: PassLabel): string =>
  readFileSync(join(HERE, PASS_SOURCE[label]), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/[^\n]\/\/.*$/gm, (m) => m[0])

/** Does the source reach a geometry?
 *
 *  Two spellings, because one would leave a hole: the member access (`ctx.scene.w`, and the
 *  `= ctx.screen` destructure the label pass uses), AND a destructure of the ROLE itself
 *  (`const { screen } = ctx`), which reads the same geometry while never writing `ctx.screen`.
 *
 *  This is a source-text gate and says so: it polices spelling, not types, so a sufficiently
 *  determined alias still evades it. That is an accepted boundary — the accident this catches
 *  is a pass reaching for the wrong size, not a pass hiding that it did. */
const reaches = (src: string, role: 'scene' | 'screen'): boolean =>
  new RegExp(`\\bctx\\.${role}\\b`).test(src) ||
  new RegExp(`\\{[^}]*\\b${role}\\b[^}]*\\}\\s*=\\s*ctx\\b`).test(src)
const readsScene = (src: string): boolean => reaches(src, 'scene')
const readsScreen = (src: string): boolean => reaches(src, 'screen')

describe('scene / seam / overlay partition', () => {
  it('covers PASS_CHAIN_ORDER exactly — every pass in exactly one of the three roles', () => {
    const overlay = new Set<string>(OVERLAY_PASSES)
    const seam = new Set<string>(SEAM_PASSES)
    const scene = new Set<string>(SCENE_PASSES)
    for (const label of PASS_CHAIN_ORDER) {
      const roles = [overlay.has(label), seam.has(label), scene.has(label)].filter(Boolean)
      expect(roles.length, `${label} must be in exactly one role`).toBe(1)
    }
    expect(SCENE_PASSES.length + SEAM_PASSES.length + OVERLAY_PASSES.length).toBe(
      PASS_CHAIN_ORDER.length,
    )
    // And no set may name a pass the order does not have.
    for (const label of [...OVERLAY_PASSES, ...SEAM_PASSES, ...SCENE_PASSES]) {
      expect(
        PASS_CHAIN_ORDER as readonly string[],
        `${label} is not in PASS_CHAIN_ORDER`,
      ).toContain(label)
    }
  })

  it('every pass label resolves to a real source file', () => {
    // The anti-vacuity companion §12 requires for any path-keyed table: if a pass module is
    // renamed and this map is not, every rule below would silently stop policing it.
    for (const label of PASS_CHAIN_ORDER) {
      expect(Object.keys(PASS_SOURCE), `${label} has no source mapping`).toContain(label)
      expect(() => source(label), `${PASS_SOURCE[label]} does not resolve`).not.toThrow()
    }
  })

  it('a SCENE pass never reads the screen geometry', () => {
    for (const label of SCENE_PASSES) {
      expect(readsScreen(source(label)), `${label} (scene) reads ctx.screen`).toBe(false)
    }
  })

  it('an OVERLAY pass never reads the scene geometry', () => {
    for (const label of OVERLAY_PASSES) {
      expect(readsScene(source(label)), `${label} (overlay) reads ctx.scene`).toBe(false)
    }
  })

  it('the SEAM reads BOTH geometries — that is what makes it the seam', () => {
    // The upscale samples the scene target (scene size decides its source rect / whether it
    // runs at all) and writes the screen attachment (screen size is its viewport). Filing it
    // into either half would falsify that half's rule, so the partition asserts the dual read
    // POSITIVELY — a seam pass that stops reading one side has silently changed role.
    for (const label of SEAM_PASSES) {
      expect(readsScene(source(label)), `${label} (seam) reads no ctx.scene`).toBe(true)
      expect(readsScreen(source(label)), `${label} (seam) reads no ctx.screen`).toBe(true)
    }
  })

  it('the rules are not vacuous — the reads they police actually exist', () => {
    // Every overlay pass positions screen-space symbology, so each one MUST read the screen
    // geometry; without this, deleting the reads would leave the rule above trivially green.
    for (const label of OVERLAY_PASSES) {
      expect(readsScreen(source(label)), `${label} (overlay) reads no ctx.screen`).toBe(true)
    }
    // Not every scene pass needs a size (background clears, flow renders into its own grid),
    // so the scene side asserts the weaker — but still falsifiable — "somebody does".
    expect(SCENE_PASSES.some((label) => readsScene(source(label)))).toBe(true)
  })
})
