import { expect, test } from 'bun:test'
import { contextCommandResultDigest } from './context-result-integrity.ts'

const semantic = {
  payloadHash: `sha256:${'a'.repeat(64)}`,
  status: 'succeeded',
  completedAt: '2026-09-27T12:00:00.000Z',
  result: { data: { bundle: 'opaque' } },
}

test('context result semantic digest stays byte-compatible after wire refinements', () => {
  const expected = 'sha256:544b77cd62a04c3a377bcc9e9dc1ae4c718108f4676f32c5770fa2cef7c3d41a'
  expect(contextCommandResultDigest(semantic)).toBe(expected)
  expect(
    contextCommandResultDigest({
      ...semantic,
      sequence: 99,
      protocolVersion: { major: 1, minor: 7 },
    })
  ).toBe(expected)
})

test('context result semantic hashing retains strict field validation', () => {
  expect(() => contextCommandResultDigest(null)).toThrow()
  expect(() => contextCommandResultDigest({ ...semantic, payloadHash: 'invalid' })).toThrow()
  expect(() => contextCommandResultDigest({ ...semantic, result: { artifact: {} } })).toThrow()
})
