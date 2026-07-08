import { defineConfig } from 'astro/config'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'
import sitemap from '@astrojs/sitemap'
import react from '@astrojs/react'
import tailwindcss from '@tailwindcss/vite'
import basicSsl from '@vitejs/plugin-basic-ssl'
import expressiveCode from 'astro-expressive-code'
import mdx from '@astrojs/mdx'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import xgisGrammar from './src/lib/xgis-grammar.json' with { type: 'json' }

const isCI = !!process.env.GITHUB_ACTIONS
const BASE = (isCI ? '/X-GIS' : '/').replace(/\/$/, '')

// Prefix the deploy base onto root-absolute internal links authored in
// markdown content (blog posts write clean `/docs/...`). Astro's `base`
// only rewrites links built from import.meta.env.BASE_URL in .astro/JSX;
// plain markdown hrefs are emitted verbatim and 404 under the GitHub Pages
// base. This walks the rendered HAST and prepends BASE to any site-root-
// absolute `a href` or `img src` (skipping protocol-relative `//`,
// already-based, and the local case where BASE is empty). Zero-dep
// tree-walk — no unist import.
function rehypeBaseLinks() {
  const rebase = (url) =>
    BASE && url.startsWith('/') && !url.startsWith('//') && !url.startsWith(BASE + '/')
      ? BASE + url
      : url
  return (tree) => {
    const walk = (node) => {
      if (node.properties) {
        if (node.tagName === 'a' && typeof node.properties.href === 'string') {
          node.properties.href = rebase(node.properties.href)
        }
        if (node.tagName === 'img' && typeof node.properties.src === 'string') {
          node.properties.src = rebase(node.properties.src)
        }
      }
      if (node.children) for (const c of node.children) walk(c)
    }
    walk(tree)
  }
}

/** Flattened text content of a hast node. */
function textOf(node) {
  if (node.type === 'text') return node.value
  return (node.children ?? []).map(textOf).join('')
}

// Blog posts write bare "[1]" / "[1][2]" citation markers in prose and a
// "## References" numbered list at the foot — bracket text with no link and
// no matching anchor, so a reader can't jump to (or back from) a citation.
// This finds that references <ol> (scanning top-level nodes for the section
// between the "References" heading and the next heading), stamps each <li>
// with a `ref-N` id, then rewrites every "[N]" run OUTSIDE that list (and
// outside code/pre, so a literal bracketed number in a code span is left
// alone) into a small linked marker pointing at `#ref-N`. Zero-dep tree-walk,
// same style as rehypeBaseLinks — no remark-cite dependency for five posts.
function rehypeCitations() {
  return (tree) => {
    let refsOl = null
    let inReferences = false
    for (const node of tree.children ?? []) {
      if (node.tagName === 'h1' || node.tagName === 'h2') {
        inReferences = textOf(node).trim() === 'References'
        continue
      }
      if (inReferences && node.tagName === 'ol') {
        refsOl = node
        break
      }
    }
    if (refsOl) {
      refsOl.children
        .filter((n) => n.tagName === 'li')
        .forEach((li, i) => {
          li.properties = { ...li.properties, id: `ref-${i + 1}` }
        })
    }

    const CITATION = /\[(\d+)\]/g
    const isKatex = (n) =>
      Array.isArray(n.properties?.className) && n.properties.className.includes('katex')
    const walk = (node) => {
      if (node === refsOl || node.tagName === 'code' || node.tagName === 'pre' || isKatex(node))
        return
      if (!node.children) return
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i]
        if (child.type === 'text' && CITATION.test(child.value)) {
          CITATION.lastIndex = 0
          const pieces = []
          let last = 0
          let m
          while ((m = CITATION.exec(child.value))) {
            if (m.index > last)
              pieces.push({ type: 'text', value: child.value.slice(last, m.index) })
            pieces.push({
              type: 'element',
              tagName: 'a',
              properties: { href: `#ref-${m[1]}`, className: ['citation'] },
              children: [{ type: 'text', value: `[${m[1]}]` }],
            })
            last = m.index + m[0].length
          }
          if (last < child.value.length)
            pieces.push({ type: 'text', value: child.value.slice(last) })
          node.children.splice(i, 1, ...pieces)
          i += pieces.length - 1
          continue
        }
        walk(child)
      }
    }
    walk(tree)
  }
}

// A comparison table wider than the 720px prose measure needs to scroll
// horizontally on narrow/mobile viewports — but a bare `overflow-x: auto`
// on the table itself gives no visual sign there's more to the right, so a
// reader just sees the last column cut off and reads it as broken.
//
// Wraps each <table> in TWO nested divs: an outer `.table-scroll` (static,
// position: relative — its CSS ::after paints a right-edge fade) around an
// inner `.table-scroll-inner` (the actual `overflow-x: auto` scroller). The
// fade has to live on the OUTER, non-scrolling box: an absolutely-positioned
// pseudo-element on the SAME element that scrolls is part of that element's
// scrollable content and scrolls away with it (measured — the one-wrapper
// version put the fade at the table's right edge, not the viewport's, so it
// only lined up with the visible edge at scrollLeft 0 and vanished the
// moment a reader actually scrolled).
function rehypeWrapTables() {
  return (tree) => {
    const walk = (node) => {
      if (!node.children) return
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i]
        if (child.tagName === 'table') {
          node.children[i] = {
            type: 'element',
            tagName: 'div',
            properties: { className: ['table-scroll'] },
            children: [
              {
                type: 'element',
                tagName: 'div',
                properties: { className: ['table-scroll-inner'] },
                children: [child],
              },
            ],
          }
          continue
        }
        walk(child)
      }
    }
    walk(tree)
  }
}

