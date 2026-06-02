// Thin re-export so the Oracle-B spec can `import('/render-verify/
// pixelmatch-browser.ts')` in-page and let Vite resolve the bare
// 'pixelmatch' specifier through its module graph (a raw
// `import('/node_modules/...')` path is brittle across the bun/Vite
// dep-optimization layout).
export { default as pixelmatch } from 'pixelmatch'
