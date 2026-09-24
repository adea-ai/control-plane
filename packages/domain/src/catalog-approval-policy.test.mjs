import { describe, expect, test } from 'bun:test'
import { evaluateCatalogApproval } from './index.ts'

const digest = (character) => `sha256:${character.repeat(64)}`

const version = (overrides = {}) => ({
  revision: 2,
  contentDigest: digest('a'),
  publishedAt: '2026-09-01T12:00:00.000Z',
  ...overrides,
})

const approval = (overrides = {}) => ({
  versionKind: 'agent_profile',
  versionId: 'pfv_01JABCDEF0123456789ABCDEFG',
  revision: 2,
  contentDigest: digest('a'),
  decision: 'approved',
  actorPrincipalRef: 'principal://agent-hq/user/42',
  decidedAt: '2026-09-20T12:00:00.000Z',
  ...overrides,
})

const policy = (overrides = {}) => ({ required: true, ...overrides })

describe('catalog approval gating semantics', () => {
  test('is not enforced without a policy or when required is false', () => {
    expect(evaluateCatalogApproval({ version: version() })).toEqual({ verdict: 'not_required' })
    expect(
      evaluateCatalogApproval({ policy: policy({ required: false }), version: version() })
    ).toEqual({ verdict: 'not_required' })
    // Even a recorded rejection enforces nothing while the policy is off.
    expect(
      evaluateCatalogApproval({
        policy: policy({ required: false }),
        version: version(),
        approval: approval({ decision: 'rejected' }),
      })
    ).toEqual({ verdict: 'not_required' })
  })

  test('accepts a matching approved decision and reports its actor', () => {
    expect(
      evaluateCatalogApproval({ policy: policy(), version: version(), approval: approval() })
    ).toEqual({ verdict: 'approved', reason: 'principal://agent-hq/user/42' })
  })

  test('a recorded rejection blocks even a grandfathered version', () => {
    expect(
      evaluateCatalogApproval({
        policy: policy({ requiredSince: '2026-09-15T00:00:00.000Z' }),
        version: version({ publishedAt: '2026-09-01T12:00:00.000Z' }),
        approval: approval({ decision: 'rejected' }),
      })
    ).toMatchObject({ verdict: 'rejected' })
  })

  test('grandfathers versions published before the explicit cutover', () => {
    expect(
      evaluateCatalogApproval({
        policy: policy({ requiredSince: '2026-09-15T00:00:00.000Z' }),
        version: version({ publishedAt: '2026-09-01T12:00:00.000Z' }),
      })
    ).toEqual({ verdict: 'grandfathered', reason: '2026-09-15T00:00:00.000Z' })
    // Exactly at the boundary is NOT grandfathered (strictly-before rule).
    expect(
      evaluateCatalogApproval({
        policy: policy({ requiredSince: '2026-09-01T12:00:00.000Z' }),
        version: version({ publishedAt: '2026-09-01T12:00:00.000Z' }),
      })
    ).toMatchObject({ verdict: 'missing' })
  })

  test('fails closed for missing or stale-bound decisions', () => {
    expect(evaluateCatalogApproval({ policy: policy(), version: version() })).toEqual({
      verdict: 'missing',
      reason: 'NO_DECISION_RECORDED',
    })
    expect(
      evaluateCatalogApproval({
        policy: policy(),
        version: version(),
        approval: approval({ revision: 1 }),
      })
    ).toEqual({ verdict: 'missing', reason: 'DECISION_BINDING_STALE' })
    expect(
      evaluateCatalogApproval({
        policy: policy(),
        version: version(),
        approval: approval({ contentDigest: digest('f') }),
      })
    ).toEqual({ verdict: 'missing', reason: 'DECISION_BINDING_STALE' })
  })

  test('without a cutover window every version needs a decision', () => {
    expect(
      evaluateCatalogApproval({
        policy: policy(),
        version: version({ publishedAt: '2020-01-01T00:00:00.000Z' }),
      })
    ).toMatchObject({ verdict: 'missing' })
    // A version with no publication timestamp cannot be grandfathered either.
    expect(
      evaluateCatalogApproval({
        policy: policy({ requiredSince: '2026-09-15T00:00:00.000Z' }),
        version: version({ publishedAt: undefined }),
      })
    ).toMatchObject({ verdict: 'missing' })
  })
})
