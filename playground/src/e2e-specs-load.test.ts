// ═══ Every e2e spec must LOAD (#1638) ═══
//
// `bun run test:e2e` collected `0 tests in 0 files` for an unknown length of
// time. Six specs threw at module scope, and a module-scope throw is a
// COLLECTION error — Playwright aborts the entire run rather than the one
// file, so six rotted specs silently took 379 healthy ones with them.
// `--grep-invert` does not rescue it either: filtering happens after module
// load.
//
// CI never noticed because `.github/workflows/test.yml` names its render-gate
// specs EXPLICITLY, so it only ever loads the ~49 it lists. The failure was
// visible only to a human running the documented whole-suite command.
//
// WHY THIS ASSERTS LOADING AND NOT A LINT RULE. The three root causes were an
// untracked baseline read at module scope, a stale relative import, and a
// workspace-package import that the Playwright loader cannot resolve. A static
// rule catches the first two; the third is indistinguishable from the package
// imports that DO work (`_vs-clip-parity` imports `@xgis/compiler` and is green
// in CI), so no syntactic rule separates them. Actually loading every module is
// the only check that covers all three — and `--list` does exactly that for
// 5 s, with no browser and no dev server.

import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLAYGROUND = resolve(HERE, '..')
const E2E_DIR = join(PLAYGROUND, 'e2e')

/** Spec files on disk — the population `--list` must be able to load. */
const specFiles = readdirSync(E2E_DIR).filter((f) => f.endsWith('.spec.ts'))

describe('every e2e spec loads — a module-scope throw aborts the whole suite (#1638)', () => {
  it('the corpus is nonempty', () => {
    // A gate that does not prove its own population is the bug it guards
    // against, one level up (#1625).
    expect(specFiles.length, `no .spec.ts files under ${E2E_DIR}`).toBeGreaterThan(300)
  })

  it('`playwright test --list` collects every spec file, with no collection errors', () => {
    let stdout: string
    try {
      stdout = execFileSync('./node_modules/.bin/playwright', ['test', '--list'], {
        cwd: PLAYGROUND,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 180_000,
      })
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message: string }
      throw new Error(
        `playwright could not collect the e2e suite — one or more specs throw at module ` +
          `scope, which aborts the run for ALL of them (#1638). Fix the erroring spec; a ` +
          `module-scope readFileSync of an untracked path, a stale relative import, and a ` +
          `workspace-package import the loader cannot resolve have each caused this.\n\n` +
          `${err.stderr ?? ''}\n${err.stdout ?? err.message}`.slice(0, 4000),
      )
    }

    const match = /Total:\s+(\d+)\s+tests? in\s+(\d+)\s+files?/.exec(stdout)
    expect(
      match,
      `could not parse a "Total:" line from --list output:\n${stdout.slice(-2000)}`,
    ).not.toBeNull()

    const filesCollected = Number(match![2])
    // Exact equality would break on any spec that legitimately generates no
    // test (none today); the floor that matters is "essentially all of them",
    // which still goes red the moment one spec's throw drops the count to 0.
    expect(
      filesCollected,
      `--list collected ${filesCollected} of ${specFiles.length} spec files — a spec that ` +
        `fails to load takes the whole suite with it (#1638)`,
    ).toBeGreaterThanOrEqual(specFiles.length)
  })
})

