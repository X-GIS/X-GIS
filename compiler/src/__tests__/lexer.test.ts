import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { TokenType } from '../lexer/tokens'

function lex(source: string) {
  return new Lexer(source).tokenize().filter((t) => t.type !== TokenType.Newline && t.type !== TokenType.EOF)
}

function types(source: string) {
  return lex(source).map((t) => t.type)
}

function values(source: string) {
  return lex(source).map((t) => t.value)
}

describe('Lexer', () => {
  describe('literals', () => {
    it('numbers', () => {
      expect(values('42 3.14')).toEqual(['42', '3.14'])
    })

    it('numbers with units', () => {
      const tokens = lex('20px 5km 100m 30deg 2s 500ms')
      expect(tokens.map((t) => t.type)).toEqual([
        TokenType.Number, TokenType.Px,
        TokenType.Number, TokenType.Km,
        TokenType.Number, TokenType.M,
        TokenType.Number, TokenType.Deg,
        TokenType.Number, TokenType.S,
        TokenType.Number, TokenType.Ms,
      ])
      expect(tokens.map((t) => t.value)).toEqual([
        '20', 'px', '5', 'km', '100', 'm', '30', 'deg', '2', 's', '500', 'ms',
      ])
    })

    it('strings', () => {
      const tokens = lex('"hello" "world"')
      expect(tokens.map((t) => t.value)).toEqual(['hello', 'world'])
      expect(tokens[0].type).toBe(TokenType.String)
    })

    it('string escape sequences', () => {
      expect(values('"line\\nbreak"')).toEqual(['line\nbreak'])
    })

    it('colors', () => {
      const tokens = lex('#ff0000 #ccc #00ff00ff')
      expect(tokens.map((t) => t.value)).toEqual(['#ff0000', '#ccc', '#00ff00ff'])
      expect(tokens.every((t) => t.type === TokenType.Color)).toBe(true)
    })

    it('booleans', () => {
      expect(types('true false')).toEqual([TokenType.Bool, TokenType.Bool])
    })
  })

  describe('keywords', () => {
    it('recognizes all keywords', () => {
      expect(types('let fn show place view on if else for in return')).toEqual([
        TokenType.Let, TokenType.Fn, TokenType.Show, TokenType.Place,
        TokenType.View, TokenType.On, TokenType.If, TokenType.Else,
        TokenType.For, TokenType.In, TokenType.Return,
      ])
    })

    it('identifiers are not keywords', () => {
      expect(types('myVar _private foo123')).toEqual([
        TokenType.Identifier, TokenType.Identifier, TokenType.Identifier,
      ])
    })
  })

  describe('symbols', () => {
    it('single-char symbols', () => {
      expect(types('( ) { } [ ] : , . = < > + - * / % & | !')).toEqual([
        TokenType.LParen, TokenType.RParen,
        TokenType.LBrace, TokenType.RBrace,
        TokenType.LBracket, TokenType.RBracket,
        TokenType.Colon, TokenType.Comma, TokenType.Dot,
        TokenType.Eq, TokenType.Lt, TokenType.Gt,
        TokenType.Plus, TokenType.Minus,
        TokenType.Star, TokenType.Slash, TokenType.Percent,
        TokenType.Amp, TokenType.Pipe, TokenType.Bang,
      ])
    })

    it('two-char symbols', () => {
      expect(types('== != <= >= && || -> ..')).toEqual([
        TokenType.EqEq, TokenType.BangEq,
        TokenType.LtEq, TokenType.GtEq,
        TokenType.AmpAmp, TokenType.PipePipe,
        TokenType.Arrow, TokenType.DotDot,
      ])
    })
  })

  describe('comments', () => {
    it('skips line comments', () => {
      expect(values('let x // this is a comment\nlet y')).toEqual(['let', 'x', 'let', 'y'])
    })
  })

  describe('hello map program', () => {
    it('tokenizes the first X-GIS program', () => {
      const source = `
let world = load("countries.geojson")

show world {
    fill: #f2efe9
    stroke: #ccc, 1px
}
`
      const tokens = lex(source)
      const vals = tokens.map((t) => t.value)

      expect(vals).toEqual([
        'let', 'world', '=', 'load', '(', 'countries.geojson', ')',
        'show', 'world', '{',
        'fill', ':', '#f2efe9',
        'stroke', ':', '#ccc', ',', '1', 'px',
        '}',
      ])
    })
  })

  describe('line tracking', () => {
    it('tracks line numbers correctly', () => {
      const tokens = new Lexer('let x\nlet y\nlet z').tokenize()
      const lets = tokens.filter((t) => t.type === TokenType.Let)
      expect(lets.map((t) => t.line)).toEqual([1, 2, 3])
    })
  })
})
