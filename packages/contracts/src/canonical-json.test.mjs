import { describe, expect, test } from 'bun:test'
import { canonicalJsonStringify } from './canonical-json.ts'

const codePointCompare = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

describe('canonicalJsonStringify', () => {
  describe('code-point key ordering', () => {
    test('sorts object keys by code point, never by locale collation', () => {
      // Proven localeCompare divergence fixture: ICU collation orders these as
      // a_b, a-b, a!, Aa, ab under en — code-point order is Aa, a!, a-b, a_b, ab.
      const value = { 'a-b': 1, ab: 2, a_b: 3, Aa: 4, 'a!': 5 }
      expect(canonicalJsonStringify(value)).toBe('{"Aa":4,"a!":5,"a-b":1,"a_b":3,"ab":2}')
    })

    test('diverges deliberately from localeCompare ordering for the hazard fixture', () => {
      // The exact pairs below flip sign between code-point and ICU collation
      // ('-'/'_' are variable-weight punctuation in CLDR; case differs in
      // 'schemaVersion' vs 'schemas'): this is the hazard the code-point
      // comparator pins down. See canonical-json.ts JSDoc.
      expect(Math.sign('a-b'.localeCompare('a_b', 'en'))).not.toBe(codePointCompare('a-b', 'a_b'))
      expect(Math.sign('Aa'.localeCompare('a!', 'en'))).not.toBe(codePointCompare('Aa', 'a!'))
      expect(Math.sign('schemaVersion'.localeCompare('schemas'))).not.toBe(
        codePointCompare('schemaVersion', 'schemas')
      )
    })

    test('is insertion-order independent', () => {
      const left = { b: 1, a: 2, C: 3 }
      const right = { C: 3, a: 2, b: 1 }
      expect(canonicalJsonStringify(left)).toBe(canonicalJsonStringify(right))
      expect(canonicalJsonStringify(left)).toBe('{"C":3,"a":2,"b":1}')
    })

    test('sorts keys at every nesting level', () => {
      const value = { z: { y: 1, a: { m: true, B: null } }, a: [{ d: 1, c: 2 }] }
      expect(canonicalJsonStringify(value)).toBe(
        '{"a":[{"c":2,"d":1}],"z":{"a":{"B":null,"m":true},"y":1}}'
      )
    })

    test('normalizes numeric-like keys that JavaScript hoists during iteration', () => {
      const value = { 2: 'b', 1: 'a', 10: 'c', x: 'd' }
      expect(canonicalJsonStringify(value)).toBe('{"1":"a","10":"c","2":"b","x":"d"}')
    })

    test('serializes unicode keys by code point', () => {
      const value = { é: 1, z: 2, 華: 3 }
      expect(canonicalJsonStringify(value)).toBe('{"z":2,"é":1,"華":3}')
    })
  })

  describe('undefined handling', () => {
    test('omits undefined-valued object entries at any depth', () => {
      expect(canonicalJsonStringify({ a: 1, b: undefined, c: { d: undefined, e: 2 } })).toBe(
        '{"a":1,"c":{"e":2}}'
      )
    })

    test('preserves array order and maps undefined elements to null', () => {
      expect(canonicalJsonStringify([undefined, 1, null])).toBe('[null,1,null]')
      expect(canonicalJsonStringify({ list: [{ b: undefined, a: 1 }, undefined] })).toBe(
        '{"list":[{"a":1},null]}'
      )
    })

    test('serializes a document-root undefined as null', () => {
      expect(canonicalJsonStringify(undefined)).toBe('null')
    })
  })

  describe('numeric edges', () => {
    test('maps NaN and infinities to null like JSON.stringify', () => {
      expect(canonicalJsonStringify({ a: NaN, b: Infinity, c: -Infinity })).toBe(
        '{"a":null,"b":null,"c":null}'
      )
    })

    test('normalizes -0 to 0', () => {
      expect(canonicalJsonStringify({ a: -0 })).toBe('{"a":0}')
      expect(canonicalJsonStringify(-0)).toBe('0')
      expect(canonicalJsonStringify({ a: -0 })).toBe(canonicalJsonStringify({ a: 0 }))
    })
  })

  describe('rejected values', () => {
    test('throws TypeError for bigint, functions and symbols', () => {
      expect(() => canonicalJsonStringify({ a: 1n })).toThrow(TypeError)
      expect(() => canonicalJsonStringify({ a: () => 1 })).toThrow(TypeError)
      expect(() => canonicalJsonStringify({ a: Symbol('x') })).toThrow(TypeError)
    })

    test('throws TypeError instead of silently lossy-serializing non-plain objects', () => {
      expect(() => canonicalJsonStringify({ at: new Date(0) })).toThrow(TypeError)
      expect(() => canonicalJsonStringify(new Map([['a', 1]]))).toThrow(TypeError)
      class Wrapper {
        value = 1
      }
      expect(() => canonicalJsonStringify(new Wrapper())).toThrow(TypeError)
    })
  })

  describe('structure', () => {
    test('handles empty containers and scalar roots', () => {
      expect(canonicalJsonStringify({})).toBe('{}')
      expect(canonicalJsonStringify([])).toBe('[]')
      expect(canonicalJsonStringify('hello')).toBe('"hello"')
      expect(canonicalJsonStringify(null)).toBe('null')
      expect(canonicalJsonStringify(true)).toBe('true')
      expect(canonicalJsonStringify(42.5)).toBe('42.5')
    })

    test('round-trips through JSON.parse', () => {
      const value = { a: [1, { b: null, c: 'x' }], d: { e: false } }
      expect(JSON.parse(canonicalJsonStringify(value))).toEqual(value)
    })

    test('is byte-stable for deeply nested values', () => {
      const value = { a: { b: { c: { d: [1, { e: null }] } } } }
      const once = canonicalJsonStringify(value)
      expect(canonicalJsonStringify(JSON.parse(once))).toBe(once)
      expect(once).toBe('{"a":{"b":{"c":{"d":[1,{"e":null}]}}}}')
    })
  })
})

