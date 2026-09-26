import { expect, test } from 'bun:test'
import { observeReferenceRetentionWindow } from './retention-reference-window.ts'

const day = 24 * 60 * 60 * 1000
const now = '2026-09-26T00:00:00.000Z'
const facts = { now, unreferencedSince: null, pendingReferences: 0, policyRetainMs: 90 * day }

test('first unreferenced observation starts a full post-release interval', () => {
  expect(observeReferenceRetentionWindow(facts)).toEqual({
    unreferencedSince: now,
    retentionExpiresAt: '2026-12-25T00:00:00.000Z',
  })
})

test('a durable observation survives later passes without restarting its interval', () => {
  expect(
    observeReferenceRetentionWindow({
      ...facts,
      now: '2027-01-01T00:00:00.000Z',
      unreferencedSince: now,
    })
  ).toEqual({ unreferencedSince: now, retentionExpiresAt: '2026-12-25T00:00:00.000Z' })
})

test('renewed references clear the clock and the next release starts a fresh interval', () => {
  const pinned = observeReferenceRetentionWindow({
    ...facts,
    unreferencedSince: now,
    pendingReferences: 1,
  })
  expect(pinned).toEqual({ unreferencedSince: null })
  expect(
    observeReferenceRetentionWindow({ ...facts, now: '2026-10-01T00:00:00.000Z', ...pinned })
  ).toEqual({
    unreferencedSince: '2026-10-01T00:00:00.000Z',
    retentionExpiresAt: '2026-12-30T00:00:00.000Z',
  })
})

test('unbounded policy does not manufacture an expiry', () => {
  expect(observeReferenceRetentionWindow({ ...facts, policyRetainMs: null })).toEqual({
    unreferencedSince: null,
  })
})

test('a backward clock never shortens a previously observed interval', () => {
  expect(
    observeReferenceRetentionWindow({ ...facts, unreferencedSince: '2026-10-01T00:00:00.000Z' })
  ).toEqual({
    unreferencedSince: '2026-10-01T00:00:00.000Z',
    retentionExpiresAt: '2026-12-30T00:00:00.000Z',
  })
})

test('invalid reference counts, durations and timestamps fail closed', () => {
  for (const pendingReferences of [-1, 0.5, Number.NaN])
    expect(() => observeReferenceRetentionWindow({ ...facts, pendingReferences })).toThrow()
  for (const policyRetainMs of [0, -1, Number.NaN])
    expect(() => observeReferenceRetentionWindow({ ...facts, policyRetainMs })).toThrow()
  expect(() =>
    observeReferenceRetentionWindow({ ...facts, unreferencedSince: 'not-an-instant' })
  ).toThrow()
  expect(() =>
    observeReferenceRetentionWindow({ ...facts, policyRetainMs: Number.MAX_SAFE_INTEGER })
  ).toThrow()
})
