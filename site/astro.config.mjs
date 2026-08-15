import { rehypeHeadingIds } from '@astrojs/markdown-remark'
import { defineConfig } from 'astro/config'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'
import sitemap from '@astrojs/sitemap'
import react from '@astrojs/react'
import tailwindcss from '@tailwindcss/vite'
import basicSsl from '@vitejs/plugin-basic-ssl'
import expressiveCode from 'astro-expressive-code'
import mdx from '@astrojs/mdx'
import remarkMath from 'remark-math'
import remarkDirective from 'remark-directive'
import rehypeKatex from 'rehype-katex'
import xgisGrammar from './src/lib/xgis-grammar.json' with { type: 'json' }

const isCI = !!process.env.GITHUB_ACTIONS
const BASE = (isCI ? '/X-GIS' : '/').replace(/\/$/, '')

// Prefix the deploy base onto root-absolute internal links authored in
// markdown content (blog posts write clean `/docs/...`). Astro's `base`
// only rewrites links built from import.meta.env.BASE_URL in .astro/JSX;
// plain markdown hrefs are emitted verbatim and 404 under the GitHub Pages
// base. This walks the rendered HAST and prepends BASE to any site-root-
// absolute `a href` or `img src` (skipping protocol-relative `//`,
// already-based, and the local case where BASE is empty). Zero-dep
// tree-walk — no unist import.
function rehypeBaseLinks() {
  const rebase = (url) =>
    BASE && url.startsWith('/') && !url.startsWith('//') && !url.startsWith(BASE + '/')
      ? BASE + url
      : url
  return (tree) => {
    const walk = (node) => {
      if (node.properties) {
        if (node.tagName === 'a' && typeof node.properties.href === 'string') {
          node.properties.href = rebase(node.properties.href)
        }
        if (node.tagName === 'img' && typeof node.properties.src === 'string') {
          node.properties.src = rebase(node.properties.src)
        }
      }
      if (node.children) for (const c of node.children) walk(c)
    }
    walk(tree)
  }
}

/** Flattened text content of a hast node. */
function textOf(node) {
  if (node.type === 'text') return node.value
  return (node.children ?? []).map(textOf).join('')
}

// Blog posts write bare "[1]" / "[1][2]" citation markers in prose and a
// "## References" numbered list at the foot — bracket text with no link and
// no matching anchor, so a reader can't jump to (or back from) a citation.
// This finds that references <ol> (scanning top-level nodes for the section
// between the "References" heading and the next heading), stamps each <li>
// with a `ref-N` id, then rewrites every "[N]" run OUTSIDE that list (and
// outside code/pre, so a literal bracketed number in a code span is left
// alone) into a small linked marker pointing at `#ref-N`. Zero-dep tree-walk,
// same style as rehypeBaseLinks — no remark-cite dependency for five posts.
function rehypeCitations() {
  return (tree) => {
    let refsOl = null
    let inReferences = false
    for (const node of tree.children ?? []) {
      if (node.tagName === 'h1' || node.tagName === 'h2') {
        inReferences = textOf(node).trim() === 'References'
        continue
      }
      if (inReferences && node.tagName === 'ol') {
        refsOl = node
        break
      }
    }
    if (refsOl) {
      refsOl.children
        .filter((n) => n.tagName === 'li')
        .forEach((li, i) => {
          li.properties = { ...li.properties, id: `ref-${i + 1}` }
        })
    }

    const CITATION = /\[(\d+)\]/g
    const isKatex = (n) =>
      Array.isArray(n.properties?.className) && n.properties.className.includes('katex')
    const walk = (node) => {
      if (node === refsOl || node.tagName === 'code' || node.tagName === 'pre' || isKatex(node))
        return
      if (!node.children) return
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i]
        if (child.type === 'text' && CITATION.test(child.value)) {
          CITATION.lastIndex = 0
          const pieces = []
          let last = 0
          let m
          while ((m = CITATION.exec(child.value))) {
            if (m.index > last)
              pieces.push({ type: 'text', value: child.value.slice(last, m.index) })
            pieces.push({
              type: 'element',
              tagName: 'a',
              properties: { href: `#ref-${m[1]}`, className: ['citation'] },
              children: [{ type: 'text', value: `[${m[1]}]` }],
            })
            last = m.index + m[0].length
          }
          if (last < child.value.length)
            pieces.push({ type: 'text', value: child.value.slice(last) })
          node.children.splice(i, 1, ...pieces)
          i += pieces.length - 1
          continue
        }
        walk(child)
      }
    }
    walk(tree)
  }
}

