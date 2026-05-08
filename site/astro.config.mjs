import { defineConfig } from 'astro/config'
import sitemap from '@astrojs/sitemap'
import tailwindcss from '@tailwindcss/vite'
import expressiveCode from 'astro-expressive-code'

const isCI = !!process.env.GITHUB_ACTIONS

export default defineConfig({
  site: 'https://x-gis.github.io',
  base: isCI ? '/X-GIS' : '/',
  integrations: [
    // Build-time syntax highlighting (Shiki under the hood) + frame
    // chrome (language label, copy button, optional file caption /
    // line markers). Theme picked to match the site's dark surface.
    // xgis blocks fall back to `js`-like highlighting for now — a
    // dedicated TextMate grammar can be added later as
    // `shikiConfig.langs: [<json>]`.
    expressiveCode({
      themes: ['github-dark-default'],
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
