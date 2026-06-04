#!/usr/bin/env bun
// matrix:accept — the ONE path that writes a reviewed baseline into the
// committed corpus. The runner never writes there; there is no
// `--update-snapshots`-style auto-rebake. A baseline becomes truth only by an
// explicit human command here PLUS a manifest `candidate → green` flip visible
// in the same PR diff. This directly implements the memory rule "a wrong
// baseline blesses a bug": the human has to look at the candidate and decide.
//
// Usage:
//   bun run matrix:accept <cell.id> [--force]
//
//   • Copies  playground/e2e/__matrix__/<id>.png   (the candidate)
//        →    playground/render-verify/baselines/<id>.png   (the blessed corpus)
//   • Writes  baselines/<id>.meta.json {reviewedBy, reviewedAt, commit, note}
//   • REFUSES to overwrite an existing baseline unless --force (no silent
//     rebake — an intentional render change must be re-reviewed explicitly).
//   • Prints the manual next step: edit matrix.manifest.ts, set the cell's
//     knownStatus 'candidate' → 'green' so the reviewer of the PR sees the new
//     PNG and the green-promotion together.

import { existsSync, mkdirSync, copyFileSync, writeFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const CANDIDATE_DIR = join(REPO, 'playground', 'e2e', '__matrix__')
const BASELINE_DIR = join(REPO, 'playground', 'render-verify', 'baselines')

function die(msg: string): never {
  console.error(`✗ matrix:accept — ${msg}`)
  process.exit(1)
}

const args = process.argv.slice(2)
const force = args.includes('--force')
const id = args.find((a) => !a.startsWith('--'))

if (!id) {
  die('missing <cell.id>. Usage: bun run matrix:accept <cell.id> [--force]')
}

const candidate = join(CANDIDATE_DIR, `${id}.png`)
if (!existsSync(candidate)) {
  die(
    `no candidate PNG at ${candidate}\n` +
    `  Run the gate first:  XGIS_MATRIX=1 bun precheck:matrix  (or XGIS_MATRIX_FILTER=${id})`,
  )
}

const baseline = join(BASELINE_DIR, `${id}.png`)
if (existsSync(baseline) && !force) {
  die(
    `baseline already exists at ${baseline}\n` +
    `  This is an intentional-render-change path — RE-REVIEW the candidate, then re-run with --force.\n` +
    `  (No silent rebake: a stale or unreviewed baseline blesses a bug.)`,
  )
}

mkdirSync(BASELINE_DIR, { recursive: true })
copyFileSync(candidate, baseline)

// Stamp provenance so a stale/unreviewed baseline is auditable in git blame.
let commit = 'unknown'
let reviewedBy = 'unknown'
try { commit = execSync('git rev-parse HEAD', { cwd: REPO }).toString().trim() } catch { /* not a repo */ }
try { reviewedBy = execSync('git config user.name', { cwd: REPO }).toString().trim() } catch { /* no user */ }

const meta = {
  cellId: id,
  reviewedBy,
  reviewedAt: new Date().toISOString(),
  commit,
  candidateBytes: statSync(candidate).size,
  note: 'Human-reviewed via matrix:accept. The candidate render was confirmed CORRECT (not merely present) before acceptance.',
}
writeFileSync(join(BASELINE_DIR, `${id}.meta.json`), JSON.stringify(meta, null, 2))

console.log(`✓ accepted baseline for "${id}"`)
console.log(`  ${candidate}`)
console.log(`  → ${baseline}`)
console.log(`  + ${id}.meta.json (reviewedBy=${reviewedBy}, commit=${commit.slice(0, 8)})`)
console.log('')
console.log('NEXT (manual, in the SAME PR so the reviewer sees both):')
console.log(`  edit playground/render-verify/matrix.manifest.ts —`)
console.log(`  set the "${id}" cell:  knownStatus: 'candidate'  →  'green'`)
console.log(`  then its screenshot_diff oracle becomes HARD and a future drift FAILS the push.`)