describe('canonicalJsonStringify parity with the reference serializer', () => {
  // The pre-optimization implementation, kept verbatim as the oracle.
  const reference = (value) => {
    if (value === undefined || value === null) return 'null'
    const type = typeof value
    if (type === 'string' || type === 'boolean') return JSON.stringify(value)
    if (type === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null'
    if (type === 'bigint' || type === 'function' || type === 'symbol')
      throw new TypeError(`canonicalJsonStringify: cannot serialize ${type} value`)
    if (Array.isArray(value)) return `[${value.map((entry) => reference(entry)).join(',')}]`
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError('canonicalJsonStringify: value is not JSON-compatible plain data')
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([left], [right]) => codePointCompare(left, right))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${reference(entry)}`).join(',')}}`
  }

  const nullPrototype = Object.assign(Object.create(null), { b: 1, a: [undefined, 2] })
  const fixtures = [
    undefined,
    null,
    true,
    'text "quoted" \n \u2028 \ud800',
    0,
    -0,
    1.5e300,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    [],
    {},
    [undefined, null, { z: undefined, y: 1 }],
    { 'a-b': 1, ab: 2, a_b: 3, Aa: 4, 'a!': 5, '': 6, '😀': 7, '\uffff': 8 },
    {
      nested: { b: [{ d: 1, c: undefined, a: [] }], a: { y: null, x: false } },
      1: 'x',
      10: 'y',
      2: 'z',
    },
    nullPrototype,
    { __proto__: null, only: undefined },
  ]

  test.each(fixtures.map((fixture, index) => [index, fixture]))(
    'matches byte for byte on fixture %d',
    (_index, fixture) => {
      expect(canonicalJsonStringify(fixture)).toBe(reference(fixture))
    }
  )

  test('rejects the same unsupported values with the same errors', () => {
    const unsupported = [
      1n,
      () => 1,
      Symbol('x'),
      new Date(0),
      new Map(),
      Object.create({ inherited: true }),
      { deep: [{ bad: 1n }] },
      [Symbol('y')],
    ]
    for (const value of unsupported) {
      let expected
      try {
        reference(value)
      } catch (error) {
        expected = error
      }
      expect(expected).toBeInstanceOf(TypeError)
      expect(() => canonicalJsonStringify(value)).toThrow(expected.message)
    }
  })
})
