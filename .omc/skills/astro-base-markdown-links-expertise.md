---
name: astro-base-markdown-links
description: Astro's `base` does NOT rewrite plain-markdown hrefs — they 404 under the GitHub Pages base; fix with a rehype-base plugin
triggers:
  - blog link 404
  - docs link 404 on deploy
  - markdown link base
  - GitHub Pages base
  - import.meta.env.BASE_URL markdown
  - astro.config base
  - rehypeBaseLinks
---

# Astro `base` + plain-markdown internal links

## The Insight

Astro's `base` config (here `base: isCI ? '/X-GIS' : '/'` in `site/astro.config.mjs`)
only rewrites links that are **built from `import.meta.env.BASE_URL`** in `.astro` /
JSX components. A link written as plain markdown — `[Concepts](/docs/concepts/pipeline)`
in a content-collection `.md` — is emitted **verbatim** into the HTML. On the deployed
GitHub Pages site (served from `https://x-gis.github.io/X-GIS/…`) that root-absolute
`/docs/...` resolves off-base and 404s, while it works fine in local dev (base `/`).
So the bug is invisible locally and only shows on deploy.

## Why This Matters

The site builds links two different ways, and only ONE picks up `base`. Authoring blog
posts with clean `/docs/...` links feels correct, passes local dev, then silently 404s
in production. Local `astro build` is also blocked here (shiki/themes resolve error), so
CI/deploy is the only place this surfaces — easy to ship broken.

## Recognition Pattern

- A link works in `bun run dev` but 404s on the deployed Pages site.
- The link lives in a markdown/MDX content file (blog, docs prose), not an `.astro` page.
- The href is root-absolute (`/docs/...`, `/play`, …), not `${base}/...`.

## The Approach

Don't hand-prefix every markdown link with the base (breaks local dev where base is `/`).
Add ONE build-time rehype plugin in `astro.config.mjs` that prepends the (trailing-slash-
stripped) base to any site-root-absolute href, skipping protocol-relative `//` and
already-based links, and no-op when base is empty (local). It then covers every current
and future post. `.astro`/JSX links are already correct via `${base}` — only markdown
content needs this.

## Example

```js
const BASE = (isCI ? '/X-GIS' : '/').replace(/\/$/, '')
function rehypeBaseLinks() {
  return (tree) => {
    const walk = (node) => {
      if (node.tagName === 'a' && node.properties && typeof node.properties.href === 'string') {
        const href = node.properties.href
        if (BASE && href.startsWith('/') && !href.startsWith('//') && !href.startsWith(BASE + '/'))
          node.properties.href = BASE + href
      }
      if (node.children) for (const c of node.children) walk(c)
    }
    walk(tree)
  }
}
// defineConfig({ markdown: { rehypePlugins: [rehypeBaseLinks] } })
```
