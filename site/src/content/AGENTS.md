<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-29 -->

# site/src/content/

## Purpose

Typed TypeScript data modules that serve as the single source of truth for structured page content, plus an Astro content collection. The TS modules: `gallery-demos.ts` (the authoritative `Category[]` + `Demo[]` list consumed by `examples.astro` and the search index) and `reference-sections.ts` (the `ReferenceSection[]` list consumed by `reference.astro` and the search index). Keeping data here rather than inline in pages ensures the build-time search index stays consistent with the rendered pages. The `blog/` subdirectory holds the markdown `blog` content collection (schema in `src/content.config.ts`), rendered by `pages/blog/`.

## Key Files

| File                    | Description                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `gallery-demos.ts`      | Exports `Demo` interface, `Category` interface, `galleryCategories: Category[]` (11 categories, ~50 demos), `featuredDemos: Demo[]` (3 entries), and `runIdOf(d)` helper. Each `Demo` carries `id`, optional `runId`, `title`, `body`, and optional `noThumb`, `defaultHash`, `devOnly`, `standaloneUrl`. Thumbnail filename convention: `public/thumbnails/{id}.jpg`.         |
| `reference-sections.ts` | Exports `ReferenceSection` interface and `referenceSections: ReferenceSection[]` (12 sections: quick-start → sources → layers → modifiers → filters → match → background → presets → symbols → animation → projections → js-api). Each section carries `id`, `title`, `body`, optional `code` snippet, and optional `demoId`/`demoQuery`/`demoHash` for playground deep-links. |

## For AI Agents

### Working In This Directory

- `gallery-demos.ts` is the ONLY place to add, remove, or rename gallery demos. Do not add demo metadata directly in `examples.astro`.
- The `id` field in each `Demo` entry must match: (1) the playground demo key (or explicit `runId`), and (2) the thumbnail filename `public/thumbnails/{id}.jpg`. `runIdOf(demo)` resolves `runId ?? id.replace(/-/g, '_')`.
- Set `devOnly: true` for demos that depend on the local Vite proxy (e.g., the protomaps v4 daily basemap) — they are hidden in production builds.
- PMTiles demos that get rewritten to the Firenze sample archive in production should carry a `defaultHash` so the user lands at a visible location.
- `standaloneUrl` bypasses `demo.html?id=…` for demos that need bespoke JS glue beyond the declarative `.xgis`-source contract.
- `reference-sections.ts` changes require a corresponding update to the actual prose in `src/pages/docs/reference.astro`.

### Testing Requirements

- TypeScript compilation via `bun run check` validates exported types. There are no runtime unit tests for this directory.

### Common Patterns

- Both files export named array constants; consumers use named imports, not default imports.
- `referenceSections` entries with `demoId` render a "Try this →" playground link; `demoHash` pins the camera to a useful position when the archive is the Firenze sample.

## Dependencies

### Internal

- `src/lib/search-index.ts` — imports both modules to build the build-time search index
- `src/pages/examples.astro` — imports `galleryCategories` and `featuredDemos` from `gallery-demos.ts`
- `src/pages/docs/reference.astro` — imports `referenceSections` from `reference-sections.ts`

### External

None

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->

## Blog authoring (AI end-of-session write-ups)

> **Audience = every engineer, not this repo (user directive, 2026-07-08).** Write
> each post so it is **generally useful to a senior engineer at ANY company** who
> has never heard of X-GIS. The transferable, broadly-useful lesson IS the post;
> X-GIS is only the incident that surfaced it — the concrete example, never the
> subject. If the draft would interest only someone who works in this repo, it has
> failed — rewrite it around the general lesson. Treat the "strip X-GIS" test below
> as the PRIMARY goal, not a footnote.

When you write a `blog/` post at the end of a work session, **start from the
skeleton**: copy `blog/_TEMPLATE.md` to `blog/YYYY-MM-DD-slug.md` and fill it in.
The template (excluded from the published collection by the `!_*` glob in
`src/content.config.ts`) encodes the house style inline; this is the short
version of why it exists.

The one bar every post must clear: **strip "X-GIS" and a transferable lesson
must remain.** A post that only makes sense to someone who works on this repo is
an internal changelog, not an article. Insight lives in the _specific_ — the
concrete symptom, the wrong turn, the raw observation — not in the general maxim.

**Ground everything; invent nothing.** You are writing about work you just did,
so the facts exist: `git log --author=Claude <branch>`, `git show <sha>`, the
code, the tests. Every number, symptom, error string, and code snippet comes
from that record. If a fact isn't recoverable, leave it out or say "we infer /
did not measure this" — a fabricated number or a made-up snippet is worse than an
admitted gap (both have shipped here and been caught in review). The most
valuable thing to recover is the **dead end** you actually hit this session — the
first fix that failed, the wrong hypothesis — because it vanishes when the
session ends and it is exactly what makes the post worth reading.

The recurring failure to avoid (audited across every existing post):

| Tell (generic)                                       | Fix (specific)                                                                     |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Danger in the conditional: "a rename _can_ mislink"  | Past tense if it fired: "a rename mislinked the two stages — here's the log"       |
| The conclusion only: "a missing tile looked corrupt" | The observation that produced it: "we dumped the `.pbf` and saw `<!DOCTYPE html>`" |
| A category list of bugs caught                       | The one failing input/value that makes it memorable                                |
| Vanity numbers (`~37k lines`, `147 files`)           | Symptom numbers (`217 refs → 87`, `1687 → 1468 bytes`)                             |
| A bulleted "Takeaways" ending of maxims              | One earned prose sentence — and only if the reader would have disagreed first      |
| Topic-sentence opener ("precision matters")          | A concrete fact opener (the number, the error, the symptom)                        |

Reading aids available in posts: `$…$` KaTeX math, ` ```lang ` highlighted code
fences, `:::warning` / `:::note` / `:::tip` callouts (use for gotchas/traps),
auto-scrolling tables, framed `![](…)` figures, pre-rendered Mermaid diagrams
(author a `.mmd` in `site/diagrams/`, render to a committed SVG via
`site/diagrams/render.sh`, embed as a `<figure>` — build-time only, no client
JS), and `<LiveShader id="…"/>` in `.mdx` posts. Group a multi-part arc with the
`series:` frontmatter field.
