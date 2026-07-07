// Shared blog-collection helpers. The list page, the post page (prev/next),
// the RSS feed, and the search index must all agree on which posts are
// published and in what order — this module is that single authority.

import { getCollection, type CollectionEntry } from 'astro:content'

export type BlogPost = CollectionEntry<'blog'>

/**
 * Published posts for a locale, newest first. Same-day posts should carry a
 * TIME in their frontmatter date (e.g. 2026-07-07T06:26:00Z) — the id
 * tie-breaker below only makes a missing-time tie DETERMINISTIC (the glob
 * loader's file order is not).
 */
export async function publishedPosts(lang = 'en'): Promise<BlogPost[]> {
  return (await getCollection('blog', (e) => !e.data.draft && e.data.lang === lang)).sort(
    (a, b) => b.data.date.getTime() - a.data.date.getTime() || b.id.localeCompare(a.id),
  )
}

/** Estimated reading time in whole minutes (~200 wpm, minimum 1). */
export function readingTimeMin(body: string | undefined): number {
  const words = (body ?? '').split(/\s+/).filter(Boolean).length
  return Math.max(1, Math.round(words / 200))
}
