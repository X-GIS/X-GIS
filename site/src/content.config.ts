import { defineCollection } from 'astro:content'
import { glob } from 'astro/loaders'
import { z } from 'astro/zod'

// Tech blog — markdown (or MDX, for posts that embed a live component like
// LiveShader) under src/content/blog/. Astro 5 content-layer glob loader.
// `lang` tags each post's locale so /blog (en) and /ko/blog filter to their
// own language; `draft` hides WIP posts from production listings.
const blog = defineCollection({
  // `!_*` keeps underscore-prefixed files (e.g. `_TEMPLATE.md`, the authoring
  // skeleton AI sessions copy from) OUT of the published collection — they are
  // scaffolding, not posts, and would otherwise fail the schema / render as 404s.
  loader: glob({ pattern: ['**/*.{md,mdx}', '!**/_*'], base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    date: z.coerce.date(),
    tags: z.array(z.string()).default([]),
    lang: z.enum(['en', 'ko']).default('en'),
    draft: z.boolean().default(false),
    // Optional series grouping: consecutive posts that form one arc (the fp64
    // series, the WebGL2 backend program). `name` clusters them; `order` sets
    // the Part-N sequence. The post layout renders a "Part N of M · <name>"
    // header with prev/next when present. Omit for standalone posts.
    series: z
      .object({
        name: z.string(),
        order: z.number(),
      })
      .optional(),
  }),
})

// Generated API reference — TypeDoc markdown for @xgis/shader-dsl, written into
// src/content/api/ by scripts/build-api-reference.ts and GITIGNORED. Nothing here is
// authored: the TSDoc at each symbol's definition site is the only authority, and
// shader-dsl/src/api-doc-coverage.test.ts is what keeps a symbol from joining the public
// surface without one (#1695).
//
// The schema is deliberately minimal. `generated` is the one frontmatter key the pipeline
// writes (typedoc.json's `frontmatterGlobals`), and asserting it is how a hand-authored file
// dropped into this directory fails the build instead of quietly shipping as reference —
// the directory is regenerated from scratch on every build, so such a file would vanish
// without warning on the next one.
// `generateId` PRESERVES CASE. Astro's default slugifies, which lowercases — and TypeDoc
// writes its ~1.5k cross-references with the symbol's real casing (`/api/index/functions/
// emitConst`). With the default, 250 of the 332 pages resolve to a lowercased route while
// every link keeps the original case, so three quarters of the reference 404s AND the build
// still exits 0. Case is also correct on its own terms here: `emitConst` is the identifier a
// reader types, `emitconst` is not a thing.
const api = defineCollection({
  loader: glob({
    pattern: '**/*.md',
    base: './src/content/api',
    generateId: ({ entry }) => entry.replace(/\.md$/, ''),
  }),
  schema: z.object({
    generated: z.literal(true),
  }),
})

export const collections = { blog, api }