// A comparison table wider than the 720px prose measure needs to scroll
// horizontally on narrow/mobile viewports — but a bare `overflow-x: auto`
// on the table itself gives no visual sign there's more to the right, so a
// reader just sees the last column cut off and reads it as broken.
//
// Wraps each <table> in TWO nested divs: an outer `.table-scroll` (static,
// position: relative — its CSS ::after paints a right-edge fade) around an
// inner `.table-scroll-inner` (the actual `overflow-x: auto` scroller). The
// fade has to live on the OUTER, non-scrolling box: an absolutely-positioned
// pseudo-element on the SAME element that scrolls is part of that element's
// scrollable content and scrolls away with it (measured — the one-wrapper
// version put the fade at the table's right edge, not the viewport's, so it
// only lined up with the visible edge at scrollLeft 0 and vanished the
// moment a reader actually scrolled).
function rehypeWrapTables() {
  return (tree) => {
    const walk = (node) => {
      if (!node.children) return
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i]
        if (child.tagName === 'table') {
          node.children[i] = {
            type: 'element',
            tagName: 'div',
            properties: { className: ['table-scroll'] },
            children: [
              {
                type: 'element',
                tagName: 'div',
                properties: { className: ['table-scroll-inner'] },
                children: [child],
              },
            ],
          }
          continue
        }
        walk(child)
      }
    }
    walk(tree)
  }
}

// Every generated API page (src/content/api/**/*.md, frontmatter `generated: true` — #1695)
// opens with a TypeDoc H1, and that H1 needs one of two different treatments depending on
// its shape:
//
//   - a SYMBOL page ("Function: emitConst()", "Class: Node<K>") — the left rail already
//     groups by kind and the breadcrumb shows the subpath, so the "Kind: " prefix is pure
//     repetition sitting in front of the one thing worth reading, the name. Split it into a
//     small eyebrow label so the heading itself is just the name (#1695 item 12). Mutates
//     only the FIRST text node the heading contains — a deprecated symbol wraps its whole
//     heading in `~~…~~` (`callFn`, `condExpr`, `ifExpr`), and slicing the raw string instead
//     of the node tree would silently drop that strikethrough.
//   - a GROUP-INDEX page ("index", "dev", "core/ir", the bare package name) — Astro
//     (ApiReference.astro) renders its OWN <h1> from `indexTitle` directly above `.api-prose`,
//     so TypeDoc's copy is a second, redundant heading in the DOM. It used to be hidden with
//     `display: none` (prose.css `.api-prose--index > h1:first-child`), which is still two
//     <h1> for assistive tech — removed here instead (#1695 item 8).
//
// The frontmatter check keeps this from ever touching a blog post (no `generated` key), and
// `tree.children[0]` scopes it to the page's OWN heading — `hidePageHeader`/`hideBreadcrumbs`
// in typedoc.json mean that's always the very first node TypeDoc emits.
const API_SYMBOL_KIND = new Set(['Function', 'Class', 'Interface', 'Type Alias', 'Variable'])
function firstTextNode(node) {
  if (node.type === 'text') return node
  for (const c of node.children ?? []) {
    const t = firstTextNode(c)
    if (t) return t
  }
  return undefined
}
function rehypeApiHeading() {
  return (tree, file) => {
    if (file.data?.astro?.frontmatter?.generated !== true) return
    const h1 = tree.children[0]
    if (!h1 || h1.tagName !== 'h1') return
    const m = /^([A-Za-z ]+): (.+)$/s.exec(textOf(h1))
    if (m && API_SYMBOL_KIND.has(m[1])) {
      const firstText = firstTextNode(h1)
      if (firstText) firstText.value = firstText.value.replace(`${m[1]}: `, '')
      h1.children.unshift({
        type: 'element',
        tagName: 'span',
        properties: { className: ['api-kind-eyebrow'] },
        children: [{ type: 'text', value: m[1] }],
      })
    } else {
      tree.children.shift()
    }
  }
}

