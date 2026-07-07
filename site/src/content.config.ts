import { defineCollection } from 'astro:content'
import { glob } from 'astro/loaders'
import { z } from 'astro/zod'

// Tech blog — markdown (or MDX, for posts that embed a live component like
// LiveShader) under src/content/blog/. Astro 5 content-layer glob loader.
// `lang` tags each post's locale so /blog (en) and /ko/blog filter to their
// own language; `draft` hides WIP posts from production listings.
const blog = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    date: z.coerce.date(),
    tags: z.array(z.string()).default([]),
    lang: z.enum(['en', 'ko']).default('en'),
    draft: z.boolean().default(false),
  }),
})

export const collections = { blog }