export default defineConfig({
  site: 'https://x-gis.github.io',
  base: isCI ? '/X-GIS' : '/',
  markdown: {
    // remark-math + rehype-katex: $…$ / $$…$$ LaTeX in blog markdown renders
    // to KaTeX HTML at build time (no client JS; katex.min.css is imported by
    // the blog post layout).
    remarkPlugins: [remarkMath],
    rehypePlugins: [rehypeKatex, rehypeBaseLinks, rehypeCitations, rehypeWrapTables],
  },
  // English is the default and stays at the root (/docs, /blog, …);
  // Korean is served under /ko (/ko/docs, /ko/blog, …). prefixDefaultLocale:
  // false keeps every existing en route unchanged — i18n is purely additive
  // until the /ko content is filled in. Use Astro.currentLocale + getRelativeLocaleUrl
  // in components for the language toggle.
  i18n: {
    defaultLocale: 'en',
    locales: ['en', 'ko'],
    routing: { prefixDefaultLocale: false },
  },
  integrations: [
    // Build-time syntax highlighting (Shiki under the hood) + frame
    // chrome (language label, copy button, optional file caption /
    // line markers). Theme picked to match the site's dark surface.
    expressiveCode({
      themes: ['github-dark-default'],
      // Custom grammar so xgis-specific tokens (block keywords like
      // `source` / `layer`, color literals, utility classes,
      // pipe/coalesce/match-arrow operators, runtime accessors like
      // `zoom`) get tokenised distinctively rather than falling back
      // to JS approximation. See src/lib/xgis-grammar.json.
      shiki: {
        langs: [xgisGrammar],
      },
      styleOverrides: {
        borderRadius: '0.75rem',
        codeFontFamily: '"DM Mono", "Fira Code", monospace',
        codeFontSize: '13px',
        frames: {
          shadowColor: 'transparent',
        },
      },
      defaultProps: {
        wrap: true,
      },
    }),
    sitemap(),
    // MDX for the blog only (content.config.ts globs both `.md` and `.mdx`
    // under src/content/blog). Inherits the `markdown` remark/rehype config
    // above (remarkMath/rehypeKatex/rehypeBaseLinks) by default, so KaTeX and
    // the GH-Pages base-link rewrite keep working in `.mdx` posts. Lets a
    // post import + embed a component (e.g. LiveShader) directly in prose.
    mdx(),
    // React islands — shadcn/ui components render as hydrated islands;
    // expressive-code stays build-time, Astro pages stay static.
    react(),
  ],
  vite: {
    plugins: [tailwindcss(), basicSsl()],
    // Dev/build resolve @xgis/runtime to SOURCE, not the published dist.
    // ship-P0 packaging set the runtime package `main`/`exports` to
    // ./dist/index.js for external npm consumers; without this alias the
    // site build (blueprint live-preview + Hero both dynamically import
    // @xgis/runtime) fails to resolve the package entry because dist is
    // built only for publishing. Same alias the playground vite config uses.
    resolve: {
      alias: {
        '@xgis/runtime': fileURLToPath(new URL('../runtime/src/index.ts', import.meta.url)),
        // @xgis/runtime bundles @xgis/engine + @xgis/map (extracted in P3). Alias them to
        // SOURCE too so the site loads ONE instance of each — Vite pre-bundling them into a
        // second copy split the stateful RHI Material-twin / projections singletons, so the
        // hero's fill draws hit "no RHI Material twin" and the render loop halted.
        '@xgis/engine': fileURLToPath(new URL('../engine/src/index.ts', import.meta.url)),
        '@xgis/map': fileURLToPath(new URL('../map/src/index.ts', import.meta.url)),
        // #763 A1 — shader-dsl to SOURCE like the rest (subpath keys FIRST: vite alias
        // is prefix-replacing, the bare key would swallow '/examples' and '/emit-prod').
        '@xgis/shader-dsl/examples': fileURLToPath(
          new URL('../shader-dsl/examples/index.ts', import.meta.url),
        ),
        '@xgis/shader-dsl/emit-prod': fileURLToPath(
          new URL('../shader-dsl/src/emit-prod.ts', import.meta.url),
        ),
        '@xgis/shader-dsl': fileURLToPath(new URL('../shader-dsl/src/index.ts', import.meta.url)),
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    // Workspace packages must skip Vite's pre-bundle (it can't crawl
    // their TS exports correctly through symlinks). Same fix the
    // playground uses.
    optimizeDeps: {
      exclude: [
        '@xgis/compiler',
        '@xgis/blueprint',
        '@xgis/runtime',
        '@xgis/engine',
        '@xgis/map',
        '@xgis/shader-dsl',
      ],
    },
    // (No /play proxy here — earlier attempt at HTTPS-target proxy
    // returned HTTP 500 because the playground's basic-ssl cert /
    // protocol mix didn't terminate cleanly through Vite's proxy.
    // Dev path now uses a runtime-detected cross-origin redirect
    // from the convert page — see site/src/pages/convert.astro
    // for the dev branch that opens the playground at its own
    // origin and ferries the source via the URL hash.)
  },
})