// READING ORDER, at the DOM rather than with CSS `order` (#1695 item 6).
//
// The first pass at this used four `order` tiers to float the page-level "Defined in" line
// below the description and the member summary up under it. Measured on the built page, that
// left `.api-prose`'s DOM children as [h1, p("Defined in…"), div(description)] while they
// PAINTED as h1 → description → Defined-in. CSS `order` moves pixels only: Flexbox §5.4 says
// it does not affect speech or navigation order, and explicitly forbids using it to repair a
// document whose source order is wrong.
//
// So the original defect survived for anyone not reading with their eyes — a screen reader
// still heard provenance before meaning — and a NEW one appeared that the unfixed page did
// not have: sequential focus follows the DOM, so Tab from the h1 reached the "Defined in"
// GitHub link BEFORE any link in the description, i.e. focus jumped backwards against the
// visual order (WCAG 2.4.3). An inconsistently-wrong page is worse than a consistently-wrong
// one, because only the former can pass a visual review.
//
// Moving the node is the whole fix: DOM order, paint order, speech order and focus order all
// become the same sequence, and every `order:` rule this replaced is deleted.
//
// Scope is deliberately the PAGE-level line only — the first `p` that is a direct child and
// links into /blob/. A member's own "Defined in" (nested under `## Properties` → `### foo`)
// is not a direct child of the root, so it stays exactly where TypeDoc put it.
function rehypeApiReadingOrder() {
  return (tree, file) => {
    if (file.data?.astro?.frontmatter?.generated !== true) return
    const kids = tree.children
    const isDefinedIn = (n) =>
      n?.type === 'element' &&
      n.tagName === 'p' &&
      JSON.stringify(n).includes('/blob/') &&
      textOf(n).trim().startsWith('Defined in')
    const di = kids.findIndex(isDefinedIn)
    if (di < 0) return
    // The description is whatever sits between the "Defined in" line and the first section
    // heading. No description -> nothing to move past, and the line stays under the h1.
    const firstSection = kids.findIndex(
      (n, i) => i > di && n.type === 'element' && /^h[1-3]$/.test(n.tagName ?? ''),
    )
    const end = firstSection < 0 ? kids.length : firstSection
    if (end <= di + 1) return
    const [node] = kids.splice(di, 1)
    kids.splice(end - 1, 0, node)
  }
}

// The member jump-list (#1695 item 16), built HERE rather than as a component appended after
// `<Content />`. Same reason as the reading-order move above: as a component it could only be
// `.api-prose`'s LAST child, so it needed an `order` tier to paint second — and a jump-list
// that speaks and focuses at the very bottom while appearing at the top is precisely the
// mismatch that pattern creates. Inserted into the tree, it lands where it reads.
//
// It is a VIEW over headings `<Content />` already rendered, so every target id exists by
// construction; there is no hand-maintained list to drift.
const MEMBER_SECTIONS = new Set(['Constructors', 'Properties', 'Accessors', 'Methods'])
function rehypeApiMemberSummary() {
  return (tree, file) => {
    if (file.data?.astro?.frontmatter?.generated !== true) return
    const kids = tree.children
    const groups = []
    let current = null
    for (const n of kids) {
      if (n.type !== 'element') continue
      if (n.tagName === 'h2') {
        const t = textOf(n).trim()
        current = MEMBER_SECTIONS.has(t) ? { section: t, items: [] } : null
        if (current) groups.push(current)
      } else if (current && n.tagName === 'h3' && n.properties?.id) {
        current.items.push({ text: textOf(n).trim(), slug: String(n.properties.id) })
      }
    }
    const total = groups.reduce((a, g) => a + g.items.length, 0)
    // Measured: only 5 of 332 pages carry more than 10 members (Node 46, ReadonlyNode 45,
    // Backend 21, Builder 18, FuncDecl 12). Below that one scroll already shows everything,
    // so the list would be pure duplication of what is on screen.
    if (total <= 10) return

    const li = (it) => ({
      type: 'element',
      tagName: 'li',
      children: [
        {
          type: 'element',
          tagName: 'a',
          properties: { href: `#${it.slug}` },
          children: [{ type: 'text', value: it.text }],
        },
      ],
    })
    const nav = {
      type: 'element',
      tagName: 'nav',
      properties: { className: ['api-member-summary'], 'aria-label': 'Members' },
      children: [
        {
          type: 'element',
          tagName: 'p',
          properties: { className: ['api-member-summary-label'] },
          children: [{ type: 'text', value: 'Members' }],
        },
        ...groups.map((g) => ({
          type: 'element',
          tagName: 'div',
          properties: { className: ['api-member-summary-group'] },
          children: [
            {
              type: 'element',
              tagName: 'span',
              properties: { className: ['api-member-summary-group-label'] },
              children: [{ type: 'text', value: g.section }],
            },
            { type: 'element', tagName: 'ul', children: g.items.map(li) },
          ],
        })),
      ],
    }
    const firstSection = kids.findIndex(
      (n) => n.type === 'element' && /^h[1-3]$/.test(n.tagName ?? '') && n.tagName !== 'h1',
    )
    kids.splice(firstSection < 0 ? kids.length : firstSection, 0, nav)
  }
}

