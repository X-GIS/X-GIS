// Ambient module shim for Vite's `?worker` import-query suffix.
//
// A module imported as `./foo.ts?worker` resolves at build time to a bundled
// Worker constructor (Vite's worker plugin). TypeScript has no built-in
// knowledge of the query suffix, so without this the worker-pool modules
// (workers/geojson-compile-pool.ts, workers/mvt-worker-pool.ts) error with
// TS2307. The constructor accepts Vite's optional `{ name }` options object.
//
// Mirrors runtime/src/vite-shims.ts. Unlike runtime/src (whose `*.d.ts` are
// gitignored as build artifacts), `data/src/**/*.d.ts` are tracked — see
// data/src/earcut.d.ts — so a hand-authored `.d.ts` is the right form here and
// is picked up by data/tsconfig.json's `include: ["src/**/*.ts"]`.
declare module '*?worker' {
  const workerConstructor: new (options?: { name?: string }) => Worker
  export default workerConstructor
}
