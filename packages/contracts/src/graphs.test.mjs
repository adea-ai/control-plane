import { expect, test } from 'bun:test'
import { GraphInputSchema } from './graphs.ts'

test('graph input preserves JSON data without invoking accessors', () => {
  const input = { objective: 'Review', values: [null, 1, true, { name: 'task' }] }
  expect(GraphInputSchema.parse(input)).toEqual(input)
  let calls = 0
  const accessor = {
    get value() {
      calls++
      return 'hidden'
    },
  }
  expect(GraphInputSchema.safeParse(accessor).success).toBe(false)
  expect(calls).toBe(0)
})

test('graph input rejects lossy arrays and enforces serialized byte size', () => {
  const sparse = []
  sparse.length = 5
  const extra = [1]
  extra.hidden = 'omitted by JSON'
  for (const values of [sparse, extra, Array.from({ length: 5_000 }, () => 0)]) {
    expect(GraphInputSchema.safeParse({ values }).success).toBe(false)
  }
  expect(GraphInputSchema.safeParse({ value: '\u0000'.repeat(12_000) }).success).toBe(false)
})

test('graph input rejects cycles, unsafe prototypes and executable values', () => {
  const cyclic = {}
  cyclic.self = cyclic
  for (const value of [
    cyclic,
    { value: Infinity },
    { value: () => 1 },
    { value: undefined },
    { value: new Date() },
    JSON.parse('{"__proto__":{"polluted":true}}'),
  ]) {
    expect(GraphInputSchema.safeParse(value).success).toBe(false)
  }
})