// An OVERLOADED symbol repeats "## Call Signature" once per overload with IDENTICAL text —
// `fn` has four, and nothing in the rendered BODY told them apart (#1695 item 15): the reader
// had to compare each signature blockquote by eye to tell overload 2 from 3. [...slug].astro
// already solved this for the right-rail TOC by de-duplicating heading TEXT there; this
// mirrors that approach for the page body itself, via the actual heading elements.
//
// A flat "de-dup any repeated text on the page" pass (the TOC's approach) is wrong here
// though: Node.md's "Get Signature" appears once per ACCESSOR (17 times on the page) but
// never twice under the same accessor — those aren't overloads of each other and numbering
// them 1–17 would be actively misleading. The distinction is PARENT SCOPE: "Call Signature"
// repeats as a run of SIBLINGS under one method's own name; "Get Signature" repeats once
// each under DIFFERENT, uniquely-named accessors. Building a heading tree from the flat
// depth list and only comparing a node's DIRECT CHILDREN gets both right for free — a
// shallower heading of different text (the next accessor's own name) always ends a run,
// so only genuine sibling repeats ever get numbered.
// HEADING ROLE — a heading is a section LABEL or an identifier NAME, and depth cannot tell.
//
// The type scale keyed off depth: h2 a structural label, h3 a section, h4 a dense parameter
// name. TypeDoc's shape does not work that way. On a plain function `## Parameters` / `### v`
// puts the parameter name at h3; add one overload and everything shifts a level, so the SAME
// role lands at a different depth on a different page. The h3 rule carried
// `text-transform: uppercase` — correct for "PARAMETERS", and it renamed the parameters:
// `v` published as `V`, `x` as `X`, `opts?` as `OPTS?`, in a language where case is meaning.
// The page and its own table of contents disagreed, since the TOC never had the transform.
//
// So role is decided by the TEXT, against TypeDoc's closed section vocabulary. The default is
// NAME, which is the fail-safe direction: a section this list has not heard of renders as an
// identifier (plain, mixed case — merely plainer than intended), while the reverse would
// silently rewrite someone's parameter. `Return`, `Node`, `Builder`, `If`, `Let`, `Break` and
// `Discard` are all EXPORTED SYMBOLS in this package and appear as headings — which is why
// this cannot be "looks like an English word", and why build-api-reference.ts asserts the set
// stays disjoint from the published symbol names.
const API_SECTION_LABELS = new Set([
  'Accessors',
  'Call Signature',
  'Classes',
  'Constructor',
  'Constructors',
  'Default Value',
  'Deprecated',
  'Enumeration Members',
  'Enumerations',
  'Example',
  'Extended by',
  'Extends',
  'Functions',
  'Get Signature',
  'Implementation of',
  'Implements',
  'Indexable',
  'Inherited from',
  'Interfaces',
  'Methods',
  'Modules',
  'Overrides',
  'Parameters',
  'Properties',
  'References',
  'Remarks',
  'Returns',
  'See',
  'Set Signature',
  'Since',
  'Throws',
  'Type Aliases',
  'Type Declaration',
  'Type Parameters',
  'Variables',
])
function rehypeApiHeadingRole() {
  return (tree, file) => {
    if (file.data?.astro?.frontmatter?.generated !== true) return
    const walk = (node) => {
      for (const child of node.children ?? []) {
        if (child.type === 'element' && /^h[2-6]$/.test(child.tagName)) {
          // Whitespace-normalised before the lookup: TypeDoc writes "Type Parameters" with a
          // regular space, but a heading that wrapped in the source can arrive with a newline,
          // and the class covers the non-breaking space too — any of which would miss the set
          // and silently demote a section to an identifier.
          const text = textOf(child).replace(/\s+/g, ' ').trim()
          // An overloaded section is numbered by rehypeApiOverloads ("Parameters 2"); match
          // the label under that suffix rather than losing the role the moment a symbol
          // gains a second overload.
          const bare = text.replace(/ \d+$/, '')
          const role = API_SECTION_LABELS.has(bare) ? 'api-h-label' : 'api-h-name'
          child.properties.className = [...(child.properties.className ?? []), role]
        }
        walk(child)
      }
    }
    walk(tree)
  }
}

