import { expect, test } from 'bun:test'
import { ChildProgressReferenceAuthorization } from './child-progress-evidence.ts'

// The lazy, current-authorization reference authority of CP #1019. A packet keeps
// its references opaque, so every read asks the current authorization state again.
//
// Every fixture is synthetic: a reference is an opaque identifier, the reader
// answers a state, and no reusable secret, credential or provider is read.

const terminalResult = { kind: 'terminal_result', artifactId: 'art_child_result_01' }
const interaction = { kind: 'interaction', interactionId: 'int_awaiting_input_01' }

/** A reader whose answer is decided by the test, and that counts its reads. */
function reader(answer) {
  const reads = []
  return {
    reads,
    readCurrent: async (reference) => {
      reads.push(reference)
      return typeof answer === 'function' ? answer(reference) : answer
    },
  }
}

test('answers from the current authorization state on every call', async () => {
  let authorized = true
  const source = reader(() => (authorized ? { status: 'authorized' } : { status: 'revoked' }))
  const authority = new ChildProgressReferenceAuthorization(source)

  expect(await authority.authorize(terminalResult)).toEqual({ status: 'authorized' })
  // The state changes between the two reads: a cached verdict would still answer
  // 'authorized' here, which is exactly the capture-time snapshot that must not happen.
  authorized = false
  expect(await authority.authorize(terminalResult)).toEqual({
    status: 'forbidden',
    reason: 'revoked',
  })
  expect(source.reads).toHaveLength(2)
})

test('distinguishes a revoked reference from one the caller was never authorized for', async () => {
  const revoked = new ChildProgressReferenceAuthorization(reader({ status: 'revoked' }))
  expect(await revoked.authorize(terminalResult)).toEqual({
    status: 'forbidden',
    reason: 'revoked',
  })

  const unauthorized = new ChildProgressReferenceAuthorization(reader({ status: 'not_authorized' }))
  expect(await unauthorized.authorize(interaction)).toEqual({
    status: 'forbidden',
    reason: 'not_authorized',
  })
})

test('reports a reference that is no longer retained as unavailable', async () => {
  const authority = new ChildProgressReferenceAuthorization(reader({ status: 'missing' }))
  expect(await authority.authorize(terminalResult)).toEqual({
    status: 'unavailable',
    reason: 'missing',
  })
})

test('fails closed when the live read fails', async () => {
  const source = reader(() => {
    throw new Error('the authorization authority is unavailable')
  })
  const authority = new ChildProgressReferenceAuthorization(source)

  expect(await authority.authorize(terminalResult)).toEqual({
    status: 'unavailable',
    reason: 'missing',
  })
})

test('fails closed when the live read answers something unexpected', async () => {
  for (const answer of [
    undefined,
    null,
    {},
    { status: 'approved' },
    { status: 'revoked', extra: 1 },
  ]) {
    const authority = new ChildProgressReferenceAuthorization(reader(answer))
    // An answer the authority does not recognize is not an authorization, and a
    // revoked answer that carries extra fields is still a refusal.
    const expected =
      typeof answer === 'object' && answer !== null && answer.status === 'revoked'
        ? { status: 'forbidden', reason: 'revoked' }
        : { status: 'unavailable', reason: 'missing' }
    expect(await authority.authorize(terminalResult)).toEqual(expected)
  }
})

test('drops anything the live read carries beyond the verdict', async () => {
  const authority = new ChildProgressReferenceAuthorization(
    reader({ status: 'authorized', payload: 'the private artifact content' })
  )
  const answer = await authority.authorize(terminalResult)

  expect(answer).toEqual({ status: 'authorized' })
  expect(answer).not.toHaveProperty('payload')
})

test('refuses a malformed reference without asking the authority', async () => {
  const source = reader({ status: 'authorized' })
  const authority = new ChildProgressReferenceAuthorization(source)

  for (const reference of [
    undefined,
    null,
    {},
    { kind: 'terminal_result' },
    { kind: 'interaction' },
    { kind: 'terminal_result', artifactId: '' },
    { kind: 'unknown', artifactId: 'art_child_result_01' },
  ]) {
    expect(await authority.authorize(reference)).toEqual({
      status: 'forbidden',
      reason: 'not_authorized',
    })
  }
  // A malformed reference never becomes a live read.
  expect(source.reads).toHaveLength(0)
})

test('carries a verdict only, never the referenced payload', async () => {
  const source = reader({ status: 'authorized' })
  const authority = new ChildProgressReferenceAuthorization(source)

  const answer = await authority.authorize(terminalResult)
  expect(Object.keys(answer).toSorted()).toEqual(['status'])
  expect(answer).not.toHaveProperty('artifactId')
  expect(answer).not.toHaveProperty('payload')
})

test('refuses an oversized reference without a live read', async () => {
  const source = reader({ status: 'authorized' })
  const authority = new ChildProgressReferenceAuthorization(source)

  // The repository's own reference constraints bound an identifier to 256 characters.
  const oversized = { kind: 'terminal_result', artifactId: 'a'.repeat(257) }
  expect(await authority.authorize(oversized)).toEqual({
    status: 'forbidden',
    reason: 'not_authorized',
  })
  expect(source.reads).toHaveLength(0)

  // The boundary is exactly the constraint: 256 characters is still accepted.
  const bounded = { kind: 'terminal_result', artifactId: 'a'.repeat(256) }
  expect(await authority.authorize(bounded)).toEqual({ status: 'authorized' })
  expect(source.reads).toHaveLength(1)
})

test('refuses a malformed reference without a live read', async () => {
  const source = reader({ status: 'authorized' })
  const authority = new ChildProgressReferenceAuthorization(source)

  for (const reference of [
    { kind: 'terminal_result', artifactId: 'has a space' },
    { kind: 'terminal_result', artifactId: '/leading-slash' },
    { kind: 'terminal_result', artifactId: '' },
    { kind: 'terminal_result', artifactId: 42 },
    { kind: 'interaction', interactionId: 'has a space' },
    { kind: 'interaction', interactionId: '' },
    { kind: 'unknown', artifactId: 'art_child_result_01' },
    { artifactId: 'art_child_result_01' },
  ]) {
    expect(await authority.authorize(reference)).toEqual({
      status: 'forbidden',
      reason: 'not_authorized',
    })
  }
  // Not one of them became a live read.
  expect(source.reads).toHaveLength(0)
})

test('the reader never receives the extra fields a reference carries', async () => {
  const source = reader({ status: 'authorized' })
  const authority = new ChildProgressReferenceAuthorization(source)

  const answer = await authority.authorize({
    kind: 'terminal_result',
    artifactId: 'art_child_result_01',
    payload: 'the private artifact content',
  })

  expect(answer).toEqual({ status: 'authorized' })
  expect(source.reads).toHaveLength(1)
  // The reader is handed a freshly constructed reference: the kind and the identifier
  // alone, and never the extra payload.
  expect(source.reads[0]).toEqual({
    kind: 'terminal_result',
    artifactId: 'art_child_result_01',
  })
  expect(Object.keys(source.reads[0]).toSorted()).toEqual(['artifactId', 'kind'])
  expect(source.reads[0]).not.toHaveProperty('payload')
})
