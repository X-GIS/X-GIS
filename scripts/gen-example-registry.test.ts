// ═══ The generated example registry must be FRESH (#1716) ═══
//
// A generator without a freshness gate is a suggestion. The in-repo precedent for getting
// this wrong is `scripts/gen-opendata-hosts.ts`: it writes in place with a DO-NOT-EDIT
// banner and nothing checks the artifact, so the banner is the only thing standing between
// the file and silent staleness. The precedent for getting it right is
// `scripts/emit-gap-matrix.ts` + `map/src/__tests__/gap-matrix-freshness.test.ts`.
//
// This follows the second, with one improvement: that gate re-implements the generator
// inline to avoid shelling out, and keeps the copy in sync by hand. Here the generator's
// core is an exported pure-ish function, so the gate IMPORTS it. There is one authority for
// the rendering, and drift between the gate and the generator is not expressible.
//
// Runs in the `data` CI leg (test.yml passes `data/src scripts`). It lives at repo root
// rather than beside the artifact because `shader-dsl/src/self-contained.test.ts` forbids
// anything tracked under `shader-dsl/` from referencing a path outside the package, and this
// has to reach the generator.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  EXAMPLES_DIR,
  REGENERATE_WITH,
  REGISTRY_PATH,
  renderExampleRegistry,
} from './gen-example-registry'
import { discoverExamples } from '../shader-dsl/examples/_scan'
import { CURATED_ORDER } from '../shader-dsl/examples/_order'
import { buildRegistry } from '../shader-dsl/src/core/registry'

describe('shader-dsl/examples/index.ts is generated, and current', () => {
  it('matches the generator byte for byte', () => {
    const onDisk = readFileSync(REGISTRY_PATH, 'utf8')
    expect(
      renderExampleRegistry(),
      `shader-dsl/examples/index.ts is stale or was hand-edited.\n  ${REGENERATE_WITH}`,
    ).toBe(onDisk)
  })

  it('is deterministic — two renders are identical', () => {
    // A generator whose output churns cannot have a freshness gate at all; the arm above
    // would fail at random and get deleted.
    expect(renderExampleRegistry()).toBe(renderExampleRegistry())
  })

  it('carries the DO-NOT-EDIT banner naming the command', () => {
    // The arm above tells you the file is wrong; this one is what tells the next person
    // reading the file not to fix it by hand in the first place.
    const src = readFileSync(REGISTRY_PATH, 'utf8')
    expect(src).toContain('GENERATED — DO NOT EDIT.')
    expect(src).toContain(REGENERATE_WITH)
  })
})

describe('the curated order is the authority, and it is checked both ways', () => {
  it('the scan found the corpus — the floor every arm below rests on', () => {
    // Two empty sets are equal, so without this a broken scan greens the whole file.
    expect(discoverExamples(EXAMPLES_DIR).length).toBeGreaterThanOrEqual(30)
    expect(CURATED_ORDER.length).toBeGreaterThanOrEqual(30)
  })

  it('an id naming no module fails the render, naming it', () => {
    // Both directions are `buildRegistry`'s job; these arms prove the generator actually
    // routes through that check rather than rendering whatever it happened to find.
    const dir = EXAMPLES_DIR
    const spy = [...CURATED_ORDER, 'no-such-example']
    expect(() => renderWithOrder(dir, spy)).toThrow(/curated but not discovered: no-such-example/)
  })

  it('a module no id names fails the render, naming it', () => {
    // The direction that actually bites: add a file, forget `_order.ts`, and the example is
    // simply absent — from the site, the CLI printer, and every sweep over `examples`.
    const dropped = CURATED_ORDER[0]!
    expect(() => renderWithOrder(EXAMPLES_DIR, CURATED_ORDER.slice(1))).toThrow(
      new RegExp(`discovered but not curated: [^\\n]*${dropped}`),
    )
  })

  it('the real order passes — the two arms above are not just "always throws"', () => {
    expect(() => renderWithOrder(EXAMPLES_DIR, CURATED_ORDER)).not.toThrow()
  })

  it('the curated order is NOT the scan order', () => {
    // If these ever coincide the curation has been lost and the generator could own the file
    // outright — so this failing is a prompt to re-read the decision, not a bug to paper over.
    expect([...CURATED_ORDER]).not.toEqual(discoverExamples(EXAMPLES_DIR).map((e) => e.id))
  })
})

/** Re-render with a substituted order, to exercise the validator both ways. Mirrors what the
 *  generator does; kept here rather than parameterising the generator, because an `order`
 *  parameter on the real entry point would be a seam only tests use. */
function renderWithOrder(dir: string, order: readonly string[]): void {
  buildRegistry([...discoverExamples(dir)], { order })
}