// TYPE LINES — a paragraph that IS a type, not a paragraph that mentions one.
//
// TypeDoc renders a type expression as a run of separate `<code>` elements with the angle
// brackets as bare text between them: `Node<"f32">` arrives as
// `<a href="…"><code>Node</code></a>&lt;<code>"f32"</code>&gt;`. `.blog-prose`'s inline-code
// chip — background, radius, 0.1em/0.4em padding — then draws a box around each fragment and
// leaves the brackets outside, so the reader sees `Node` `<` `"f32"` `>` : four boxes with
// visible gaps where one identifier should be. Measured on the built page.
//
// The signature blockquote already had this stripped (prose.css), which is why the bug
// survived a review: the ONE place anyone looked was fixed, and the Returns, Parameters,
// Type Parameters and Extends sections — the other four places TypeDoc emits the same shape —
// kept it. One rule for all five is the fix, not a fifth exception.
//
// A chip is right in DESCRIPTIVE prose (`x.add(1)` in a sentence reads better boxed), so the
// two cases must be told apart structurally rather than by section name. The test is the one
// api-doc-coverage.test.ts's A9 arm uses on doc tags: strip the code spans and the
// punctuation, and see whether any prose survives. If none does, the paragraph is a type.
const TYPE_LINE_RESIDUE = /^[\s<>|&(),.:;[\]{}?*=+/\\-]*$/
function rehypeApiTypeLines() {
  return (tree, file) => {
    if (file.data?.astro?.frontmatter?.generated !== true) return
    const walk = (node) => {
      for (const child of node.children ?? []) {
        if (child.type === 'element' && child.tagName === 'p') {
          // The scaffolder's provenance line, on every page. Tagged here rather than matched
          // in CSS because there is no structural tell — it is an ordinary paragraph whose
          // only distinguishing feature is how it starts.
          if (textOf(child).trimStart().startsWith('Exported from ')) {
            child.properties.className = [
              ...(child.properties.className ?? []),
              'api-exported-from',
            ]
          }
          const codeText = []
          const collectCode = (n) => {
            if (n.type === 'element' && n.tagName === 'code') return codeText.push(textOf(n))
            for (const c of n.children ?? []) collectCode(c)
          }
          collectCode(child)
          // Needs at least one `<code>`, or an ordinary empty-ish paragraph would qualify.
          if (codeText.length > 0) {
            let rest = textOf(child)
            for (const t of codeText) rest = rest.replace(t, '')
            if (TYPE_LINE_RESIDUE.test(rest)) {
              const cls = child.properties.className ?? []
              child.properties.className = [...cls, 'api-type-line']
            }
          }
        }
        walk(child)
      }
    }
    walk(tree)
  }
}

