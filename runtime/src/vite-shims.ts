// Ambient module shims for Vite's import-query suffixes.
//
// NOTE: this lives in a `.ts` file (not `.d.ts`) on purpose — `.gitignore`
// treats every `runtime/src/**/*.d.ts` as a build artifact and excludes it,
// so a hand-authored `.d.ts` here would not be version-controlled. A plain
// global `.ts` file (no top-level import/export) carries the ambient
// `declare module` just the same and is tracked normally.

// A module imported as `./foo.ts?worker` resolves at build time to a bundled
// Worker constructor (Vite's worker plugin). TypeScript has no built-in
// knowledge of the query suffix, so without this it errors with TS2307. The
// constructor accepts Vite's optional `{ name }` options object.
declare module '*?worker' {
  const workerConstructor: new (options?: { name?: string }) => Worker
  export default workerConstructor
}
