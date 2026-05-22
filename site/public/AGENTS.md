<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# site/public/

## Purpose
Static assets served verbatim by Astro at the root URL path. Contains the GeoJSON sample dataset used by the interactive map examples on the site and JPEG thumbnails for the examples gallery cards.

## Key Files
| File | Description |
|------|-------------|
| `data/land.geojson` | Simplified world land polygons GeoJSON used by live map embeds on the site |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `data/` | GeoJSON datasets for live demos |
| `thumbnails/` | JPEG preview images for the examples gallery cards (filenames match demo `id` fields in `src/content/gallery-demos.ts`) |

## For AI Agents

### Working In This Directory
- Files here are copied to `dist/` at build time with no processing. Do not add TypeScript or Astro files.
- Gallery thumbnail filenames must match the `id` field of each `Demo` entry in `src/content/gallery-demos.ts`. Missing thumbnails cause gallery cards to render in text-only fallback mode (controlled by the `noThumb` flag on the demo entry).
- `land.geojson` is loaded at runtime by pages that embed a live XGISMap — keep it small (simplified, not full-resolution).

### Testing Requirements
- No automated tests. Verify visually that thumbnails appear in the gallery (`/examples`) and that map embeds load the GeoJSON successfully in dev.

### Common Patterns
- JPEG format for thumbnails (`.jpg`), named exactly as `{demo-id}.jpg`.

## Dependencies

### Internal
- `src/content/gallery-demos.ts` — `id` fields determine expected thumbnail filenames

### External
None

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
