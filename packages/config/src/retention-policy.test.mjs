import { describe, expect, test } from 'bun:test'
import {
  MAXIMUM_COMMAND_LIFETIME_MS,
  RetentionClassIdSchema,
  decidedRetentionPolicy,
  loadRetentionPolicy,
  rejectionKeyEpochMs,
  retentionClassPolicy,
} from './retention-policy.js'

const day = 24 * 60 * 60 * 1_000

describe('retention policy (#194 decisions)', () => {
  test('the decided policy covers every class with a duration and hold owner', () => {
    const policy = loadRetentionPolicy()
    expect(policy.classes).toHaveLength(RetentionClassIdSchema.options.length)
    for (const id of RetentionClassIdSchema.options) {
      const entry = retentionClassPolicy(policy, id)
      expect(entry.holdOwner.length).toBeGreaterThan(0)
      expect(entry.retainMs === null || entry.retainMs > 0).toBe(true)
    }
  })

  test('accepted baselines are preserved rather than re-invented', () => {
    const policy = decidedRetentionPolicy
    expect(retentionClassPolicy(policy, 'command-inbox').retainMs).toBe(30 * day)
    expect(retentionClassPolicy(policy, 'execution-events').retainMs).toBe(30 * day)
    expect(retentionClassPolicy(policy, 'artifacts').retainMs).toBe(90 * day)
    expect(retentionClassPolicy(policy, 'backups').retainMs).toBe(7 * day)
  })

  test('reference-governed classes are unbounded instead of age-swept', () => {
    const policy = decidedRetentionPolicy
    for (const id of [
      'project-state',
      'state-proposals',
      'checkpoints',
      'native-admission-fences',
    ]) {
      expect(retentionClassPolicy(policy, id).retainMs).toBeNull()
    }
  })

  test('a duplicate class is rejected', () => {
    const classes = decidedRetentionPolicy.classes.map((entry) => ({ ...entry }))
    classes.push({ ...classes[0] })
    expect(() => loadRetentionPolicy({ ...decidedRetentionPolicy, classes })).toThrow()
  })

  test('a missing class is rejected', () => {
    const classes = decidedRetentionPolicy.classes.filter((entry) => entry.id !== 'usage')
    expect(() => loadRetentionPolicy({ ...decidedRetentionPolicy, classes })).toThrow()
  })

  test('a non-positive duration is rejected', () => {
    const classes = decidedRetentionPolicy.classes.map((entry) =>
      entry.id === 'command-inbox' ? { ...entry, retainMs: 0 } : { ...entry }
    )
    expect(() => loadRetentionPolicy({ ...decidedRetentionPolicy, classes })).toThrow()
  })

  test('an unparseable effective instant and empty provenance are rejected', () => {
    expect(() =>
      loadRetentionPolicy({ ...decidedRetentionPolicy, effectiveAt: 'not-an-instant' })
    ).toThrow()
    expect(() => loadRetentionPolicy({ ...decidedRetentionPolicy, provenance: '' })).toThrow()
  })

  test('the rejection-key epoch is inbox retention plus the maximum command lifetime', () => {
    expect(rejectionKeyEpochMs(decidedRetentionPolicy)).toBe(30 * day + MAXIMUM_COMMAND_LIFETIME_MS)
  })

  test('an unbounded inbox cannot define a finite rejection-key epoch', () => {
    const classes = decidedRetentionPolicy.classes.map((entry) =>
      entry.id === 'command-inbox' ? { ...entry, retainMs: null } : { ...entry }
    )
    const policy = loadRetentionPolicy({ ...decidedRetentionPolicy, classes })
    expect(() => rejectionKeyEpochMs(policy)).toThrow('RETENTION_EPOCH_REQUIRES_BOUNDED_INBOX')
  })

  test('an unconfigured class is reported by name', () => {
    const policy = loadRetentionPolicy()
    expect(() => retentionClassPolicy({ ...policy, classes: [] }, 'usage')).toThrow(
      'RETENTION_CLASS_NOT_CONFIGURED:usage'
    )
  })
})
