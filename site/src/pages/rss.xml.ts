// RSS feed for the blog. Static endpoint — built once at build time from
// the same publishedPosts() authority the /blog pages render from.
import rss from '@astrojs/rss'
import type { APIContext } from 'astro'
import { publishedPosts } from '../lib/blog'

export async function GET(context: APIContext) {
  const posts = await publishedPosts()
  const base = import.meta.env.BASE_URL.replace(/\/+$/, '')
  return rss({
    title: 'X-GIS Blog',
    description:
      'Engineering notes from the X-GIS team — the compiler, the shader IR, the globe math, the GPU render graph.',
    // astro.config sets `site`; fold in the deploy base (`/X-GIS/` in CI)
    // so the channel link points at the site root, not the bare origin.
    // Item links are root-absolute (`${base}/…`) and resolve correctly
    // against either.
    site: new URL(import.meta.env.BASE_URL, context.site!),
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.date,
      link: `${base}/blog/${post.id}`,
      categories: post.data.tags,
    })),
  })
}