// ═══ Every e2e spec is either run by CI or knowingly dark (#1817) ═══
//
// #1715's original version of this file only audited `*-gate.spec.ts` — so a spec
// named `*-match.spec.ts`, `*-parity.spec.ts`, `*-probe.spec.ts`, or anything else
// non-gate-suffixed was never even a candidate for the check below: it was neither
// required to be registered nor required to be allowlisted as known-dark. That hole
// hid `_compute-path-continent-match.spec.ts` sitting on main at a deterministic
// 32.5% compute-vs-CPU divergence for an unbounded time (#1808) — no CI registration
// meant no last-green bound, and the defect it hid shipped dark precisely through
// this hole (#1817).
//
// THE INVERSION (#1817 option 3, the recommended fix): the population is now EVERY
// `*.spec.ts` file under playground/e2e/ (`specFiles`, already proven nonempty
// above) — not the subset whose name happens to end in `-gate`. Every spec must be
// either (a) present in one of test.yml's registered spec lists, or (b) an explicit
// key in KNOWN_DARK_SPECS below, with a one-line reason. A new spec that is neither
// fails THIS test until its author makes an explicit choice — dark-by-omission is
// no longer possible, regardless of what the file happens to be named.
//
// KNOWN_DARK_SPECS supersedes #1715's KNOWN_DARK_GATES (36 gate-named rows this
// file used to carry stayed green after registration and were deleted here; the one
// substantive row, `_matrix-gate.spec.ts`, carries its reason forward unchanged
// below) — one allowlist, not two authorities for the same fact (CLAUDE.md §12's
// "second ratchet" lesson).
//
// SHRINK-ONLY, in both directions, exactly as #1715 established:
//   • a spec missing from CI and from this list          → red, add it to CI or here
//   • a row here that IS now registered                  → red, delete the row
//   • a row here naming a file that no longer exists      → red, delete the row
//
// Every row was classified by reading the spec's own header (network dependency /
// real-GPU requirement / probe status, mostly self-documented) or, where a spec's
// header text is ambiguous ("real GPU" prose that turns out NOT to mean "SwiftShader
// can't run this" — the exact trap CLAUDE.md §5 names by its own history), by cross-
// referencing the scene demo(s) it loads against every playground/src/examples/*.xgis
// source's actual `url:` — the mechanical, checkable version of "does this need
// network". The 47-spec #1349 census (8 local / 2 mixed / 37 network-blocked) is
// reused verbatim for the specs it already covers instead of being re-derived.
export const KNOWN_DARK_SPECS: Readonly<Record<string, string>> = {
  // ---- CURATED -- individually researched (test.yml's own documented "NOT here" specs, the #1349 census exact matches, and specs whose header text resolves ambiguity explicitly). See the cited issue/PR in each reason. (35) ----
  '_absorbed-fn-parity.spec.ts':
    "spec's own header: Compute is SwiftShader-viable, so it is a CI gate -- CI-viable, pending registration (#1349)",
  '_cold-start-perf.spec.ts':
    'mixed local+network cases (#1349 census: 2 of the 47 stability/perf specs) -- local + openfreemap/PMTiles cases in one file; needs splitting before any CI use (#1349)',
  '_compute-path-continent-match.spec.ts':
    "the #1817/#1808 flagship example -- real defect (32.5% compute-vs-CPU divergence) fixed by #1818; #1808's own verification bar calls for registering this spec in test.yml once fixed, which is #1349/test.yml's separate work (out of scope for this audit-only change) -- pending registration (#1349)",
  '_convert-page-redesign.spec.ts':
    "targets the SITE Astro dev server (port 4321) via a throwaway static server the spec itself spins up -- Playwright's dev-server config here points only at the playground harness registered specs use; needs separate CI wiring before registration (#1349)",
  '_desktop-baseline-z10.spec.ts':
    'reports triangles/lines/GPU timing as a baseline measurement -- diagnostic reporting, not a pass/fail correctness gate',
  '_fp64-known-answer.spec.ts':
    "spec's own header: compute works under SwiftShader in CI, same charter as _shader-math-parity.spec.ts -- CI-viable, pending registration (#1349)",
  '_globe-arena-pressure.spec.ts':
    'builds full RENDER pipelines and streams tiles through the same SwiftShader init that times out; candidate for CI once the GPUArena OOM PR lands (test.yml notes) -- local/pre-push for now',
  '_globe-ecef-render-position.spec.ts':
    "spec's own header: (SwiftShader) createRenderPipeline of a real vertex shader times out, and throws no WebGPU adapter (hardware GPU required -- do NOT run under SwiftShader) -- HARDWARE/PRE-PUSH GATE, not a GitHub-CI render-gate (mirrors _ws8-projection-field's carve-out)",
  '_high-pitch-flicker.spec.ts':
    'fixture-unblocked (#1349) but not CI-viable as a blocking SwiftShader gate -- measured SwiftShader throughput ~4 tiles/min needs ~15 min for full convergence at the bug camera (#1349 comment); belongs in the real-GPU/nightly bucket, not registered',
  '_host-retained-icons-perf.spec.ts':
    'local fixture (#1349 census: 8 fully local of the 47 stability/perf specs) but asserts a real-GPU wall-clock timing budget (e.g. p95 <= 16.6ms for 100k icons) SwiftShader cannot honor -- belongs in a reported-not-blocking nightly bucket, not registered (#1349)',
  '_host-sprite-atlas-parity.spec.ts':
    "spec's own header: Objective (exact bytes) ... SwiftShader-safe for CI -- CI-viable, pending registration (#1349)",
  '_inline-data-verify.spec.ts':
    "spec's own header claims CI render-gate runs this under SwiftShader, but it is not actually present in test.yml's registered list -- stale claim or dropped registration; appears CI-viable, pending registration (#1349)",
  '_label-anchor-parity.spec.ts':
    'full-engine RENDER of compare.html (X-GIS + MapLibre) with real tiles at z14; needs the same full render-pipeline init SwiftShader times out on. Header says Real chromium WebGPU (test.yml notes) -- local/pre-push only',
  '_landing-hero.spec.ts':
    'hits the SITE Astro dev server (port 4321), not the playground -- same dev-server mismatch as _convert-page-redesign; needs separate CI wiring before registration (#1349)',
  '_matrix-gate.spec.ts':
    'OPT-IN AND LOCAL BY DESIGN -- test.skip(!MATRIX_ON) with no workflow setting XGIS_MATRIX (a registered spec would skip vacuously), and ADR-0004: a real-GPU visual-regression matrix SwiftShader cannot raster. It IS a gate -- a PRE-PUSH gate (bun precheck:matrix), not a GitHub-CI one',
  '_perf-coldstart-pipeline-prewarm.spec.ts':
    'mixed local+network cases (#1349 census: 2 of the 47 stability/perf specs) -- local + openfreemap/PMTiles cases in one file; needs splitting before any CI use (#1349)',
  '_perf-compute-strategy.spec.ts':
    'local fixture (#1349 census: 8 fully local of the 47 stability/perf specs) but asserts a real-GPU wall-clock timing budget (e.g. p95 <= 16.6ms for 100k icons) SwiftShader cannot honor -- belongs in a reported-not-blocking nightly bucket, not registered (#1349)',
  '_perf-encode-scaling-sweep.spec.ts':
    'local fixture (#1349 census: 8 fully local of the 47 stability/perf specs) but asserts a real-GPU wall-clock timing budget (e.g. p95 <= 16.6ms for 100k icons) SwiftShader cannot honor -- belongs in a reported-not-blocking nightly bucket, not registered (#1349)',
  '_perf-geojson-path-cost.spec.ts':
    'local fixture (#1349 census: 8 fully local of the 47 stability/perf specs) but asserts a real-GPU wall-clock timing budget (e.g. p95 <= 16.6ms for 100k icons) SwiftShader cannot honor -- belongs in a reported-not-blocking nightly bucket, not registered (#1349)',
  '_perf-pitch-cost-sweep.spec.ts':
    'local fixture (#1349 census: 8 fully local of the 47 stability/perf specs) but asserts a real-GPU wall-clock timing budget (e.g. p95 <= 16.6ms for 100k icons) SwiftShader cannot honor -- belongs in a reported-not-blocking nightly bucket, not registered (#1349)',
  '_perf-scenarios.spec.ts':
    'local fixture (#1349 census: 8 fully local of the 47 stability/perf specs) but asserts a real-GPU wall-clock timing budget (e.g. p95 <= 16.6ms for 100k icons) SwiftShader cannot honor -- belongs in a reported-not-blocking nightly bucket, not registered (#1349)',
  '_phase5f-perf-compare.spec.ts':
    'local fixture (#1349 census: 8 fully local of the 47 stability/perf specs) but asserts a real-GPU wall-clock timing budget (e.g. p95 <= 16.6ms for 100k icons) SwiftShader cannot honor -- belongs in a reported-not-blocking nightly bucket, not registered (#1349)',
  '_profile-hybrid-stall.spec.ts':
    'targeted CPU profile capture (Chromium Profiler) for a stall investigation -- diagnostic tool, not a pass/fail correctness gate',
  '_profile-minimal.spec.ts':
    'profiling probe (settles the scene, then profiles) -- diagnostic tool, not a pass/fail correctness gate',
  '_profile-multilayer-pan.spec.ts':
    'GPU timestamp-query profiling probe (?gpuprof=1) for CPU vs GPU frame-cost breakdown -- diagnostic tool, not a pass/fail correctness gate',
  '_projection-coverage.spec.ts':
    "needs the full engine (render pipelines) to initialise; SwiftShader can't, cells time out (test.yml's render-gate 'NOT here' notes) -- local/pre-push gate",
  '_render-verify-oracle-b.spec.ts':
    'RASTER: pixel-diffs the GPU frame vs a d3-geo Canvas2D reference and self-declares Real GPU headed (HEADED=1) / ADR-0004: LOCAL, not CI (test.yml notes)',
  '_render-verify.spec.ts':
    'RASTER: screenshots demos and counts painted pixels; needs a correct raster, SwiftShader-unsafe (test.yml notes) -- local/pre-push only',
  '_style-parity-diff.spec.ts':
    "RASTER: pixelmatch on real X-GIS vs MapLibre canvas screenshots -- SwiftShader can't raster X-GIS, every cell false-positives (test.yml notes) -- local only",
  '_vs-pipeline-integrity.spec.ts':
    'builds the full RENDER pipelines under the same SwiftShader init that times out _projection-coverage; candidate for CI once validated on a software-GPU run (test.yml notes) -- local/pre-push for now',
  '_webgl2-parity.spec.ts':
    "real-GPU HEADED WebGL2/WebGPU parity MEASUREMENT harness -- headless SwiftShader can't drive both true backends, and it never hard-fails (test.yml notes) -- local-only",
  '_writebuffer-attribution.spec.ts':
    'diagnostic tool that prints a {label -> {calls, bytes}} writeBuffer attribution table -- not a pass/fail correctness gate',
  '_ws8-projection-field.spec.ts':
    'full-engine init, Real-GPU per its header, not SwiftShader-safe (test.yml notes) -- local only',
  '_zoom-transition-flicker.spec.ts':
    "spec's own header: Diagnostic spec ... observation only -- captures per-frame state, asserts nothing",
  'miter-check.spec.ts':
    'manual visual-capture tool -- zero expect() assertions, writes screenshots to disk for human review only, not an automated correctness gate',

  // ---- REAL-GPU / HEADED ONLY -- the spec's own header explicitly rules out SwiftShader (an explicit "do NOT run under SwiftShader" / "HEADED=1 required" / "cannot be a headless CI gate" statement, not just prose that happens to say "real GPU"). (8) ----
  '_backend-switch-crash.spec.ts':
    "real-GPU / headed-only per the spec's own explicit header statement, not SwiftShader-safe",
  '_disc-arena-uaf.spec.ts':
    "real-GPU / headed-only per the spec's own explicit header statement, not SwiftShader-safe",
  '_fill-pattern-dc0.spec.ts':
    "real-GPU / headed-only per the spec's own explicit header statement, not SwiftShader-safe",
  '_host-source-loader-verify.spec.ts':
    "real-GPU / headed-only per the spec's own explicit header statement, not SwiftShader-safe",
  '_relocation-dc0.spec.ts':
    "real-GPU / headed-only per the spec's own explicit header statement, not SwiftShader-safe",
  '_seoul-pipeline-verify.spec.ts':
    "real-GPU / headed-only per the spec's own explicit header statement, not SwiftShader-safe",
  '_stage-block-line-parity.spec.ts':
    "real-GPU / headed-only per the spec's own explicit header statement, not SwiftShader-safe",
  '_stage-block-point-parity.spec.ts':
    "real-GPU / headed-only per the spec's own explicit header statement, not SwiftShader-safe",

  // ---- NETWORK-BLOCKED (direct) -- the spec text itself names a live network host (openfreemap.org, pmtiles-proxy/protomaps, tile.openstreetmap.org, NOAA, pmtiles.io) with no egress in CI. Same class as the #1349 census's 37 network-blocked specs. (100) ----
  '_1229-loading-indicator.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_artifact-cap.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_azimuthal-pitch0-render-probe.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_bundle-pixel-invariant.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_camera-tilt-continuity.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_capture-thumbnails.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_compile-opt-bright.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_convert-bright-flat-tilecount.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_convert-bright-min.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_convert-bright-pitch-perf.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_convert-bright.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_coverage-black-ratio.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_debug-curved-label-witness.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_debug-dash-cases.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_debug-demotiles-tile.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_debug-icon-prepare-cost.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_debug-icon-render-parity.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_debug-inc1-phase.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_debug-inc2-curved-phase.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_debug-label-bugs.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_debug-liberty-farplane-cull.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_debug-liberty-pitch-drawstats.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_debug-liberty-pitch72-perf.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_debug-liberty-pitch72-tilecount.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_debug-london-eye-flat.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_debug-london-eye.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_debug-ml-collision-boxes.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_debug-ofm-newbugs.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_debug-ofm-positron-shield.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_debug-ofm-school-fill.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_debug-pacific-zoom-sweep.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_debug-paired-collision.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_debug-shield-spacing.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_debug-sse-verification.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_debug-zoom-in-dup.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_debug-zoomstep.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_demo-fixture-audit.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_extrude-regression.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_first-map-latency.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_full-audit.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_globe-bake-uaf.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_glyph-atlas-stability.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_icon-rhi-parity.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_import-maplibre-demo.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_label-dump-bilingual.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_label-halo-z0-probe.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_label-icon-rhi-parity.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_label-interaction-stress.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_label-pitch-bearing-matrix.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_label-zoom-south-korea.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_liberty-korea-validation.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_openfreemap-bright-demo.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_openfreemap-bright-overzoom.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_overdraw-inspector.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_perf-bright-cpuprofile.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_perf-bright-high-pitch-cpu.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_perf-bright-interactive.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_perf-bright-no-labels.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_perf-bright-sse.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_perf-bright-transition-profile.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_perf-bundle-baseline.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_perf-bundle-hit-rate.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_perf-compute-interactive.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_perf-draw-stats.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_perf-extended.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_perf-hitch-frame-attribution.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_perf-liberty-paris-z18.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_perf-merc-high-pitch-drag-cpu.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_perf-merc-high-pitch-drag.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_perf-mobile-passes.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_perf-pan-hitch-attribution.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_perf-projection-matrix.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_perf-projection-seoul-deep.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_perf-projection-seoul-pitch-drag.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_perf-projection-seoul-zoom-sweep.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_perf-seoul-cpu.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_perf-seoul-liberty.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_perf-seoul-zoomed.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_perf-tokyo-zoom-9-10.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_perf-worker-receive.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_pitch-far-detail.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_pixel-match-liberty-paris-z18.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_pixel-match-school-fill.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_pixel-match-seoul-zoom-matrix.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_pixel-match-survey-labels.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_pixel-match-survey.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_pixel-match-user-views.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_pmtiles-protomaps-v4.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_pmtiles-rapid-zoom-leak.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_pmtiles-render.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_probe-bright-gl2.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_projection-label-onscreen.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_projection-perf-relative.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_return-to-view-determinism.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_screenshot-liberty-worldcopy.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_screenshot-non-merc-seoul-matrix.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_shield-text-box-align.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_text-rhi-parity.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_tile-coverage-stress.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",
  '_user-parity-check.spec.ts':
    "network-dependent (openfreemap / pmtiles-proxy / protomaps / OSM live tiles), no egress in CI -- same class as the #1349 census's 37 network-blocked specs (#1349)",

  // ---- NETWORK-BLOCKED (via scene demo) -- the spec does not name a network host directly, but the demo(s) it loads (by `id=` / `id: '...'`) resolve, in playground/src/examples/*.xgis, to a source URL that playground/src/demos/loader.ts rewrites to a live host (api.protomaps.com, tile.openstreetmap.org, pmtiles.io, OpenFreeMap). Computed by cross-referencing every demo id against every .xgis source file's `url:`/`import` lines -- see the classification method in this PR's description. (51) ----
  '_along-path-roads.spec.ts':
    'scene demo(s) [along_path_roads] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_building-depth-diag.spec.ts':
    'scene demo(s) [osm_style] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_building-depth-snapshot.spec.ts':
    'scene demo(s) [osm_style] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_continuous-wheel-zoom-mobile.spec.ts':
    'scene demo(s) [pmtiles_layered] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_continuous-wheel-zoom.spec.ts':
    'scene demo(s) [pmtiles_layered] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_draw-order-trace.spec.ts':
    'scene demo(s) [osm_style] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_globe-bake-i1.spec.ts':
    'scene demo(s) [pmtiles_layered] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_gpu-features-dump.spec.ts':
    'scene demo(s) [multi_layer] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_import-mapbox-style.spec.ts':
    'scene demo(s) [import_mapbox_style] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_invariant-check.spec.ts':
    'scene demo(s) [pmtiles_layered] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_layer-events-click.spec.ts':
    'scene demo(s) [multi_layer] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_layer-events-hover.spec.ts':
    'scene demo(s) [multi_layer] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_layer-events-remove.spec.ts':
    'scene demo(s) [multi_layer] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_layer-pointer-events.spec.ts':
    'scene demo(s) [multi_layer] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_layer-style.spec.ts':
    'scene demo(s) [multi_layer] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_map-events.spec.ts':
    'scene demo(s) [multi_layer] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_mobile-detail-uniformity.spec.ts':
    'scene demo(s) [pmtiles_layered] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_mobile-fast-gesture-thermal.spec.ts':
    'scene demo(s) [pmtiles_layered] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_mobile-overdraw-flat-pitch.spec.ts':
    'scene demo(s) [pmtiles_layered] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_mobile-zoom-out-load.spec.ts':
    'scene demo(s) [pmtiles_layered] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_opacity-aggressive.spec.ts':
    'scene demo(s) [osm_style] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_osm-style-capture.spec.ts':
    'scene demo(s) [osm_style] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_osm-style-merge-proof.spec.ts':
    'scene demo(s) [osm_style] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_osm-style-opacity.spec.ts':
    'scene demo(s) [osm_style] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_osm-style-smoke.spec.ts':
    'scene demo(s) [osm_style] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_perf-debug-overzoom.spec.ts':
    'scene demo(s) [pmtiles_layered] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_perf-high-pitch-manhattan.spec.ts':
    'scene demo(s) [osm_style] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_pick-e2e.spec.ts':
    'scene demo(s) [multi_layer] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_pick-visual.spec.ts':
    'scene demo(s) [multi_layer] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_pmtiles-labels.spec.ts':
    'scene demo(s) [pmtiles_labels] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_pmtiles-layered-diag.spec.ts':
    'scene demo(s) [pmtiles_layered, pmtiles_only_landuse, pmtiles_v4] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_pmtiles-layered.spec.ts':
    'scene demo(s) [pmtiles_layered] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_pmtiles-overzoom-disappear.spec.ts':
    'scene demo(s) [pmtiles_layered] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_pmtiles-perf.spec.ts':
    'scene demo(s) [pmtiles_v4] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_pmtiles-stress-leak.spec.ts':
    'scene demo(s) [pmtiles_layered] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_pmtiles-zoom14-blank.spec.ts':
    'scene demo(s) [pmtiles_layered] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_prefetch-cancelled.spec.ts':
    'scene demo(s) [pmtiles_layered] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_production-capture.spec.ts':
    'scene demo(s) [pmtiles_layered] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_raster-rhi-parity.spec.ts':
    'scene demo(s) [raster] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_raster-texture-destroy.spec.ts':
    'scene demo(s) [multi_layer] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_realistic-pinch-gesture.spec.ts':
    'scene demo(s) [pmtiles_layered] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_runtime-quality.spec.ts':
    'scene demo(s) [multi_layer] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_setquality-render-impact.spec.ts':
    'scene demo(s) [multi_layer] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_snapshot-button.spec.ts':
    'scene demo(s) [osm_style] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_snapshot-replay.spec.ts':
    'scene demo(s) [osm_style] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_user-scenario-capture.spec.ts':
    'scene demo(s) [pmtiles_layered] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_visual-diag.spec.ts':
    'scene demo(s) [osm_style] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_ws9-light.spec.ts':
    'scene demo(s) [osm_style] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_zoom-in-tile-hold.spec.ts':
    'scene demo(s) [pmtiles_layered] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_zoom-transition-blank-tiles.spec.ts':
    'scene demo(s) [pmtiles_layered] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',
  '_zoom-wheel.spec.ts':
    'scene demo(s) [osm_style] resolve to a network-fetched source (openfreemap / pmtiles-proxy->api.protomaps.com / tile.openstreetmap.org / pmtiles.io -- verified in playground/src/examples/*.xgis), no egress in CI (#1349)',

  // ---- DEBUG PROBE -- `_debug-*` naming convention, investigation-only per this file's own pre-existing carve-out (see the block comment above KNOWN_DARK_SPECS). (2) ----
  '_debug-geolines-render.spec.ts':
    "investigation/debug probe (per the `_debug-` naming convention), never meant to gate CI -- see this file's own carve-out for `_debug-*`, `_perf-*`, `_pixel-match-*` and friends",
  '_debug-london-eye-pitch.spec.ts':
    "investigation/debug probe (per the `_debug-` naming convention), never meant to gate CI -- see this file's own carve-out for `_debug-*`, `_perf-*`, `_pixel-match-*` and friends",

  // ---- VISUAL/COMPUTE PARITY -- `*-parity` / `pixel-match-*` naming convention; needs a correctly-rasterized frame or a cross-implementation (MapLibre/hardware) comparison SwiftShader cannot honor, per test.yml's own documented render-gate policy (see its "CI-GATED vs LOCAL-ONLY render correctness" section). (14) ----
  '_compute-dispatch-parity.spec.ts':
    "visual/compute parity spec needing a correctly-rasterized frame or cross-implementation comparison; SwiftShader raster is unsafe for these per test.yml's documented render-gate policy",
  '_dash-parity.spec.ts':
    "visual/compute parity spec needing a correctly-rasterized frame or cross-implementation comparison; SwiftShader raster is unsafe for these per test.yml's documented render-gate policy",
  '_demotiles-webgpu-parity-probe.spec.ts':
    "visual/compute parity spec needing a correctly-rasterized frame or cross-implementation comparison; SwiftShader raster is unsafe for these per test.yml's documented render-gate policy",
  '_fn-binding-parity.spec.ts':
    "visual/compute parity spec needing a correctly-rasterized frame or cross-implementation comparison; SwiftShader raster is unsafe for these per test.yml's documented render-gate policy",
  '_labels-parity-check.spec.ts':
    "visual/compute parity spec needing a correctly-rasterized frame or cross-implementation comparison; SwiftShader raster is unsafe for these per test.yml's documented render-gate policy",
  '_line-image-pattern-parity.spec.ts':
    "visual/compute parity spec needing a correctly-rasterized frame or cross-implementation comparison; SwiftShader raster is unsafe for these per test.yml's documented render-gate policy",
  '_line-rhi-parity.spec.ts':
    "visual/compute parity spec needing a correctly-rasterized frame or cross-implementation comparison; SwiftShader raster is unsafe for these per test.yml's documented render-gate policy",
  '_pattern-parity.spec.ts':
    "visual/compute parity spec needing a correctly-rasterized frame or cross-implementation comparison; SwiftShader raster is unsafe for these per test.yml's documented render-gate policy",
  '_pixel-match-buildings-only.spec.ts':
    "visual/compute parity spec needing a correctly-rasterized frame or cross-implementation comparison; SwiftShader raster is unsafe for these per test.yml's documented render-gate policy",
  '_pixel-match-demotiles-compute.spec.ts':
    "visual/compute parity spec needing a correctly-rasterized frame or cross-implementation comparison; SwiftShader raster is unsafe for these per test.yml's documented render-gate policy",
  '_pixel-match-demotiles-user.spec.ts':
    "visual/compute parity spec needing a correctly-rasterized frame or cross-implementation comparison; SwiftShader raster is unsafe for these per test.yml's documented render-gate policy",
  '_point-rhi-parity.spec.ts':
    "visual/compute parity spec needing a correctly-rasterized frame or cross-implementation comparison; SwiftShader raster is unsafe for these per test.yml's documented render-gate policy",
  '_stdlib-shape-parity.spec.ts':
    "visual/compute parity spec needing a correctly-rasterized frame or cross-implementation comparison; SwiftShader raster is unsafe for these per test.yml's documented render-gate policy",
  '_translucent-outline-parity.spec.ts':
    "visual/compute parity spec needing a correctly-rasterized frame or cross-implementation comparison; SwiftShader raster is unsafe for these per test.yml's documented render-gate policy",

  // ---- INVESTIGATION / DIAGNOSTIC PROBE -- naming convention (probe/diag/audit/witness/hunt/inspector/trace/dump/capture/replay/check/verify/snapshot/profile); never meant to gate CI. (15) ----
  '_1515-compaction-hitch-probe.spec.ts':
    'investigation/diagnostic probe (naming convention: probe/diag/audit/witness/hunt/inspector/trace/dump/capture/replay/check/verify/snapshot/profile), never meant to gate CI',
  '_bug-replay.spec.ts':
    'investigation/diagnostic probe (naming convention: probe/diag/audit/witness/hunt/inspector/trace/dump/capture/replay/check/verify/snapshot/profile), never meant to gate CI',
  '_extrude-overlap-oit-probe.spec.ts':
    'investigation/diagnostic probe (naming convention: probe/diag/audit/witness/hunt/inspector/trace/dump/capture/replay/check/verify/snapshot/profile), never meant to gate CI',
  '_fixture-audit.spec.ts':
    'investigation/diagnostic probe (naming convention: probe/diag/audit/witness/hunt/inspector/trace/dump/capture/replay/check/verify/snapshot/profile), never meant to gate CI',
  '_heatmap-verify.spec.ts':
    'investigation/diagnostic probe (naming convention: probe/diag/audit/witness/hunt/inspector/trace/dump/capture/replay/check/verify/snapshot/profile), never meant to gate CI',
  '_interaction-audit.spec.ts':
    'investigation/diagnostic probe (naming convention: probe/diag/audit/witness/hunt/inspector/trace/dump/capture/replay/check/verify/snapshot/profile), never meant to gate CI',
  '_phase5e-yellow-sea-verify.spec.ts':
    'investigation/diagnostic probe (naming convention: probe/diag/audit/witness/hunt/inspector/trace/dump/capture/replay/check/verify/snapshot/profile), never meant to gate CI',
  '_phase5f2-inline-verify.spec.ts':
    'investigation/diagnostic probe (naming convention: probe/diag/audit/witness/hunt/inspector/trace/dump/capture/replay/check/verify/snapshot/profile), never meant to gate CI',
  '_pick-check.spec.ts':
    'investigation/diagnostic probe (naming convention: probe/diag/audit/witness/hunt/inspector/trace/dump/capture/replay/check/verify/snapshot/profile), never meant to gate CI',
  '_seoul-arc-hero-verify.spec.ts':
    'investigation/diagnostic probe (naming convention: probe/diag/audit/witness/hunt/inspector/trace/dump/capture/replay/check/verify/snapshot/profile), never meant to gate CI',
  '_seoul-arc-multiday-verify.spec.ts':
    'investigation/diagnostic probe (naming convention: probe/diag/audit/witness/hunt/inspector/trace/dump/capture/replay/check/verify/snapshot/profile), never meant to gate CI',
  '_seoul-odb-hero-verify.spec.ts':
    'investigation/diagnostic probe (naming convention: probe/diag/audit/witness/hunt/inspector/trace/dump/capture/replay/check/verify/snapshot/profile), never meant to gate CI',
  '_snapshot-from-paste.spec.ts':
    'investigation/diagnostic probe (naming convention: probe/diag/audit/witness/hunt/inspector/trace/dump/capture/replay/check/verify/snapshot/profile), never meant to gate CI',
  '_warn-check.spec.ts':
    'investigation/diagnostic probe (naming convention: probe/diag/audit/witness/hunt/inspector/trace/dump/capture/replay/check/verify/snapshot/profile), never meant to gate CI',
  '_whisker-hunt.spec.ts':
    'investigation/diagnostic probe (naming convention: probe/diag/audit/witness/hunt/inspector/trace/dump/capture/replay/check/verify/snapshot/profile), never meant to gate CI',

  // ---- PENDING REGISTRATION (#1349) -- deterministic, local-fixture, CI-viable per its header and scene demos, simply never added to a workflow leg. Registering these is #1349's follow-up work, not this audit's (see CLAUDE.md: do not edit test.yml here). (62) ----
  '_1222-drape-stroke-zoom-width.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_1229-ux-batch2.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_1235-push-line.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_1245-wrap-continuity-sweep.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_1248-composite-size-zoom.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_auto-labels.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_dashed-corner.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_ecef-render-position.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_epsg5179-reprojection.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_filter-gdp-z-fighting.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_fixture-picking.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_flat-globe-shots.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_flat-mercator-flatness.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_font-vendoring.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_full-outset.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_geojson-tile-dropout.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_globe-inertia-dir.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_globe-vector-drape-i2.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_globe-vector-drape-i3-cache.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_globe-vector-line-drape.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_hero-map-render.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_import-mapbox-inline-button.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_inline-geojson-import.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_inline-match-virt.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_input-live-set.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_korea-fill-regression.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_label-draw-order-near-first.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_label-occlusion-pitch.spec.ts':
    "spec's own header states it is SwiftShader-viable/safe for CI -- pending registration (#1349)",
  '_line-proof.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_line-regressions.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_mobile-monaco-collapse.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_multiline-labels.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_new-fixtures-smoke.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_ortho-backface-cull.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_ortho-tilt-backface.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_outset-corner-max.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_outset-zoom-more.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_pbf-glyphs-offline.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_picking-bgl-mismatch.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_picking-ortho-bindgroup.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_project-accessor.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_projection-zoom-survey.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_scene-builder-jstab.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_scene-builder-twin.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_single-point-bounds-fit.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_step-and-concat.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_stroke-align-compare.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_stroke-outset-detail.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_synth-bg-ortho-pitch80.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_text-overlay.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_water-hierarchy-pitch.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_world-copy-projections.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  '_zoom-interp-point-size.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  'a11y-lifecycle-events.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  'animation.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  'background-pattern-pixels.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  'fixtures.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  'import-legacy-pragma.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  'interactions.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  'reftest.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  'smoke.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
  'worldwrap-z0.spec.ts':
    'pending registration (#1349) -- deterministic local-fixture regression spec, appears CI-viable per its header and scene demos, but has never been registered in any workflow leg',
}

