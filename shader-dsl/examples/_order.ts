// ═══ The curated example ORDER — the one hand-written half of the registry (#1716) ═══
//
// A directory scan enumerates the example modules. It cannot know that cartographic
// examples lead because the site is a map site, or that the compute example belongs last.
// That grouping is editorial, and it is the same thing #1700 says about the reference
// page's grouping: real value a generator does not produce.
//
// So this is the input, and `index.ts` is the output. Before #1716 the ordering lived in
// `index.ts` TWICE (the re-export block and the `examples` array) alongside 35 imports, and
// adding an example meant editing three places — the issue's literal complaint. Now it is
// one list of ids, and `scripts/gen-example-registry.ts` derives the rest.
//
// An id here that names no file, or a file no id here names, is a build failure with both
// directions reported at once (`buildRegistry`). That check is why this list can be trusted
// as the authority rather than drifting into a stale second copy of the directory.
//
// No filesystem access and no imports: this is data the browser build can carry, and it is
// read by a root-level script, so it must stay `shader-dsl/`-self-contained.

/** Every example id, in the order the site and the CLI printer present them:
 *  cartographic first, then generic, then compute. */
export const CURATED_ORDER: readonly string[] = [
  // Cartographic — they belong on a map site, so they lead.
  'graticule',
  'hillshade',
  'fp64-deep-zoom',
  'fp64-checker-plane',
  'fp64-loran',
  'fp64-mercator-tiles',
  'fp64-rtc',
  // Generic.
  'color-ramp',
  'discard-cutout',
  'plasma',
  'voronoi',
  'julia',
  'mandelbrot',
  'fbm-clouds',
  'domain-warp',
  'raymarch-sphere',
  'raymarch-boxes',
  'tunnel',
  'metaballs',
  'ocean',
  'starfield',
  'truchet',
  'kaleidoscope',
  'heart',
  'fp64-mandelbrot',
  'fp64-julia',
  'fp64-burning-ship',
  'fp64-newton',
  'fp64-mandelbrot-de',
  'fp64-clock',
  'fp64-cancellation',
  'fp64-sine-sweep',
  'gradient',
  'override-quality',
  'texture-array-lod',
  // Compute, last.
  'compute-reduction',
]
