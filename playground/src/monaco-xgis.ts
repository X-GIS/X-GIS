// ═══ Monaco Editor — X-GIS Language Support ═══

import * as monaco from 'monaco-editor'
import { Lexer, Parser } from '@xgis/compiler'

// ═══ Language Registration ═══

export function registerXGISLanguage() {
  monaco.languages.register({ id: 'xgis', extensions: ['.xgis'] })

  // ── Language configuration (comments, brackets, auto-close) ──
  monaco.languages.setLanguageConfiguration('xgis', {
    comments: {
      lineComment: '//',
      blockComment: ['/*', '*/'],
    },
    brackets: [
      ['{', '}'],
      ['[', ']'],
      ['(', ')'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
      { open: '/*', close: ' */' },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
    ],
    indentationRules: {
      increaseIndentPattern: /\{[^}]*$/,
      decreaseIndentPattern: /^\s*\}/,
    },
    onEnterRules: [
      { beforeText: /\{\s*$/, action: { indentAction: monaco.languages.IndentAction.Indent } },
    ],
  })

  // ── Monarch tokenizer ──
  monaco.languages.setMonarchTokensProvider('xgis', {
    keywords: [
      'source', 'layer', 'style', 'symbol', 'preset',
      'import', 'from', 'export',
      'if', 'else', 'for', 'in', 'return',
      'let', 'fn', 'show', 'true', 'false',
    ],
    properties: [
      'type', 'url', 'fill', 'stroke', 'opacity', 'size',
      'stroke-width', 'z-order', 'filter', 'projection',
      'visible', 'hidden', 'flat', 'billboard', 'shape',
    ],
    functions: [
      'match', 'categorical', 'gradient', 'scale',
      'sqrt', 'abs', 'sin', 'cos', 'tan', 'clamp', 'min', 'max',
      'floor', 'ceil', 'round', 'log', 'pow',
    ],
    tokenizer: {
      root: [
        [/\/\*/, 'comment', '@comment'],
        [/\/\/.*$/, 'comment'],
        [/"[^"]*"/, 'string'],
        [/#[0-9a-fA-F]{3,8}\b/, 'number.hex'],
        [/\|/, 'delimiter.pipe'],
        [/\.[a-zA-Z_]\w*/, 'variable.field'],
        [/[a-zA-Z_][\w]*(?:-[a-zA-Z][\w]*)*/, {
          cases: {
            '@keywords': 'keyword',
            '@properties': 'attribute.name',
            '@functions': 'support.function',
            '@default': 'identifier',
          },
        }],
        [/\d+(\.\d+)?(px|m|km|nm|deg|ms|s)?/, 'number'],
        [/\.\d+/, 'number'],
        [/[{}()\[\]]/, 'delimiter.bracket'],
        [/[<>=!&|+\-*\/]+/, 'operator'],
        [/:/, 'delimiter'],
        [/,/, 'delimiter.comma'],
        [/\s+/, 'white'],
      ],
      comment: [
        [/[^/*]+/, 'comment'],
        [/\*\//, 'comment', '@pop'],
        [/[/*]/, 'comment'],
      ],
    },
  })

  // ── Completion provider ──
  monaco.languages.registerCompletionItemProvider('xgis', {
    triggerCharacters: ['.', '-', '|', ' ', ':'],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position)
      const range: monaco.IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      }

      const lineContent = model.getLineContent(position.lineNumber)
      const textBefore = lineContent.substring(0, position.column - 1)
      const trimmed = textBefore.trimStart()
      const suggestions: monaco.languages.CompletionItem[] = []

      // Context: inside { } block?
      const fullText = model.getValue()
      const offset = model.getOffsetAt(position)
      const context = getBlockContext(fullText, offset)

      // After . → field access (highest priority — works inside expressions, filters, utilities)
      if (textBefore.endsWith('.')) {
        // Resolve the cursor's enclosing `layer { ... }` block and
        // pick its `sourceLayer:` value so the suggestions are
        // filtered to fields THAT layer actually carries (PMTiles
        // archives ship per-layer schemas via vector_layers metadata).
        // Falls back to the flat union when no enclosing layer is
        // found or the layer has no sourceLayer set.
        const sourceLayerForCursor = findSourceLayerAtOffset(fullText, offset)
        for (const f of getFieldCompletions(sourceLayerForCursor)) {
          suggestions.push({
            label: f.name,
            kind: monaco.languages.CompletionItemKind.Field,
            insertText: f.name,
            detail: f.detail,
            documentation: f.doc,
            range,
          })
        }
        return { suggestions }
      }

      // After | → utility completions
      if (trimmed.includes('|')) {
        const afterPipe = trimmed.substring(trimmed.lastIndexOf('|') + 1).trim()

        // After fill- or stroke- → color completions
        if (/(?:fill|stroke)-\w*$/.test(afterPipe)) {
          const prefix = afterPipe.match(/(fill|stroke)-/)?.[1] ?? 'fill'
          for (const c of COLORS) {
            for (const s of SHADES) {
              suggestions.push({
                label: `${prefix}-${c}-${s}`,
                kind: monaco.languages.CompletionItemKind.Color,
                insertText: `${c}-${s}`,
                detail: `Tailwind ${c}-${s}`,
                documentation: DOCS.color(c, s),
                range,
                sortText: `0-${c}-${s.padStart(3, '0')}`,
              })
            }
          }
          return { suggestions }
        }

        // After shape- → shape completions
        if (/shape-\w*$/.test(afterPipe)) {
          for (const s of SHAPE_COMPLETIONS) {
            suggestions.push({ ...s, range, kind: monaco.languages.CompletionItemKind.Enum } as monaco.languages.CompletionItem)
          }
          return { suggestions }
        }

        // General utility completions
        for (const u of UTILITY_COMPLETIONS) {
          suggestions.push({
            ...u,
            kind: u.kind ?? monaco.languages.CompletionItemKind.Property,
            range,
          } as monaco.languages.CompletionItem)
        }
        return { suggestions }
      }

      // After type: → source type completions
      if (/type:\s*$/.test(trimmed)) {
        for (const t of ['geojson', 'raster']) {
          suggestions.push({
            label: t, kind: monaco.languages.CompletionItemKind.EnumMember,
            insertText: t, detail: `Source type: ${t}`, range,
          })
        }
        return { suggestions }
      }

      // After projection: or projection- → projection completions
      if (/projection[:\-]\s*\w*$/.test(trimmed)) {
        for (const p of PROJECTIONS) {
          suggestions.push({
            label: p, kind: monaco.languages.CompletionItemKind.EnumMember,
            insertText: p, detail: `Map projection`, range,
          })
        }
        return { suggestions }
      }

      // Inside source {} block → source properties
      if (context === 'source') {
        for (const p of SOURCE_PROPS) {
          suggestions.push({
            ...p, kind: monaco.languages.CompletionItemKind.Property,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
          })
        }
        return { suggestions }
      }

      // Inside layer {} block → layer properties
      if (context === 'layer') {
        for (const p of LAYER_PROPS) {
          suggestions.push({
            ...p, kind: monaco.languages.CompletionItemKind.Property,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
          })
        }
        return { suggestions }
      }

      // Top-level → block completions
      for (const kw of BLOCK_COMPLETIONS) {
        suggestions.push({
          ...kw,
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
        })
      }

      return { suggestions }
    },
  })

  // ── Go-to-definition (Ctrl+click on source references) ──
  monaco.languages.registerDefinitionProvider('xgis', {
    provideDefinition(model, position) {
      const word = model.getWordAtPosition(position)
      if (!word) return null
      const full = model.getValue()
      // Find `source <word> {` or `layer <word> {` blocks in the same file
      const defRe = new RegExp(`\\b(?:source|layer|style|symbol|preset)\\s+${escapeRegex(word.word)}\\b`, 'g')
      let m: RegExpExecArray | null
      while ((m = defRe.exec(full)) !== null) {
        const pos = model.getPositionAt(m.index)
        return {
          uri: model.uri,
          range: new monaco.Range(pos.lineNumber, 1, pos.lineNumber, model.getLineMaxColumn(pos.lineNumber)),
        }
      }
      return null
    },
  })

  // ── Document symbols (outline panel: every source/layer/style/symbol block) ──
  monaco.languages.registerDocumentSymbolProvider('xgis', {
    provideDocumentSymbols(model) {
      const symbols: monaco.languages.DocumentSymbol[] = []
      const text = model.getValue()
      const re = /\b(source|layer|style|symbol|preset)\s+([A-Za-z_][\w]*)\s*\{/g
      let m: RegExpExecArray | null
      const kindMap: Record<string, monaco.languages.SymbolKind> = {
        source: monaco.languages.SymbolKind.Class,
        layer: monaco.languages.SymbolKind.Method,
        style: monaco.languages.SymbolKind.Interface,
        symbol: monaco.languages.SymbolKind.Constructor,
        preset: monaco.languages.SymbolKind.Property,
      }
      while ((m = re.exec(text)) !== null) {
        const start = model.getPositionAt(m.index)
        // Scan forward to matching closing brace
        let depth = 0
        let end = m.index + m[0].length
        for (let i = m.index + m[0].length - 1; i < text.length; i++) {
          if (text[i] === '{') depth++
          else if (text[i] === '}') { depth--; if (depth === 0) { end = i + 1; break } }
        }
        const endPos = model.getPositionAt(end)
        const range = new monaco.Range(start.lineNumber, 1, endPos.lineNumber, model.getLineMaxColumn(endPos.lineNumber))
        const nameRange = new monaco.Range(start.lineNumber, 1, start.lineNumber, model.getLineMaxColumn(start.lineNumber))
        symbols.push({
          name: m[2],
          detail: m[1],
          kind: kindMap[m[1]] ?? monaco.languages.SymbolKind.Object,
          range,
          selectionRange: nameRange,
          tags: [],
        })
      }
      return symbols
    },
  })

  // ── Hover provider ──
  monaco.languages.registerHoverProvider('xgis', {
    provideHover(model, position) {
      const word = model.getWordAtPosition(position)
      if (!word) return null

      // Check line for context (utility line?)
      const line = model.getLineContent(position.lineNumber)
      const text = word.word

      // Check full hyphenated token (e.g., fill-red-500)
      const before = line.substring(0, word.endColumn - 1)
      const hyphenatedMatch = before.match(/([\w-]+)$/)
      const fullToken = hyphenatedMatch?.[1] ?? text

      const hover = HOVER_DOCS[text] ?? HOVER_DOCS[fullToken]
      if (hover) {
        return {
          range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
          contents: [{ value: hover }],
        }
      }

      // Color hover: fill-{color}-{shade}
      const colorMatch = fullToken.match(/^(?:fill|stroke)-([\w]+-\d+)$/)
      if (colorMatch) {
        return {
          range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
          contents: [{ value: `**Tailwind Color**: \`${colorMatch[1]}\`` }],
        }
      }

      // Field access hover
      if (text.startsWith('.') || line.charAt(word.startColumn - 2) === '.') {
        return {
          range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
          contents: [{ value: `**Field Access**: \`.${text}\`\n\nReads property \`${text}\` from each feature's properties.` }],
        }
      }

      return null
    },
  })
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ═══ Context Detection ═══

function getBlockContext(text: string, offset: number): 'source' | 'layer' | 'style' | 'symbol' | null {
  let depth = 0
  let lastBlock: string | null = null

  for (let i = offset - 1; i >= 0; i--) {
    if (text[i] === '}') depth++
    else if (text[i] === '{') {
      if (depth === 0) {
        // Find the keyword before this brace
        const before = text.substring(Math.max(0, i - 40), i).trim()
        const match = before.match(/\b(source|layer|style|symbol)\s+\w+\s*$/)
        if (match) lastBlock = match[1]
        break
      }
      depth--
    }
  }
  return lastBlock as 'source' | 'layer' | 'style' | 'symbol' | null
}

// ═══ Completion Data ═══

const BLOCK_COMPLETIONS = [
  { label: 'source', insertText: 'source ${1:name} {\n  type: ${2|geojson,raster|}\n  url: "${3}"\n}', detail: 'Data source block', documentation: { value: 'Defines a data source.\n\n```xgis\nsource countries {\n  type: geojson\n  url: "countries.geojson"\n}\n```' } },
  { label: 'layer', insertText: 'layer ${1:name} {\n  source: ${2}\n  | ${3:fill-sky-500}\n}', detail: 'Render layer block', documentation: { value: 'Defines a render layer with styling.\n\n```xgis\nlayer borders {\n  source: countries\n  | fill-slate-800 stroke-cyan-400 stroke-1\n}\n```' } },
  { label: 'style', insertText: 'style ${1:name} {\n  fill: ${2}\n  stroke: ${3}\n  stroke-width: ${4:1}\n}', detail: 'Named style block', documentation: { value: 'Reusable named style.\n\n```xgis\nstyle dark {\n  fill: slate-900\n  stroke: slate-700\n  stroke-width: 0.5\n}\n```' } },
  { label: 'symbol', insertText: 'symbol ${1:name} {\n  path "${2:M 0 -1 L 0.5 0.5 L 0 0.2 L -0.5 0.5 Z}"\n}', detail: 'Custom shape symbol', documentation: { value: 'Define a custom SDF shape via SVG path commands.\n\n```xgis\nsymbol arrow {\n  path "M 0 -1 L 0.4 0.4 L 0 0.1 L -0.4 0.4 Z"\n}\n```\nUse with `| shape-arrow`' } },
]

const SOURCE_PROPS = [
  { label: 'type', insertText: 'type: ${1|geojson,raster|}', detail: 'Source type (geojson or raster)' },
  { label: 'url', insertText: 'url: "${1}"', detail: 'Data URL (relative or absolute)' },
]

const LAYER_PROPS = [
  { label: 'source', insertText: 'source: ${1}', detail: 'Reference to a source block' },
  { label: 'filter', insertText: 'filter: .${1} ${2|>,<,==,!=,>=,<=|} ${3}', detail: 'Per-feature filter expression' },
  { label: 'style', insertText: 'style: ${1}', detail: 'Reference to a named style' },
  { label: 'z-order', insertText: 'z-order: ${1:0}', detail: 'Layer draw order (higher = on top)' },
  { label: 'fill', insertText: 'fill: ${1}', detail: 'Fill color (CSS property syntax)' },
  { label: 'stroke', insertText: 'stroke: ${1}', detail: 'Stroke color' },
  { label: 'stroke-width', insertText: 'stroke-width: ${1:1}', detail: 'Stroke width in pixels' },
  { label: 'opacity', insertText: 'opacity: ${1:1.0}', detail: 'Layer opacity (0-1)' },
  { label: '|', insertText: '| ${1}', detail: 'Utility line (Tailwind-style)' },
]

const COLORS = [
  'slate', 'gray', 'zinc', 'neutral', 'stone',
  'red', 'orange', 'amber', 'yellow', 'lime',
  'green', 'emerald', 'teal', 'cyan', 'sky',
  'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose',
]
const SHADES = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950']

const PROJECTIONS = ['mercator', 'equirectangular', 'natural-earth', 'orthographic', 'azimuthal-equidistant', 'stereographic']

const UTILITY_COMPLETIONS: Partial<monaco.languages.CompletionItem>[] = [
  { label: 'fill-', insertText: 'fill-${1}', detail: 'Fill color', documentation: { value: '`fill-{color}-{shade}` — Tailwind fill color\n\nExamples: `fill-red-500`, `fill-sky-300`' } },
  { label: 'stroke-', insertText: 'stroke-${1}', detail: 'Stroke color or width', documentation: { value: '`stroke-{color}-{shade}` — Stroke color\n`stroke-{N}` — Stroke width in px\n\nExamples: `stroke-cyan-400`, `stroke-2`' } },
  // Stroke width presets
  { label: 'stroke-1', insertText: 'stroke-1', detail: '1px stroke width', kind: monaco.languages.CompletionItemKind.Value },
  { label: 'stroke-2', insertText: 'stroke-2', detail: '2px stroke width', kind: monaco.languages.CompletionItemKind.Value },
  { label: 'stroke-3', insertText: 'stroke-3', detail: '3px stroke width', kind: monaco.languages.CompletionItemKind.Value },
  { label: 'stroke-4', insertText: 'stroke-4', detail: '4px stroke width', kind: monaco.languages.CompletionItemKind.Value },
  { label: 'stroke-5', insertText: 'stroke-5', detail: '5px stroke width', kind: monaco.languages.CompletionItemKind.Value },
  { label: 'stroke-6', insertText: 'stroke-6', detail: '6px stroke width', kind: monaco.languages.CompletionItemKind.Value },
  { label: 'stroke-8', insertText: 'stroke-8', detail: '8px stroke width', kind: monaco.languages.CompletionItemKind.Value },
  { label: 'stroke-10', insertText: 'stroke-10', detail: '10px stroke width', kind: monaco.languages.CompletionItemKind.Value },
  // Line caps
  { label: 'stroke-round-cap', insertText: 'stroke-round-cap', detail: 'Round line cap (default)', documentation: { value: 'Round endpoint caps — draws a circle at each open line end. Default since a recent release.' } },
  { label: 'stroke-butt-cap', insertText: 'stroke-butt-cap', detail: 'Butt (flat) line cap', documentation: { value: 'Flat endpoint — terminates exactly at the vertex with no overshoot.' } },
  { label: 'stroke-square-cap', insertText: 'stroke-square-cap', detail: 'Square line cap', documentation: { value: 'Flat endpoint extended by half_width past the vertex.' } },
  { label: 'stroke-arrow-cap', insertText: 'stroke-arrow-cap', detail: 'Arrow line cap', documentation: { value: 'Tapered arrow-head at open ends. Only applies at chain termini (non-joined vertices).' } },
  // Line joins
  { label: 'stroke-round-join', insertText: 'stroke-round-join', detail: 'Round line join (default)', documentation: { value: 'Rounded corners via circular SDF — stable at any angle. Default since a recent release.' } },
  { label: 'stroke-miter-join', insertText: 'stroke-miter-join', detail: 'Miter line join', documentation: { value: 'Sharp corners extended to the miter tip. Falls back to bevel if the tip exceeds `miter-limit` × half-width.' } },
  { label: 'stroke-bevel-join', insertText: 'stroke-bevel-join', detail: 'Bevel line join', documentation: { value: 'Corners clipped flat at the intersection of the two strokes.' } },
  { label: 'stroke-miter-limit-', insertText: 'stroke-miter-limit-${1:4}', detail: 'Miter limit ratio', documentation: { value: '`stroke-miter-limit-{N}` — maximum miter-extension-to-width ratio before falling back to bevel. Default `4`.' } },
  // Lateral parallel offset
  { label: 'stroke-offset-', insertText: 'stroke-offset-${1:5}', detail: 'Lateral parallel offset (px, +left)', documentation: { value: '`stroke-offset-N` — shift the stroke perpendicular to the line by `N` pixels.\n\nDefault direction = LEFT of travel. Use `stroke-offset-right-N` for the right side, or `stroke-offset-left-N` for explicit left.\n\nWorks correctly across joins — adjacent segments share their offset miter vertex.' } },
  { label: 'stroke-offset-left-', insertText: 'stroke-offset-left-${1:5}', detail: 'Offset to the left of travel (px)', kind: monaco.languages.CompletionItemKind.Value },
  { label: 'stroke-offset-right-', insertText: 'stroke-offset-right-${1:5}', detail: 'Offset to the right of travel (px)', kind: monaco.languages.CompletionItemKind.Value },
  // GDI+ alignment sugar
  { label: 'stroke-center', insertText: 'stroke-center', detail: 'Center alignment (default)', documentation: { value: 'Centerline-aligned stroke — half on each side of the original geometry.' } },
  { label: 'stroke-inset', insertText: 'stroke-inset', detail: 'Inset alignment (left of travel)', documentation: { value: 'Shift the stroke INWARD by half the stroke width.\n\nFor CCW polygon rings the inside of the polygon is on the LEFT of travel, so `stroke-inset` keeps the stroke entirely inside the polygon.\n\nCombines additively with explicit `stroke-offset-N`. Resolved at runtime against the layer width.' } },
  { label: 'stroke-outset', insertText: 'stroke-outset', detail: 'Outset alignment (right of travel)', documentation: { value: 'Shift the stroke OUTWARD by half the stroke width.\n\nFor CCW polygon rings this places the stroke entirely outside the polygon. Use `stroke-inset` for the opposite side.' } },
  // Dash / pattern
  { label: 'stroke-dasharray-', insertText: 'stroke-dasharray-${1:20}-${2:10}', detail: 'Dash array (px)', documentation: { value: '`stroke-dasharray-N-M[-N-M...]` — alternating on/off lengths in pixels.\n\n```xgis\n| stroke-dasharray-20-10\n| stroke-dasharray-4-2-1-2\n```' } },
  { label: 'stroke-dashoffset-', insertText: 'stroke-dashoffset-${1:0}', detail: 'Dash phase offset (px)' },
  { label: 'stroke-pattern-', insertText: 'stroke-pattern-${1}', detail: 'Repeating SDF symbol along the line', documentation: { value: '`stroke-pattern-{shape}` plus `stroke-pattern-spacing-{N}px`, `stroke-pattern-size-{N}px`, `stroke-pattern-offset-{N}px`.\n\nRefers to a symbol defined in this file or imported.' } },
  // Color/opacity
  { label: 'opacity-', insertText: 'opacity-${1}', detail: 'Opacity (0-100)', documentation: { value: '`opacity-{N}` — Layer opacity\n\n`opacity-50` = 50%, `opacity-0.8` = 80%' } },
  { label: 'opacity-25', insertText: 'opacity-25', detail: '25% opacity', kind: monaco.languages.CompletionItemKind.Value },
  { label: 'opacity-50', insertText: 'opacity-50', detail: '50% opacity', kind: monaco.languages.CompletionItemKind.Value },
  { label: 'opacity-75', insertText: 'opacity-75', detail: '75% opacity', kind: monaco.languages.CompletionItemKind.Value },
  { label: 'opacity-100', insertText: 'opacity-100', detail: '100% opacity', kind: monaco.languages.CompletionItemKind.Value },
  // Point sizing
  { label: 'size-', insertText: 'size-${1}', detail: 'Point size', documentation: { value: '`size-{N}{unit}` — Point radius\n\nUnits: `px` (default), `m`, `km`, `nm`, `deg`\n\nData-driven: `size-[sqrt(.pop) / 80]km`' } },
  { label: 'size-4', insertText: 'size-4', detail: '4px point radius', kind: monaco.languages.CompletionItemKind.Value },
  { label: 'size-8', insertText: 'size-8', detail: '8px point radius', kind: monaco.languages.CompletionItemKind.Value },
  { label: 'size-12', insertText: 'size-12', detail: '12px point radius', kind: monaco.languages.CompletionItemKind.Value },
  { label: 'size-16', insertText: 'size-16', detail: '16px point radius', kind: monaco.languages.CompletionItemKind.Value },
  // Point shape / anchor / billboard
  { label: 'shape-', insertText: 'shape-${1}', detail: 'Point shape', documentation: { value: 'Built-in: `circle` (default), `star`, `diamond`, `triangle`, `square`, `cross`, `hexagon`, `pentagon`\n\nCustom: define with `symbol` block' } },
  { label: 'anchor-center', insertText: 'anchor-center', detail: 'Anchor point at center', documentation: { value: 'Point geometry anchored at its center (default).' } },
  { label: 'anchor-bottom', insertText: 'anchor-bottom', detail: 'Anchor point at bottom', documentation: { value: 'Point geometry anchored at the bottom — common for map pins so the tip sits exactly on the coordinate.' } },
  { label: 'anchor-top', insertText: 'anchor-top', detail: 'Anchor point at top' },
  { label: 'flat', insertText: 'flat', detail: 'Flat on ground', documentation: { value: 'Render points flat on the ground plane (world-space).\nSize scales with zoom.' } },
  { label: 'billboard', insertText: 'billboard', detail: 'Faces camera', documentation: { value: 'Render points always facing the camera (screen-space).\nSize is constant in pixels. **(default)**' } },
  { label: 'visible', insertText: 'visible', detail: 'Show layer' },
  { label: 'hidden', insertText: 'hidden', detail: 'Hide layer' },
  { label: 'fill gradient()', insertText: 'fill gradient(.${1:field}, ${2:0}, ${3:100}, ${4:blue-500}, ${5:red-500})', detail: 'Gradient color by data', documentation: { value: '`fill gradient(field, min, max, lowColor, highColor)`\n\nLinear interpolation between two colors based on field value.\n\n```xgis\n| fill gradient(.GDP_MD_EST, 0, 5000000, sky-300, rose-600)\n```' }, kind: monaco.languages.CompletionItemKind.Function },
  { label: 'fill match()', insertText: 'fill match(.${1:field}) {\n    "${2:value}" -> ${3:red-500},\n    _ -> ${4:gray-400}\n  }', detail: 'Categorical color by data', documentation: { value: '`fill match(field) { "value" -> color, _ -> fallback }`\n\n```xgis\n| fill match(.CONTINENT) {\n    "Asia" -> rose-500,\n    "Europe" -> sky-500,\n    _ -> gray-400\n  }\n```' }, kind: monaco.languages.CompletionItemKind.Function },
  { label: 'fill categorical()', insertText: 'fill categorical(.${1:field})', detail: 'Auto-assign 20 colors', documentation: { value: '`fill categorical(field)` — Auto-assign colors from a 20-color palette based on unique field values.' }, kind: monaco.languages.CompletionItemKind.Function },
]

const SHAPE_COMPLETIONS: Partial<monaco.languages.CompletionItem>[] = [
  { label: 'star', insertText: 'star', detail: '5-pointed star' },
  { label: 'diamond', insertText: 'diamond', detail: 'Diamond/rhombus' },
  { label: 'triangle', insertText: 'triangle', detail: 'Equilateral triangle' },
  { label: 'square', insertText: 'square', detail: 'Square' },
  { label: 'cross', insertText: 'cross', detail: 'Plus/cross' },
  { label: 'hexagon', insertText: 'hexagon', detail: 'Regular hexagon' },
  { label: 'pentagon', insertText: 'pentagon', detail: 'Regular pentagon' },
  { label: 'circle', insertText: 'circle', detail: 'Circle (default, analytical SDF)' },
]

/** Fallback completions shown before the editor has a chance to fetch
 *  an actual source schema. Just a tiny generic seed — `name` shows
 *  up everywhere, the rest is intentionally empty so the user knows
 *  the real answers come from `discoverFields()`. PMTiles archives
 *  surface their `vector_layers[*].fields` schema; GeoJSON sources
 *  surface every property key from the first 10 features. The seed
 *  here keeps the dropdown non-empty during the first keystroke
 *  before either path resolves. */
const COMMON_FIELDS = [
  { name: 'name', detail: 'Feature name', doc: 'Common property: feature display name' },
]

const DOCS = {
  color: (name: string, shade: string) => ({
    value: `**${name}-${shade}**\n\nTailwind CSS color palette`,
  }),
}

// ═══ Hover Documentation ═══

const HOVER_DOCS: Record<string, string> = {
  // Keywords
  source: '**source** — Define a data source\n\n```xgis\nsource name {\n  type: geojson\n  url: "file.geojson"\n}\n```',
  layer: '**layer** — Define a render layer\n\n```xgis\nlayer name {\n  source: sourceName\n  | fill-sky-500 stroke-white stroke-1\n}\n```',
  style: '**style** — Named reusable style\n\n```xgis\nstyle dark {\n  fill: slate-900\n  stroke: slate-700\n}\n```\nApply with `style: dark` in a layer.',
  symbol: '**symbol** — Custom SDF shape\n\n```xgis\nsymbol arrow {\n  path "M 0 -1 L 0.4 0.4 L 0 0.1 L -0.4 0.4 Z"\n}\n```\nUse with `| shape-arrow`',
  preset: '**preset** — Reusable utility block\n\n```xgis\npreset dark_fill {\n  | fill-slate-800 stroke-slate-700\n}\n```',
  filter: '**filter** — Per-feature filter expression\n\n```xgis\nfilter: .pop_max > 1000000\nfilter: .name == "Japan"\nfilter: .pop > 1000 && .pop < 5000\n```\nOperators: `>`, `<`, `>=`, `<=`, `==`, `!=`, `&&`, `||`',
  // Functions
  match: '**match(field)** — Categorical color mapping\n\n```xgis\nfill match(.CONTINENT) {\n  "Asia" -> rose-500,\n  "Europe" -> sky-500,\n  _ -> gray-400\n}\n```',
  gradient: '**gradient(field, min, max, low, high)** — Linear color interpolation\n\n```xgis\nfill gradient(.GDP_MD_EST, 0, 5000000, sky-300, rose-600)\n```',
  categorical: '**categorical(field)** — Auto-assign 20 colors\n\n```xgis\nfill categorical(.name)\n```',
  clamp: '**clamp(value, min, max)** — Clamp value to range\n\n```xgis\nsize-[clamp(sqrt(.pop) / 80, 4, 40)]\n```',
  sqrt: '**sqrt(x)** — Square root\n\n```xgis\nsize-[sqrt(.pop_max) / 100]\n```',
  // Utilities
  flat: '**flat** — Render on the ground plane (world-space)\n\nPoint size scales with map zoom. Useful for area coverage circles.',
  billboard: '**billboard** — Render facing the camera (screen-space)\n\nPoint size is constant in pixels. **(default)**',
  // Line caps
  'stroke-round-cap': '**stroke-round-cap** — Round endpoint (default).\n\nDraws a half-circle at each open line end. Stable at any width.',
  'stroke-butt-cap': '**stroke-butt-cap** — Flat endpoint terminating exactly at the vertex.',
  'stroke-square-cap': '**stroke-square-cap** — Flat endpoint extended by half the line width past the vertex.',
  'stroke-arrow-cap': '**stroke-arrow-cap** — Tapered arrowhead at line termini (non-joined vertices only).',
  // Line joins
  'stroke-round-join': '**stroke-round-join** — Rounded corners (default).\n\nDrawn via circular SDF — correct at any bend angle.',
  'stroke-miter-join': '**stroke-miter-join** — Sharp miter corners.\n\nExtends the stroke to the intersection of the two edges, up to `miter-limit × half-width`. Beyond that, falls back to bevel.',
  'stroke-bevel-join': '**stroke-bevel-join** — Corners clipped flat at the stroke intersection.',
  // Dash
  'stroke-dasharray': '**stroke-dasharray-N-M[-N-M...]** — Alternating on/off lengths in pixels.\n\n```xgis\n| stroke-dasharray-20-10\n| stroke-dasharray-4-2-1-2\n```',
  'stroke-dashoffset': '**stroke-dashoffset-N** — Dash phase shift in pixels.',
  // Lateral offset
  'stroke-offset': '**stroke-offset-N** — Lateral parallel offset in pixels (positive = left of travel).\n\nAdjacent segments share their offset miter vertex so joins stay tight at any turn.',
  'stroke-offset-left': '**stroke-offset-left-N** — Offset to the LEFT of travel direction (same as bare `stroke-offset-N`).',
  'stroke-offset-right': '**stroke-offset-right-N** — Offset to the RIGHT of travel direction (negative half-width shift).',
  // Alignment
  'stroke-center': '**stroke-center** — Centerline alignment (default). Half the stroke width on each side of the geometry.',
  'stroke-inset': '**stroke-inset** — GDI+ Inset alignment. Shifts the centerline inward by `stroke-width/2` so the stroke sits entirely on one side. For CCW polygon rings, the inset side is the polygon interior.',
  'stroke-outset': '**stroke-outset** — Outward alignment. Shifts the centerline outward by `stroke-width/2`. For CCW polygon rings, the outset side is the polygon exterior.',
  // Anchors
  'anchor-center': '**anchor-center** — Point geometry anchored at its center. (default)',
  'anchor-bottom': '**anchor-bottom** — Bottom-anchored (for map pins so the tip sits on the coordinate).',
  'anchor-top': '**anchor-top** — Top-anchored.',
}

// ═══ Dynamic Field Discovery ═══

/** Currently known fields from loaded GeoJSON/XGVT data — flat union
 *  used as a fallback when the cursor's source-layer can't be
 *  resolved (e.g. cursor outside any layer block, or sourceLayer:
 *  unset). */
let discoveredFields: { name: string; sample: string }[] = []
/** Per-source-layer field schema from PMTiles archives. Empty for
 *  GeoJSON sources (which have a single flat property set, mirrored
 *  under the empty-string key for uniform lookup). */
let discoveredBySourceLayer: Record<string, { name: string; sample: string }[]> = {}
const fieldCache = new Map<string, { name: string; sample: string }[]>()
const schemaCache = new Map<string, Record<string, { name: string; sample: string }[]>>()

/** Extract field names from a source string. Two paths:
 *  - GeoJSON: fetch the URL, read the first 10 features, collect
 *    property keys.
 *  - PMTiles: open the archive header, read its metadata, walk
 *    `vector_layers[*].fields` (the schema the archive ships with).
 *    Far cheaper than tile-byte-range probing and gives field names
 *    + types per source-layer.
 *  Caches by full URL so repeat edits don't refetch. Errors are
 *  silent — the editor just falls back to whatever was already
 *  discovered. */
export async function discoverFields(source: string, baseUrl: string): Promise<void> {
  const urlMatches = [...source.matchAll(/url:\s*"([^"]+)"/g)]
  const allFields = new Map<string, string>() // flat union (fallback)
  const perLayer: Record<string, { name: string; sample: string }[]> = {}

  for (const [, url] of urlMatches) {
    if (url.includes('{z}')) continue // skip tile templates
    const fullUrl = url.startsWith('http') || url.startsWith('/') ? url : baseUrl + url

    // Schema (per-layer) cache check.
    const cachedSchema = schemaCache.get(fullUrl)
    if (cachedSchema) {
      for (const [layer, fields] of Object.entries(cachedSchema)) {
        perLayer[layer] = fields
        for (const f of fields) allFields.set(f.name, f.sample)
      }
      continue
    }

    try {
      if (fullUrl.endsWith('.pmtiles') || fullUrl.includes('.pmtiles?')) {
        const schema = await discoverPMTilesSchema(fullUrl)
        if (schema) {
          schemaCache.set(fullUrl, schema)
          for (const [layer, fields] of Object.entries(schema)) {
            perLayer[layer] = fields
            for (const f of fields) allFields.set(f.name, f.sample)
          }
        }
      } else {
        // GeoJSON: single flat property set. Mirror it under the
        // empty-string key so the per-layer lookup falls through to
        // it when sourceLayer isn't specified.
        const flat = await discoverGeoJSONFields(fullUrl)
        if (flat) {
          fieldCache.set(fullUrl, flat)
          perLayer[''] = flat
          for (const f of flat) allFields.set(f.name, f.sample)
        }
      }
    } catch { /* ignore fetch / parse errors */ }
  }

  discoveredFields = [...allFields.entries()].map(([name, sample]) => ({ name, sample }))
  discoveredBySourceLayer = perLayer
}

/** GeoJSON discovery — fetch the file, read up to 10 features, collect
 *  property keys + sample values. */
async function discoverGeoJSONFields(fullUrl: string): Promise<{ name: string; sample: string }[] | null> {
  const resp = await fetch(fullUrl)
  if (!resp.ok) return null
  const data = await resp.json()
  const features = data.features ?? data
  if (!Array.isArray(features) || features.length === 0) return null

  const fields: { name: string; sample: string }[] = []
  const propKeys = new Set<string>()
  for (let i = 0; i < Math.min(features.length, 10); i++) {
    const props = features[i]?.properties
    if (props) for (const k of Object.keys(props)) propKeys.add(k)
  }

  for (const key of propKeys) {
    let sample = ''
    for (let i = 0; i < Math.min(features.length, 5); i++) {
      const v = features[i]?.properties?.[key]
      if (v != null) { sample = String(v).slice(0, 30); break }
    }
    fields.push({ name: key, sample })
  }
  return fields
}

/** PMTiles discovery — read the archive header + metadata
 *  (`vector_layers[*].fields`). Far cheaper than fetching a tile
 *  byte range; the header is one HTTP request and the schema lists
 *  every property name available across the archive. The `sample`
 *  column is set to the field's declared type when known
 *  ("Number", "String", "Boolean") so the editor's hover doc tells
 *  the user what shape the value has. */
/** Per-source-layer PMTiles schema. Returns
 *  `{ [sourceLayerId]: [{ name, sample }] }`. The completion
 *  provider keys into this map by the `sourceLayer:` value the
 *  cursor is currently inside — so an osm_style buildings layer
 *  shows building fields (height, min_height, kind, …) but not
 *  road or landuse fields.  */
async function discoverPMTilesSchema(fullUrl: string): Promise<Record<string, { name: string; sample: string }[]> | null> {
  const { fetchPMTilesVectorLayerSchema } = await import('@xgis/runtime')
  const schema = await fetchPMTilesVectorLayerSchema(fullUrl)
  if (!schema) return null
  const out: Record<string, { name: string; sample: string }[]> = {}
  for (const [layerId, fields] of Object.entries(schema)) {
    out[layerId] = Object.entries(fields).map(([name, sample]) => ({ name, sample }))
  }
  return out
}

/** Get current discovered fields (for completion provider).
 *  When `sourceLayer` is provided AND we have a per-layer schema for
 *  it, return only that layer's fields. Otherwise fall back to the
 *  flat union (still better than COMMON_FIELDS — at least the user
 *  sees something while editing a layer that hasn't pinned a
 *  `sourceLayer:` yet). */
function getFieldCompletions(sourceLayer?: string | null): { name: string; detail: string; doc: string }[] {
  if (sourceLayer && discoveredBySourceLayer[sourceLayer]) {
    const fields = discoveredBySourceLayer[sourceLayer]
    return fields.map(f => ({
      name: f.name,
      detail: f.sample ? `${f.sample}` : 'property',
      doc: `\`${f.name}\` on **${sourceLayer}**${f.sample ? `\n\nType: \`${f.sample}\`` : ''}`,
    }))
  }
  if (discoveredFields.length > 0) {
    return discoveredFields.map(f => ({
      name: f.name,
      detail: f.sample ? `= ${f.sample}` : 'property',
      doc: `Feature property \`${f.name}\`${f.sample ? `\n\nSample: \`${f.sample}\`` : ''}`,
    }))
  }
  return COMMON_FIELDS
}

/** Walk back from `offset` through `fullText`, find the enclosing
 *  `layer { ... }` block, and pick its `sourceLayer:` value if any.
 *  Returns `null` when the cursor isn't inside a layer block, or
 *  when the layer has no sourceLayer property.
 *
 *  Implementation is a simple brace-balanced scan rather than a full
 *  re-parse — fast enough to run on every keystroke + AST-blind so
 *  it still works mid-edit when the source has parse errors that
 *  would defeat the real parser. */
function findSourceLayerAtOffset(fullText: string, offset: number): string | null {
  // Scan backward for the `{` that opens the current block.
  let depth = 0
  let openIdx = -1
  for (let i = offset - 1; i >= 0; i--) {
    const c = fullText[i]
    if (c === '}') depth++
    else if (c === '{') {
      if (depth === 0) { openIdx = i; break }
      depth--
    }
  }
  if (openIdx < 0) return null
  // Walk further back to find the keyword `layer` before the `{`.
  // Allow whitespace + an identifier (the layer name) between them.
  const headerEnd = openIdx
  let headerStart = openIdx - 1
  while (headerStart >= 0 && /[\s\w]/.test(fullText[headerStart])) headerStart--
  const header = fullText.slice(headerStart + 1, headerEnd)
  if (!/^\s*layer\s+\w+\s*$/.test(header)) return null

  // Scan forward from openIdx to the matching `}` (or to `offset`,
  // whichever comes first) for the body — pick out `sourceLayer:`.
  let blockDepth = 1
  const bodyEnd = (() => {
    for (let i = openIdx + 1; i < fullText.length; i++) {
      if (fullText[i] === '{') blockDepth++
      else if (fullText[i] === '}') { blockDepth--; if (blockDepth === 0) return i }
    }
    return fullText.length
  })()
  const body = fullText.slice(openIdx + 1, bodyEnd)
  const m = body.match(/sourceLayer\s*:\s*"([^"]+)"/)
  return m ? m[1] : null
}

// ═══ Diagnostics ═══

export function validateSource(model: monaco.editor.ITextModel): void {
  const source = model.getValue()
  const markers: monaco.editor.IMarkerData[] = []

  try {
    const lexer = new Lexer(source)
    const tokens = lexer.tokenize()
    const parser = new Parser(tokens)
    const program = parser.parse()

    // Semantic checks: undefined source references
    const definedSources = new Set<string>()
    for (const stmt of program.body) {
      if (stmt.kind === 'SourceStatement') definedSources.add(stmt.name)
      if (stmt.kind === 'LetStatement') definedSources.add(stmt.name)
    }

    for (const stmt of program.body) {
      if (stmt.kind === 'LayerStatement') {
        for (const prop of stmt.properties) {
          if (prop.name === 'source' && prop.value.kind === 'Identifier') {
            const refName = (prop.value as { name: string }).name
            if (!definedSources.has(refName)) {
              const errLine = prop.line ?? stmt.line
              markers.push({
                severity: monaco.MarkerSeverity.Error,
                message: `Undefined source: '${refName}'`,
                startLineNumber: errLine,
                startColumn: 1,
                endLineNumber: errLine,
                endColumn: model.getLineMaxColumn(errLine),
              })
            }
          }
        }
      }
    }
  } catch (err) {
    const msg = String((err as Error).message)
    const match = msg.match(/at line (\d+), col (\d+)/)
    const line = match ? parseInt(match[1]) : 1
    const col = match ? parseInt(match[2]) : 1
    const cleanMsg = msg.replace(/\[(?:Parser|Lexer)\]\s*/, '').replace(/\s*at line \d+, col \d+/, '')

    markers.push({
      severity: monaco.MarkerSeverity.Error,
      message: cleanMsg,
      startLineNumber: line,
      startColumn: col,
      endLineNumber: line,
      endColumn: model.getLineMaxColumn(line),
    })
  }

  monaco.editor.setModelMarkers(model, 'xgis', markers)
}

// ═══ Theme ═══

export function registerXGISTheme() {
  monaco.editor.defineTheme('xgis-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: 'c792ea', fontStyle: 'bold' },
      { token: 'attribute.name', foreground: '82aaff' },
      { token: 'support.function', foreground: '82aaff' },
      { token: 'string', foreground: 'c3e88d' },
      { token: 'number', foreground: 'f78c6c' },
      { token: 'number.hex', foreground: 'f78c6c' },
      { token: 'comment', foreground: '546e7a', fontStyle: 'italic' },
      { token: 'delimiter.pipe', foreground: '89ddff', fontStyle: 'bold' },
      { token: 'variable.field', foreground: 'ffcb6b' },
      { token: 'identifier', foreground: 'c8d3e0' },
      { token: 'operator', foreground: '89ddff' },
      { token: 'delimiter', foreground: '5a6a7e' },
    ],
    colors: {
      'editor.background': '#0c1017',
      'editor.foreground': '#c8d3e0',
      'editor.lineHighlightBackground': '#111820',
      'editor.selectionBackground': '#38bdf830',
      'editorCursor.foreground': '#38bdf8',
      'editorLineNumber.foreground': '#2a3a52',
      'editorLineNumber.activeForeground': '#5a6a7e',
      'editorIndentGuide.background': '#1a2233',
      'editorWidget.background': '#0c1017',
      'editorWidget.border': '#1a2233',
      'editorSuggestWidget.background': '#0c1017',
      'editorSuggestWidget.border': '#1a2233',
      'editorSuggestWidget.selectedBackground': '#1a2233',
      'editorHoverWidget.background': '#0c1017',
      'editorHoverWidget.border': '#1a2233',
      'list.hoverBackground': '#111820',
    },
  })
}