/**
 * The discriminator itself, factored out so it is unit-testable on a synthetic
 * file list (see the describe block below) without touching the real e2e tree —
 * the same function the real audit below calls.
 */
export function findDarkSpecs(
  allSpecFiles: readonly string[],
  registeredSpecs: ReadonlySet<string>,
  knownDarkSpecs: Readonly<Record<string, string>>,
): string[] {
  return allSpecFiles.filter((f) => !registeredSpecs.has(f) && !(f in knownDarkSpecs))
}

describe('every e2e spec is either run by CI or knowingly dark (#1817)', () => {
  const workflow = readFileSync(resolve(PLAYGROUND, '../.github/workflows/test.yml'), 'utf8')
  const registered = new Set(workflow.match(/_[a-z0-9-]+\.spec\.ts/g) ?? [])
  const knownDarkKeys = Object.keys(KNOWN_DARK_SPECS)

  it('the readers found real populations — otherwise every arm below is vacuous', () => {
    expect(specFiles.length, 'no *.spec.ts found on disk').toBeGreaterThan(300)
    expect(registered.size, 'no spec names parsed out of test.yml').toBeGreaterThan(50)
    expect(knownDarkKeys.length, 'KNOWN_DARK_SPECS is empty').toBeGreaterThan(200)
  })

  it('no spec is dark without being listed', () => {
    const unlisted = findDarkSpecs(specFiles, registered, KNOWN_DARK_SPECS)
    expect(
      unlisted,
      `these specs are neither registered in test.yml nor in KNOWN_DARK_SPECS:\n  ${unlisted.join('\n  ')}\n` +
        'Add them to a spec list in .github/workflows/test.yml, or to KNOWN_DARK_SPECS ' +
        'with a one-line reason — dark-by-omission is exactly what #1817 closed.',
    ).toEqual([])
  })

  it('the list only shrinks — a row that got registered must be deleted', () => {
    const stale = knownDarkKeys.filter((f) => registered.has(f))
    expect(stale, `now registered in CI, so delete these rows:\n  ${stale.join('\n  ')}`).toEqual(
      [],
    )
  })

  it('the list names no file that no longer exists', () => {
    // The failure CLAUDE.md §12 records: a path-keyed allowlist dies silently when files move.
    // The #996 vacuity guard, extended from #1715's gate-only KNOWN_DARK_GATES to the full
    // KNOWN_DARK_SPECS population.
    const missing = knownDarkKeys.filter((f) => !specFiles.includes(f))
    expect(missing, `no such spec — delete these rows:\n  ${missing.join('\n  ')}`).toEqual([])
  })

  // ── Registered is not the same as RUN ────────────────────────────────────────────────
  //
  // Every arm above reasons about the NAME being in test.yml. None of them notices a spec
  // that is registered and then skips itself at runtime, which reports the leg green while
  // executing nothing — the same vacuity the whole list exists to prevent, arriving through
  // the door the list does not watch. #1715 checked only gate-named registered specs; the
  // inversion widens this to every REGISTERED spec (population, not naming convention).
  //
  // Not hypothetical: `_matrix-gate` is `test.skip(!MATRIX_ON)` where
  // `MATRIX_ON = process.env.XGIS_MATRIX === '1'`, and no workflow sets that variable.
  // Registering it was measured to collect 46 cells and skip all 46 — green, proving nothing
  // (#1743 records why it is correctly dark instead). This arm makes that mistake loud rather
  // than leaving it to whoever next tidies the list.
  //
  // Deliberately STATIC. Detecting it by execution would mean running the render-gate leg,
  // which is 40 minutes; the guard has to be cheap enough to live in a unit suite. So it reads
  // the two facts that decide it — which env var a skip guard depends on, and whether any
  // workflow sets that var — and never tries to evaluate the condition itself.
  it('a registered spec is not skipped away by an env flag CI never sets', () => {
    const WORKFLOW_DIR = resolve(PLAYGROUND, '../.github/workflows')
    const allWorkflows = readdirSync(WORKFLOW_DIR)
      .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
      .map((f) => readFileSync(join(WORKFLOW_DIR, f), 'utf8'))
      .join('\n')

    const offenders: string[] = []
    for (const spec of specFiles.filter((f) => registered.has(f))) {
      const src = readFileSync(join(E2E_DIR, spec), 'utf8')
      // `const NAME = process.env.VAR …` — the indirection every such guard uses, because a
      // skip condition is a boolean the module computes once.
      const envConsts = new Map<string, string>()
      for (const m of src.matchAll(/const\s+(\w+)\s*=\s*[^\n]*process\.env\.(\w+)/g))
        envConsts.set(m[1]!, m[2]!)

      for (const skip of src.matchAll(/\btest\.skip\(([^,)]*)/g)) {
        const cond = skip[1]!
        const direct = /process\.env\.(\w+)/.exec(cond)?.[1]
        const viaConst = [...envConsts].find(([name]) =>
          new RegExp(`\\b${name}\\b`).test(cond),
        )?.[1]
        const envVar = direct ?? viaConst
        if (!envVar) continue // a skip on a runtime capability probe, not an env flag — fine
        // Set anywhere in any workflow: `VAR: 1`, `VAR=1`, `env.VAR`. Deliberately loose —
        // a false NEGATIVE here just restores today's behaviour, a false positive blocks a PR.
        if (new RegExp(`\\b${envVar}\\s*[:=]|env\\.${envVar}\\b`).test(allWorkflows)) continue
        offenders.push(`${spec} — skips on ${envVar}, which no workflow sets`)
      }
    }

    expect(
      offenders,
      'these specs are registered in CI but skip themselves there, so the leg reports green ' +
        `while running nothing:\n  ${offenders.join('\n  ')}\n` +
        'Either set the variable in the workflow that runs it, or un-register it and give it a ' +
        'KNOWN_DARK_SPECS row — a gate that skips is not a gate that ran.',
    ).toEqual([])
  })
})

