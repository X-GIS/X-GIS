<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-03 -->

# site/public/

## Purpose
Static assets served verbatim by Astro at the root URL (`/`). Holds the GeoJSON sample dataset consumed by live map embeds, JPEG gallery thumbnails, brand SVGs (logo + OG image), and `robots.txt`. Nothing here is processed or compiled — files land in `dist/` as-is.

## Key Files
| File | Description |
|------|-------------|
| `data/land.geojson` | Simplified world land polygons used by live XGISMap embeds on the docs site |
| `og.svg` | Open Graph social preview image for the site |
| `x-gis-logo-dark.svg` | X-GIS brand logo for dark backgrounds (used in site nav/header) |
| `x-gis-logo-light.svg` | X-GIS brand logo for light backgrounds |
| `robots.txt` | Crawler directives for the docs site |

The `thumbnails/` directory contains ~50 JPEG preview images for the examples gallery (one per demo entry). `data/` holds the single GeoJSON dataset.

## For AI Agents

### Working In This Directory
- Files are copied verbatim to `dist/` — do not add TypeScript, Astro, or any file that requires compilation.
- Gallery thumbnail filenames must exactly match the `id` field of each `Demo` entry in `site/src/content/gallery-demos.ts`. Missing thumbnails cause cards to render in text-only fallback mode (controlled by the `noThumb` flag on the `Demo` entry).
- `land.geojson` is fetched at runtime by demo pages — keep it small (simplified geometry, not full-resolution).
- SVG brand files (`x-gis-logo-dark.svg`, `x-gis-logo-light.svg`, `og.svg`) are referenced directly from Astro layout/head components; renaming them requires updating those references.

### Testing Requirements
No automated tests. Verify visually: thumbnails appear in the gallery at `/examples`, map embeds load `land.geojson` without errors in dev, and logos render correctly in nav/OG meta tags.

### Common Patterns
- Thumbnails: JPEG format, named `{demo-id}.jpg`, stored in `thumbnails/`.
- When adding a new demo, add both a `Demo` entry in `gallery-demos.ts` and a matching `thumbnails/{id}.jpg`.

## Dependencies

### Internal
- `site/src/content/gallery-demos.ts` — `id` fields determine expected thumbnail filenames
- Astro layout/head components in `site/src/` reference `og.svg` and the logo SVGs by URL path

### External
None

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
