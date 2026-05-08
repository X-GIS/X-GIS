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
  },
})