// ═══ The discriminator, proven on a synthetic tree (fail-before evidence, #1817) ═══
//
// The two describe blocks above can only go red by editing playground/e2e/ or
// test.yml — expensive to demonstrate here. This proves the actual MECHANISM
// (`findDarkSpecs`) catches an unaudited spec, on inputs this test constructs
// itself: add a throwaway file to `synthetic`, don't register or allowlist it,
// and the assertion below names it — exactly what adding a real unregistered,
// unlisted spec to playground/e2e/ would do to the describe block above.
describe('findDarkSpecs — the discriminator, proven on a synthetic tree (#1817)', () => {
  it('flags a spec that is neither registered nor allowlisted, and names it', () => {
    const synthetic = [
      '_known-gate.spec.ts',
      '_known-allowlisted.spec.ts',
      '_totally-new-unaudited.spec.ts',
    ]
    const registered = new Set(['_known-gate.spec.ts'])
    const knownDark = { '_known-allowlisted.spec.ts': 'reason' }

    const dark = findDarkSpecs(synthetic, registered, knownDark)

    expect(dark).toEqual(['_totally-new-unaudited.spec.ts'])
  })

  it('a spec registered in CI is not flagged, even absent from the allowlist', () => {
    const dark = findDarkSpecs(['_a.spec.ts'], new Set(['_a.spec.ts']), {})
    expect(dark).toEqual([])
  })

  it('an allowlisted spec is not flagged, even absent from CI', () => {
    const dark = findDarkSpecs(['_a.spec.ts'], new Set(), { '_a.spec.ts': 'reason' })
    expect(dark).toEqual([])
  })

  it('the empty population flags nothing (vacuous, but must not throw)', () => {
    expect(findDarkSpecs([], new Set(), {})).toEqual([])
  })
})