function rehypeApiOverloads() {
  return (tree, file) => {
    if (file.data?.astro?.frontmatter?.generated !== true) return
    const flat = []
    const walk = (node) => {
      if (node.type === 'element' && /^h[1-6]$/.test(node.tagName ?? '')) {
        flat.push({ depth: Number(node.tagName[1]), text: textOf(node), node })
      }
      for (const c of node.children ?? []) walk(c)
    }
    walk(tree)
    if (flat.length === 0) return

    // Depths are not necessarily contiguous (a section can skip a level), so build the tree
    // by popping any stack entry whose depth is >= the incoming heading's — the standard
    // "outline from a flat heading list" construction.
    const root = { depth: 0, children: [] }
    const stack = [root]
    for (const h of flat) {
      while (stack[stack.length - 1].depth >= h.depth) stack.pop()
      const entry = { ...h, children: [] }
      stack[stack.length - 1].children.push(entry)
      stack.push(entry)
    }

    // Only a RUN of >= 2 identical (depth, text) siblings gets numbered, first occurrence
    // included — matches [...slug].astro's TOC dedup, so a page's body and its TOC read the
    // same overload numbers. A single Call Signature (no overloads) stays bare.
    const numberRuns = (siblings) => {
      let i = 0
      while (i < siblings.length) {
        let j = i + 1
        while (
          j < siblings.length &&
          siblings[j].depth === siblings[i].depth &&
          siblings[j].text === siblings[i].text
        )
          j++
        if (j - i >= 2) {
          for (let k = i; k < j; k++) {
            siblings[k].node.children.push({ type: 'text', value: ` ${k - i + 1}` })
          }
        }
        i = j
      }
      for (const s of siblings) numberRuns(s.children)
    }
    numberRuns(root.children)
  }
}

// Container directives (`:::warning … :::`) become admonition callouts, so a
// blog post in PLAIN markdown can flag a gotcha/trap without opting into MDX to
// import the <Callout> Astro component. remark-directive (above, in
// remarkPlugins) parses the `:::name[Optional title]` syntax into a
// `containerDirective` mdast node; this pass turns the five admonition names
// into `<div class="callout callout-<name>">` with a leading label paragraph,
// styled by .blog-prose .callout rules in the post layout. Any other directive
// name is left untouched (rendered as its literal text by remark). Zero-dep
// mdast walk, same house style as the rehype passes below.
const CALLOUT_LABELS = {
  note: 'Note',
  tip: 'Tip',
  warning: 'Warning',
  caution: 'Caution',
  important: 'Important',
}
function remarkCallouts() {
  return (tree) => {
    const walk = (node) => {
      if (!node.children) return
      for (const child of node.children) {
        if (child.type === 'containerDirective' && CALLOUT_LABELS[child.name]) {
          // `:::warning[Custom title]` → the label rides as a first child
          // paragraph flagged `directiveLabel`; consume it as the heading.
          let title = CALLOUT_LABELS[child.name]
          const first = child.children[0]
          if (first?.type === 'paragraph' && first.data?.directiveLabel) {
            title = first.children.map((c) => c.value ?? '').join('')
            child.children.shift()
          }
          child.data = child.data || {}
          child.data.hName = 'div'
          child.data.hProperties = { className: ['callout', `callout-${child.name}`] }
          child.children.unshift({
            type: 'paragraph',
            data: { hProperties: { className: ['callout-label'] } },
            children: [{ type: 'text', value: title }],
          })
        }
        walk(child)
      }
    }
    walk(tree)
  }
}

