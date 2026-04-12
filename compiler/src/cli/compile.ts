#!/usr/bin/env bun
// ═══ xgisc — X-GIS Compiler CLI ═══

import { readFileSync, writeFileSync } from 'fs'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { serializeXGB, type BinaryScene } from '../binary/format'
import { lower } from '../ir/lower'
import { compileGeoJSONToTiles } from '../tiler/vector-tiler'
import { serializeXGVT } from '../tiler/tile-format'

function main() {
  const args = process.argv.slice(2)

  if (args.length === 0 || args[0] === '--help') {
    console.log(`
xgisc — X-GIS Compiler

Usage:
  xgisc compile <input.xgis> [-o <output.xgb>]   Compile to binary
  xgisc parse <input.xgis>                        Parse and print AST (debug)
  xgisc ir <input.xgis>                           Lower to IR and print (debug)
  xgisc tile <input.geojson> [-o <output.xgvt>]   Tile GeoJSON to vector tiles

Example:
  xgisc compile hello.xgis -o hello.xgb
  xgisc compile hello.xgis                        → hello.xgb (auto name)
`)
    return
  }

  const command = args[0]

  if (command === 'compile') {
    const inputPath = args[1]
    if (!inputPath) {
      console.error('Error: No input file specified')
      process.exit(1)
    }

    const outputPath = args.indexOf('-o') >= 0
      ? args[args.indexOf('-o') + 1]
      : inputPath.replace(/\.xgis$/, '.xgb')

    compile(inputPath, outputPath)
  } else if (command === 'parse') {
    const inputPath = args[1]
    if (!inputPath) {
      console.error('Error: No input file specified')
      process.exit(1)
    }
    parseDebug(inputPath)
  } else if (command === 'tile') {
    const inputPath = args[1]
    if (!inputPath) {
      console.error('Error: No input file specified')
      process.exit(1)
    }
    const outputPath = args.indexOf('-o') >= 0
      ? args[args.indexOf('-o') + 1]
      : inputPath.replace(/\.geojson$/, '.xgvt')
    tileCommand(inputPath, outputPath)
  } else if (command === 'ir') {
    const inputPath = args[1]
    if (!inputPath) {
      console.error('Error: No input file specified')
      process.exit(1)
    }
    irDebug(inputPath)
  } else {
    console.error(`Unknown command: ${command}`)
    process.exit(1)
  }
}

function compile(inputPath: string, outputPath: string) {
  const source = readFileSync(inputPath, 'utf-8')

  // Parse
  const tokens = new Lexer(source).tokenize()
  const ast = new Parser(tokens).parse()

  // Extract commands (same logic as interpreter, but standalone)
  const scene: BinaryScene = { loads: [], shows: [] }

  for (const stmt of ast.body) {
    if (stmt.kind === 'LetStatement' && stmt.value.kind === 'FnCall') {
      const callee = stmt.value.callee
      if (callee.kind === 'Identifier' && callee.name === 'load') {
        const arg = stmt.value.args[0]
        if (arg?.kind === 'StringLiteral') {
          scene.loads.push({ name: stmt.name, url: arg.value })
        }
      }
    } else if (stmt.kind === 'ShowStatement') {
      const targetName = stmt.target.kind === 'Identifier' ? stmt.target.name : ''
      let fill: string | null = null
      let stroke: string | null = null
      let strokeWidth = 1

      for (const prop of stmt.block.properties) {
        if (prop.name === 'fill' && prop.values[0]?.kind === 'ColorLiteral') {
          fill = prop.values[0].value
        } else if (prop.name === 'stroke') {
          if (prop.values[0]?.kind === 'ColorLiteral') stroke = prop.values[0].value
          if (prop.values[1]?.kind === 'NumberLiteral') strokeWidth = prop.values[1].value
        }
      }

      scene.shows.push({ targetName, fill, stroke, strokeWidth })
    }
  }

  // Serialize
  const binary = serializeXGB(scene)
  writeFileSync(outputPath, Buffer.from(binary))

  const srcSize = source.length
  const binSize = binary.byteLength
  const ratio = ((1 - binSize / srcSize) * 100).toFixed(0)

  console.log(`Compiled: ${inputPath} → ${outputPath}`)
  console.log(`  Source: ${srcSize} bytes`)
  console.log(`  Binary: ${binSize} bytes (${ratio}% smaller)`)
  console.log(`  Loads:  ${scene.loads.length}`)
  console.log(`  Shows:  ${scene.shows.length}`)
}

function parseDebug(inputPath: string) {
  const source = readFileSync(inputPath, 'utf-8')
  const tokens = new Lexer(source).tokenize()
  const ast = new Parser(tokens).parse()
  console.log(JSON.stringify(ast, null, 2))
}

function tileCommand(inputPath: string, outputPath: string) {
  const source = readFileSync(inputPath, 'utf-8')
  const geojson = JSON.parse(source)

  const includeGPU = process.argv.includes('--gpu')
  console.log(`Tiling ${inputPath} (${(source.length / 1024).toFixed(0)} KB, ${geojson.features?.length ?? 0} features)${includeGPU ? ' [GPU-ready]' : ''}...`)

  const start = performance.now()
  const tileSet = compileGeoJSONToTiles(geojson, { minZoom: 0 })  // maxZoom auto-detected
  const tileElapsed = (performance.now() - start).toFixed(0)
  console.log(`  Tiling done in ${tileElapsed}ms`)

  const serStart = performance.now()
  const binary = serializeXGVT(tileSet, { includeGPUReady: includeGPU })
  const serElapsed = (performance.now() - serStart).toFixed(0)
  console.log(`  Serialization done in ${serElapsed}ms`)

  const elapsed = (performance.now() - start).toFixed(0)

  writeFileSync(outputPath, Buffer.from(binary))

  const totalTiles = tileSet.levels.reduce((sum, l) => sum + l.tiles.size, 0)
  const srcSize = source.length
  const binSize = binary.byteLength

  console.log(`Tiled: ${inputPath} → ${outputPath}`)
  console.log(`  Source:  ${(srcSize / 1024).toFixed(1)} KB (${geojson.features?.length ?? 0} features)`)
  console.log(`  Binary:  ${(binSize / 1024).toFixed(1)} KB`)
  console.log(`  Levels:  ${tileSet.levels.length} (zoom ${tileSet.levels[0]?.zoom ?? 0}~${tileSet.levels[tileSet.levels.length - 1]?.zoom ?? 0})`)
  console.log(`  Tiles:   ${totalTiles} (sparse)`)
  console.log(`  Time:    ${elapsed}ms`)
}

function irDebug(inputPath: string) {
  const source = readFileSync(inputPath, 'utf-8')
  const tokens = new Lexer(source).tokenize()
  const ast = new Parser(tokens).parse()
  const scene = lower(ast)
  console.log(JSON.stringify(scene, null, 2))
}

main()
