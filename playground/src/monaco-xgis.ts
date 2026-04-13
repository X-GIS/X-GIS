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
        for (const f of getFieldCompletions()) {
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
  { label: 'opacity-', insertText: 'opacity-${1}', detail: 'Opacity (0-100)', documentation: { value: '`opacity-{N}` — Layer opacity\n\n`opacity-50` = 50%, `opacity-0.8` = 80%' } },
  { label: 'size-', insertText: 'size-${1}', detail: 'Point size', documentation: { value: '`size-{N}{unit}` — Point radius\n\nUnits: `px` (default), `m`, `km`, `nm`, `deg`\n\nData-driven: `size-[sqrt(.pop) / 80]km`' } },
  { label: 'shape-', insertText: 'shape-${1}', detail: 'Point shape', documentation: { value: 'Built-in: `circle` (default), `star`, `diamond`, `triangle`, `square`, `cross`, `hexagon`, `pentagon`\n\nCustom: define with `symbol` block' } },
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

const COMMON_FIELDS = [
  { name: 'name', detail: 'Feature name', doc: 'Common property: feature display name' },
  { name: 'pop_max', detail: 'Max population', doc: 'Natural Earth: maximum population estimate' },
  { name: 'pop_min', detail: 'Min population', doc: 'Natural Earth: minimum population estimate' },
  { name: 'POP_EST', detail: 'Population estimate', doc: 'Country population estimate' },
  { name: 'GDP_MD_EST', detail: 'GDP (millions USD)', doc: 'Gross domestic product in millions of dollars' },
  { name: 'CONTINENT', detail: 'Continent name', doc: 'Africa, Asia, Europe, North America, South America, Oceania, Antarctica' },
  { name: 'REGION_UN', detail: 'UN Region', doc: 'United Nations region classification' },
  { name: 'SUBREGION', detail: 'Subregion', doc: 'Geographic subregion (e.g., Southern Asia, Western Europe)' },
  { name: 'ECONOMY', detail: 'Economy class', doc: 'Economy classification (e.g., "7. Least developed region")' },
  { name: 'INCOME_GRP', detail: 'Income group', doc: 'World Bank income classification' },
  { name: 'featurecla', detail: 'Feature class', doc: 'Natural Earth feature classification' },
  { name: 'scalerank', detail: 'Scale rank', doc: 'Importance ranking for display at different scales' },
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
}

// ═══ Dynamic Field Discovery ═══

/** Currently known fields from loaded GeoJSON/XGVT data */
let discoveredFields: { name: string; sample: string }[] = []
const fieldCache = new Map<string, { name: string; sample: string }[]>()

/** Extract field names from a source string — fetch URLs and read properties */
export async function discoverFields(source: string, baseUrl: string): Promise<void> {
  const urlMatches = [...source.matchAll(/url:\s*"([^"]+)"/g)]
  const allFields = new Map<string, string>() // name → sample value

  for (const [, url] of urlMatches) {
    if (url.endsWith('.xgvt') || url.includes('{z}')) continue // skip binary + tile templates
    const fullUrl = url.startsWith('http') || url.startsWith('/') ? url : baseUrl + url

    // Check cache
    if (fieldCache.has(fullUrl)) {
      for (const f of fieldCache.get(fullUrl)!) allFields.set(f.name, f.sample)
      continue
    }

    try {
      const resp = await fetch(fullUrl)
      if (!resp.ok) continue
      const data = await resp.json()
      const features = data.features ?? data
      if (!Array.isArray(features) || features.length === 0) continue

      const fields: { name: string; sample: string }[] = []
      // Collect all unique property keys from first 10 features
      const propKeys = new Set<string>()
      for (let i = 0; i < Math.min(features.length, 10); i++) {
        const props = features[i]?.properties
        if (props) for (const k of Object.keys(props)) propKeys.add(k)
      }

      for (const key of propKeys) {
        // Find a sample non-null value
        let sample = ''
        for (let i = 0; i < Math.min(features.length, 5); i++) {
          const v = features[i]?.properties?.[key]
          if (v != null) { sample = String(v).slice(0, 30); break }
        }
        fields.push({ name: key, sample })
        allFields.set(key, sample)
      }

      fieldCache.set(fullUrl, fields)
    } catch { /* ignore fetch errors */ }
  }

  discoveredFields = [...allFields.entries()].map(([name, sample]) => ({ name, sample }))
}

/** Get current discovered fields (for completion provider) */
function getFieldCompletions(): { name: string; detail: string; doc: string }[] {
  if (discoveredFields.length > 0) {
    return discoveredFields.map(f => ({
      name: f.name,
      detail: f.sample ? `= ${f.sample}` : 'property',
      doc: `Feature property \`${f.name}\`${f.sample ? `\n\nSample: \`${f.sample}\`` : ''}`,
    }))
  }
  return COMMON_FIELDS
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
