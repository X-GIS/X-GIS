import { defineConfig } from 'astro/config'
import { fileURLToPath, URL } from 'node:url'
import sitemap from '@astrojs/sitemap'
import react from '@astrojs/react'
import tailwindcss from '@tailwindcss/vite'
import basicSsl from '@vitejs/plugin-basic-ssl'
import expressiveCode from 'astro-expressive-code'
import xgisGrammar from './src/lib/xgis-grammar.json' with { type: 'json' }

const isCI = !!process.env.GITHUB_ACTIONS
const BASE = (isCI ? '/X-GIS' : '/').replace(/\/$/, '')

// Prefix the deploy base onto root-absolute internal links authored in
// markdown content (blog posts write clean `/docs/...`). Astro's `base`
// only rewrites links built from import.meta.env.BASE_URL in .astro/JSX;
// plain markdown hrefs are emitted verbatim and 404 under the GitHub Pages
// base. This walks the rendered HAST and prepends BASE to any site-root-
// absolute href (skipping protocol-relative `//`, already-based, and the
// local case where BASE is empty). Zero-dep tree-walk — no unist import.
function rehypeBaseLinks() {
  return (tree) => {
    const walk = (node) => {
      if (
        node.tagName === 'a' &&
        node.properties &&
        typeof node.properties.href === 'string'
      ) {
        const href = node.properties.href
        if (BASE && href.startsWith('/') && !href.startsWith('//') && !href.startsWith(BASE + '/')) {
          node.properties.href = BASE + href
        }
      }
      if (node.children) for (const c of node.children) walk(c)
    }
    walk(tree)
  }
}

export default defineConfig({
  site: 'https://x-gis.github.io',
  base: isCI ? '/X-GIS' : '/',
  markdown: {
    rehypePlugins: [rehypeBaseLinks],
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
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    // Workspace packages must skip Vite's pre-bundle (it can't crawl
    // their TS exports correctly through symlinks). Same fix the
    // playground uses.
    optimizeDeps: {
      exclude: ['@xgis/compiler', '@xgis/blueprint', '@xgis/runtime'],
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
