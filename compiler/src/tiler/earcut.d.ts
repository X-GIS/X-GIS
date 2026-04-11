declare module 'earcut' {
  function earcut(
    vertices: number[],
    holes?: number[],
    dimensions?: number
  ): number[]
  export default earcut
}