export default defineConfig({
  site: 'https://x-gis.github.io',
  base: isCI ? '/X-GIS' : '/',
  markdown: {
    // remark-math + rehype-katex: $…$ / $$…$$ LaTeX in blog markdown renders
    // to KaTeX HTML at build time (no client JS; katex.min.css is imported by
    // the blog post layout).
    remarkPlugins: [remarkMath, remarkDirective, remarkCallouts],
    rehypePlugins: [
      rehypeKatex,
      rehypeBaseLinks,
      rehypeCitations,
      rehypeWrapTables,
      rehypeApiHeading,
      rehypeApiReadingOrder,
      // rehypeHeadingIds is Astro's OWN id injector. User rehypePlugins run BEFORE it, so a
      // plugin that reads `properties.id` sees nothing — which is exactly how the member
      // summary silently produced zero items on a 46-member page while the build stayed
      // green. Running it explicitly here puts the ids in the tree first; Astro's own later
      // pass is idempotent over headings that already carry one.
      rehypeHeadingIds,
      rehypeApiMemberSummary,
      rehypeApiTypeLines,
      rehypeApiOverloads,
      // AFTER rehypeApiOverloads, which rewrites "Parameters" to "Parameters 2" on an
      // overloaded symbol — running before it would read the un-numbered text and then have
      // the role silently go stale for exactly the pages with the most sections.
      rehypeApiHeadingRole,
    ],
  },
  // English is the default and stays at the root (/docs, /blog, …);
  // Korean is served under /ko (/ko/docs, /ko/blog, …). prefixDefaultLocale:
  // false keeps every existing en route unchanged — i18n is purely additive
  // until the /ko content is filled in. Use Astro.currentLocale + getRelativeLocaleUrl
  // in components for the language toggle.
  i18n: {
    defaultLocale: 'en',
    locales: ['en', 'ko'],
    routing: { prefixDefaultLocale: false },
  },
  integrations: [
    // Build-time syntax highlighting (Shiki under the hood) + frame
    // chrome (language label, copy button, optional file caption /
    // line markers). Theme picked to match the site's dark surface.
    expressiveCode({
      themes: ['github-dark-default'],
      // Custom grammar so xgis-specific tokens (block keywords like
      // `source` / `layer`, color literals, utility classes,
      // pipe/coalesce/match-arrow operators, runtime accessors like
      // `zoom`) get tokenised distinctively rather than falling back
      // to JS approximation. See src/lib/xgis-grammar.json.
      shiki: {
        langs: [xgisGrammar],
      },
      styleOverrides: {
        borderRadius: '0.75rem',
        codeFontFamily: '"DM Mono", "Fira Code", monospace',
        codeFontSize: '13px',
        frames: {
          shadowColor: 'transparent',
        },
      },
      defaultProps: {
        wrap: true,
      },
    }),
    sitemap(),
    // MDX for the blog only (content.config.ts globs both `.md` and `.mdx`
    // under src/content/blog). Inherits the `markdown` remark/rehype config
    // above (remarkMath/rehypeKatex/rehypeBaseLinks) by default, so KaTeX and
    // the GH-Pages base-link rewrite keep working in `.mdx` posts. Lets a
    // post import + embed a component (e.g. LiveShader) directly in prose.
    mdx(),
    // React islands — shadcn/ui components render as hydrated islands;
    // expressive-code stays build-time, Astro pages stay static.
    react(),
  ],
  vite: {
    plugins: [tailwindcss(), basicSsl()],
    // Dev/build resolve @xgis/map to SOURCE, not the published dist. The
    // published package's `main`/`exports` point at ./dist/index.js for external
    // npm consumers (publishConfig); without this alias the site build (blueprint
    // live-preview + Hero both dynamically import @xgis/map) would resolve a dist
    // that is built only for publishing. Same alias the playground vite config uses.
    resolve: {
      alias: {
        // @xgis/map bundles @xgis/engine. Alias both to SOURCE so the site loads ONE
        // instance of each — Vite pre-bundling them into a second copy split the stateful
        // RHI Material-twin / projections singletons, so the hero's fill draws hit
        // "no RHI Material twin" and the render loop halted.
        '@xgis/engine': fileURLToPath(new URL('../engine/src/index.ts', import.meta.url)),
        '@xgis/map': fileURLToPath(new URL('../map/src/index.ts', import.meta.url)),
        // #763 A1 — shader-dsl to SOURCE like the rest (subpath keys FIRST: vite alias
        // is prefix-replacing, the bare key would swallow '/examples' and '/emit-prod').
        '@xgis/shader-dsl/examples': fileURLToPath(
          new URL('../shader-dsl/examples/index.ts', import.meta.url),
        ),
        '@xgis/shader-dsl/emit-prod': fileURLToPath(
          new URL('../shader-dsl/src/emit-prod.ts', import.meta.url),
        ),
        '@xgis/shader-dsl': fileURLToPath(new URL('../shader-dsl/src/index.ts', import.meta.url)),
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    // Workspace packages must skip Vite's pre-bundle (it can't crawl
    // their TS exports correctly through symlinks). Same fix the
    // playground uses.
    optimizeDeps: {
      exclude: [
        '@xgis/compiler',
        '@xgis/blueprint',
        '@xgis/engine',
        '@xgis/map',
        '@xgis/shader-dsl',
      ],
    },
    // (No /play proxy here — earlier attempt at HTTPS-target proxy
    // returned HTTP 500 because the playground's basic-ssl cert /
    // protocol mix didn't terminate cleanly through Vite's proxy.
    // Dev path now uses a runtime-detected cross-origin redirect
    // from the convert page — see site/src/pages/convert.astro
    // for the dev branch that opens the playground at its own
    // origin and ferries the source via the URL hash.)
  },
})
