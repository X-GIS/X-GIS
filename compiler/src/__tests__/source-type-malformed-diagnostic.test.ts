// `source { type: … }` that is neither a bare name nor a quoted string used to
// leave the `geojson` initialiser standing with NO diagnostic — so an unquoted
// hyphenated registry key (`type: x-kr-admin`, which parses as the expression
// `x - kr - admin`) silently changed the source's meaning (#2549).

import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { SOURCE_TYPE_NOT_A_NAME } from '../diagnostics/diagnostic'
import { withPragma } from './_pragma'

function diagnosticsOf(source: string) {
  return lower(new Parser(new Lexer(withPragma(source)).tokenize()).parse()).diagnostics ?? []
}

describe('source `type:` that is neither an identifier nor a string (#2549)', () => {
  it('reports the source instead of silently falling back to geojson', () => {
    const diagnostics = diagnosticsOf(`
      source kr_admin {
        type: x-kr-admin
        url: "https://x/a"
      }
      layer l { source: kr_admin | fill-red-500 }
    `)
    const d = diagnostics.find((x) => x.code === SOURCE_TYPE_NOT_A_NAME)
    expect(d, 'a malformed source type must produce a diagnostic').toBeTruthy()
    expect(d!.severity).toBe('error')
    expect(d!.message).toContain('kr_admin')
  })

  it('control: both well-formed spellings stay diagnostic-free', () => {
    for (const t of ['geojson', '"x-kr-admin"']) {
      const diagnostics = diagnosticsOf(`
        source kr_admin {
          type: ${t}
          url: "https://x/a"
        }
        layer l { source: kr_admin | fill-red-500 }
      `)
      expect(
        diagnostics.filter((x) => x.code === SOURCE_TYPE_NOT_A_NAME),
        `type: ${t} must not be flagged`,
      ).toEqual([])
    }
  })
})
