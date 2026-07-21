// ═══ Gallery drift gate (build-time) ═══
//
// The /examples gallery has THREE hand-synced authorities that have
// historically drifted apart (24 demos went missing from the site cards
// between 2026-07-14 and 2026-07-21):
//
//   1. playground/src/demos/*.ts        — the playground DEMOS registry
//   2. site/src/content/gallery-demos.ts — the site gallery cards
//   3. playground/e2e/_capture-thumbnails.spec.ts — the thumbnail list
//
// A shared list is deliberately off the table (site → playground
// no-cycle rule, see the capture spec's header), so this gate makes the
// drift IMPOSSIBLE instead: it fs-reads the two playground files at
// astro build time and throws — failing the build — unless every
// visible playground demo has a card, every card resolves to a real
// demo, the capture list matches the thumbnail-bearing cards exactly,
// and every expected thumbnail JPG is committed. It runs in every CI
// path: the root `bun run build` (all code legs) builds the site, and
// site-only PRs run the dedicated site build job.
//
// Called from examples.astro frontmatter — server/build-side only,
// never shipped to the browser.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { galleryCategories, featuredDemos, runIdOf } from '../content/gallery-demos'

/** Walk upward from the build's cwd to the monorepo root. import.meta.url
 *  is useless here: astro prerender executes this module from a bundled
 *  chunk under site/dist/.prerender/, so module-relative paths don't
 *  survive the build. The cwd (site/ via `bun run --filter`, or the repo
 *  root via a direct astro invocation) is always inside the checkout. */
function findRepoRoot(): string {
  let dir = process.cwd()
  for (;;) {
    if (existsSync(join(dir, 'playground', 'src', 'demos'))) return dir
    const parent = dirname(dir)
    if (parent === dir) {
      throw new Error(
        '[gallery-drift] could not locate the monorepo root (no playground/src/demos ' +
          `above ${process.cwd()}) — the gate must run from inside the checkout.`,
      )
    }
    dir = parent
  }
}

const repoRoot = findRepoRoot()

/** Top-level demo keys from the per-category fragment files. The
 *  fragments are strictly conventional (append-only records, keys at
 *  two-space indent — see demos.ts's assembler comment), so a
 *  line-anchored regex is reliable; both bare and quoted keys are
 *  matched so a stylistic variant cannot silently vanish from the
 *  gate's universe. fixtures.ts is excluded because demos.ts wraps it
 *  in asHidden() and the gallery omits hidden demos. */
function visiblePlaygroundDemoIds(): Set<string> {
  const dir = join(repoRoot, 'playground', 'src', 'demos')
  const ids = new Set<string>()
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.ts') || file === 'loader.ts' || file === 'fixtures.ts') continue
    const src = readFileSync(join(dir, file), 'utf8')
    for (const m of src.matchAll(/^ {2}(?:(\w+)|'([\w-]+)'|"([\w-]+)"): \{/gm)) {
      ids.add((m[1] ?? m[2] ?? m[3])!)
    }
  }
  if (ids.size === 0) {
    throw new Error(
      '[gallery-drift] parsed 0 demo keys from playground/src/demos/*.ts — ' +
        'the fragment format changed; update visiblePlaygroundDemoIds() in ' +
        'site/src/lib/gallery-drift-check.ts to match.',
    )
  }
  return ids
}

/** The GALLERY_DEMOS id list from the thumbnail capture spec. Only
 *  whole lines of the form `'id',` count — a quoted word inside a
 *  comment must not enter the id set. */
function captureSpecIds(): Set<string> {
  const spec = readFileSync(
    join(repoRoot, 'playground', 'e2e', '_capture-thumbnails.spec.ts'),
    'utf8',
  )
  const block = spec.match(/const GALLERY_DEMOS = \[([\s\S]*?)\n\]/)
  if (!block) {
    throw new Error(
      '[gallery-drift] GALLERY_DEMOS array not found in ' +
        'playground/e2e/_capture-thumbnails.spec.ts — the spec format changed; ' +
        'update captureSpecIds() in site/src/lib/gallery-drift-check.ts to match.',
    )
  }
  return new Set([...block[1]!.matchAll(/^\s*'(\w+)',?\s*$/gm)].map((m) => m[1]!))
}

