// Single source of truth for the /ko locale manifest and locale-path math.
// Reused by Base.astro (the first-visit redirect script + hreflang alternates)
// and LangToggle.astro. Pure build-time — no browser APIs here.

export type Locale = 'en' | 'ko'
export type WhenMissing = 'hide' | 'home'

// localStorage key the first-visit auto-switch reads; the toggle writes it so
// a manual choice persists and wins over browser-language detection.
export const LANG_KEY = 'xgis-lang'

// Build-time manifest of localized (/ko) routes. Glob keys are project-absolute
// page paths; the replace chain strips '/src/pages', the '/index.<ext>' suffix,
// and the file extension, leaving the route exactly as the site serves it
// (e.g. '/ko', '/ko/docs'). Kept in this precise shape because the inline
// first-visit redirect script in Base.astro indexes it as `'/ko' + tail`.
const koGlob = import.meta.glob('/src/pages/ko/**/*.{astro,md,mdx}')
export const koRoutes: string[] = Object.keys(koGlob).map(
  (p) =>
    p
      .replace('/src/pages', '')
      .replace(/\/index\.(astro|md|mdx)$/, '')
      .replace(/\.(astro|md|mdx)$/, '') || '/',
)

// Site base prefix ('/X-GIS' in CI, '' in dev), trailing slash stripped.
const base = import.meta.env.BASE_URL.replace(/\/+$/, '')

/** Strip the base prefix and a single trailing slash (root stays '/'). */
export function stripBase(pathname: string): string {
  let p = pathname
  if (base && p.startsWith(base)) p = p.slice(base.length)
  if (p.length > 1) p = p.replace(/\/+$/, '')
  return p || '/'
}

/**
 * Locale-agnostic logical path — base- and locale-stripped:
 *   '/X-GIS/ko/docs' → '/docs'    '/X-GIS/' → '/'
 *   '/ko'            → '/'         '/docs'   → '/docs'
 * Pass the result to getRelativeLocaleUrl / getAbsoluteLocaleUrl, which
 * re-apply base + locale themselves (never prepend base manually).
 */
export function toLogicalPath(pathname: string): string {
  const p = stripBase(pathname)
  if (p === '/ko') return '/'
  if (p.startsWith('/ko/')) return p.slice(3) // drop '/ko', keep the leading '/'
  return p
}

/** Current locale of a raw pathname — authoritative, no Astro inference. */
export function localeOf(pathname: string): Locale {
  const p = stripBase(pathname)
  return p === '/ko' || p.startsWith('/ko/') ? 'ko' : 'en'
}

/**
 * Does a Korean twin exist for this logical path? Checks both trailing and
 * non-trailing forms, mirroring the redirect script's dual lookup.
 *   hasKoTwin('/')     → true  ('/ko' exists)
 *   hasKoTwin('/docs') → false (no '/ko/docs' yet)
 */
export function hasKoTwin(logicalPath: string): boolean {
  const tail = logicalPath === '/' ? '' : logicalPath
  const want = '/ko' + tail
  return koRoutes.includes(want) || koRoutes.includes(want.replace(/\/$/, ''))
}
