import { defineConfig } from 'astro/config'
import sitemap from '@astrojs/sitemap'
import tailwindcss from '@tailwindcss/vite'
import expressiveCode from 'astro-expressive-code'
import xgisGrammar from './src/lib/xgis-grammar.json' with { type: 'json' }

const isCI = !!process.env.GITHUB_ACTIONS

export default defineConfig({
  site: 'https://x-gis.github.io',
  base: isCI ? '/X-GIS' : '/',
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
  ],
  vite: {
    plugins: [tailwindcss()],
    // Workspace packages must skip Vite's pre-bundle (it can't crawl
    // their TS exports correctly through symlinks). Same fix the
    // playground uses.
    optimizeDeps: {
      exclude: ['@xgis/compiler', '@xgis/runtime'],
    },
    // Dev-only: proxy `/play/*` to the playground's vite dev server
    // (https://localhost:3000). Production / GitHub Pages serves
    // both site and playground from the same origin under `/X-GIS/play/`,
    // so the convert page's "Open in playground" navigates correctly.
    // In local dev they're separate ports, and clicking the button
    // 404'd at /play/demo.html. The proxy makes dev mirror prod —
    // /play/demo.html on the Astro dev server forwards to
    // /demo.html on the playground server, sessionStorage works
    // cross-page because both surfaces share the Astro dev origin.
    //
    // `secure: false` lets the proxy accept the playground's self-
    // signed cert (basic-ssl plugin). `rewrite` strips the /play
    // prefix because the playground server doesn't know about it.
    server: {
      proxy: {
        '/play': {
          target: 'https://localhost:3000',
          changeOrigin: true,
          secure: false,
          ws: true,
          rewrite: (path) => path.replace(/^\/play/, ''),
        },
      },
    },
  },
})
