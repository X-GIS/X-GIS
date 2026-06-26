import { defineCollection, z } from 'astro:content'
import { glob } from 'astro/loaders'

// Tech blog — markdown under src/content/blog/. Astro 5 content-layer glob
// loader. `lang` tags each post's locale so /blog (en) and /ko/blog filter
// to their own language; `draft` hides WIP posts from production listings.
const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
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
