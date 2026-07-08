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

export const collections = { blog }