export function assertGalleryInSync(): void {
  const pgIds = visiblePlaygroundDemoIds()
  const cards = galleryCategories.flatMap((c) => c.demos)
  const runnerCards = cards.filter((d) => !d.standaloneUrl)

  const problems: string[] = []

  // 1. Every visible playground demo has a site card.
  const cardRunIds = new Set(runnerCards.map(runIdOf))
  const missingCards = [...pgIds].filter((id) => !cardRunIds.has(id)).sort()
  if (missingCards.length > 0) {
    problems.push(
      `playground demos with NO site gallery card (add cards to ` +
        `site/src/content/gallery-demos.ts): ${missingCards.join(', ')}`,
    )
  }

  // 2. Every non-standalone card (and featured entry) resolves to a real demo,
  //    and no two cards share a runId (a colliding runId would publish a card
  //    pointing at the wrong demo with the wrong thumbnail).
  for (const d of [...runnerCards, ...featuredDemos]) {
    if (!pgIds.has(runIdOf(d))) {
      problems.push(
        `site card '${d.id}' resolves to runId '${runIdOf(d)}' which is not a ` +
          `registered playground demo — fix the card's runId or register the demo`,
      )
    }
  }
  const seenRunIds = new Map<string, string>()
  for (const d of runnerCards) {
    const rid = runIdOf(d)
    const prev = seenRunIds.get(rid)
    if (prev !== undefined) {
      problems.push(`site cards '${prev}' and '${d.id}' both resolve to runId '${rid}'`)
    }
    seenRunIds.set(rid, d.id)
  }

  // 3. The thumbnail capture list matches the thumbnail-bearing cards exactly.
  const wantThumbs = new Set(runnerCards.filter((d) => !d.noThumb && !d.devOnly).map(runIdOf))
  const captured = captureSpecIds()
  const notCaptured = [...wantThumbs].filter((id) => !captured.has(id)).sort()
  const overCaptured = [...captured].filter((id) => !wantThumbs.has(id)).sort()
  if (notCaptured.length > 0) {
    problems.push(
      `cards expect a thumbnail but are missing from GALLERY_DEMOS in ` +
        `playground/e2e/_capture-thumbnails.spec.ts: ${notCaptured.join(', ')}`,
    )
  }
  if (overCaptured.length > 0) {
    problems.push(
      `GALLERY_DEMOS entries with no thumbnail-bearing site card (remove them ` +
        `or fix the card): ${overCaptured.join(', ')}`,
    )
  }

  // 4. Every expected thumbnail JPG is committed. Featured entries always
  //    render a thumbnail in examples.astro, so they join the requirement.
  for (const d of featuredDemos) {
    if (!d.noThumb && !d.devOnly) wantThumbs.add(runIdOf(d))
  }
  const thumbDir = join(repoRoot, 'site', 'public', 'thumbnails')
  const missingThumbs = [...wantThumbs]
    .filter((id) => !existsSync(join(thumbDir, `${id}.jpg`)))
    .sort()
  if (missingThumbs.length > 0) {
    problems.push(
      `missing thumbnail JPGs under site/public/thumbnails/ (run ` +
        `\`bun run test:e2e -- _capture-thumbnails.spec.ts\` in playground/, or ` +
        `set noThumb on the card): ${missingThumbs.join(', ')}`,
    )
  }

  if (problems.length > 0) {
    throw new Error(
      `[gallery-drift] /examples gallery is out of sync with the playground ` +
        `(${problems.length} problem${problems.length === 1 ? '' : 's'}):\n - ` +
        problems.join('\n - '),
    )
  }
}
