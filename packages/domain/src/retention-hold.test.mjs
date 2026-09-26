import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import {
  RetentionHoldAdministration,
  RetentionHoldError,
  countMatchingActiveRetentionHolds,
  sameRetentionHoldIdentity,
} from './index.ts'

const workspaceId = 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const otherWorkspaceId = 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAW'
const projectId = 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const otherProjectId = 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAW'
const session = {
  actorPrincipalRef: 'operator:os-user:test-owner',
  authorityRef: 'authority:sqlite:local-os',
}
const policy = {
  'context-packages': {
    owner: 'workspace-owner',
    scopes: ['class', 'workspace', 'project'],
    reasonCodes: ['legal-case', 'regulatory-review'],
  },
  'runtime-ledgers': {
    owner: 'runtime-owner',
    scopes: ['class', 'workspace'],
    reasonCodes: ['legal-case'],
  },
  'evaluation-runs': {
    owner: 'release-owner',
    scopes: ['class'],
    reasonCodes: ['legal-case'],
  },
}

class MemoryRepository {
  #holds = new Map()

  async get(holdId) {
    return this.#holds.get(holdId)
  }

  async create(hold) {
    const current = this.#holds.get(hold.holdId)
    if (current) {
      if (!sameRetentionHoldIdentity(current, hold)) {
        throw new RetentionHoldError('RETENTION_HOLD_ID_CONFLICT')
      }
      return { created: false, hold: current }
    }
    this.#holds.set(hold.holdId, hold)
    return { created: true, hold }
  }

  async release(input) {
    const current = this.#holds.get(input.holdId)
    if (!current) throw new RetentionHoldError('RETENTION_HOLD_NOT_FOUND')
    if (current.release) {
      if (
        current.release.requestId === input.release.requestId &&
        current.release.releasedBy.actorPrincipalRef ===
          input.release.releasedBy.actorPrincipalRef &&
        current.release.releasedBy.authorityRef === input.release.releasedBy.authorityRef
      ) {
        return { released: false, hold: current }
      }
      throw new RetentionHoldError('RETENTION_HOLD_ALREADY_RELEASED')
    }
    if (current.revision !== input.expectedRevision) {
      throw new RetentionHoldError('RETENTION_HOLD_REVISION_CONFLICT')
    }
    const released = { ...current, revision: current.revision + 1, release: input.release }
    this.#holds.set(input.holdId, released)
    return { released: true, hold: released }
  }
}

const createRequest = (overrides = {}) => ({
  operation: 'create',
  holdId: randomUUID(),
  classId: 'context-packages',
  scope: { kind: 'project', workspaceId, projectId },
  reasonCode: 'legal-case',
  ...session,
  ...overrides,
})

function administration(options = {}) {
  return new RetentionHoldAdministration({
    repository: new MemoryRepository(),
    policy,
    verifiedSession: async () => session,
    authorizeOwner: async () => true,
    now: () => new Date('2026-09-26T12:00:00.000Z'),
    ...options,
  })
}

test('administration requires host-verified identity and an explicit owner authorizer', () => {
  expect(
    () =>
      new RetentionHoldAdministration({
        repository: new MemoryRepository(),
        policy,
        authorizeOwner: async () => true,
      })
  ).toThrow('RETENTION_HOLD_SESSION_REQUIRED')
  expect(
    () =>
      new RetentionHoldAdministration({
        repository: new MemoryRepository(),
        policy,
        verifiedSession: async () => session,
      })
  ).toThrow('RETENTION_HOLD_SESSION_REQUIRED')
  expect(
    () =>
      new RetentionHoldAdministration({
        repository: new MemoryRepository(),
        policy,
        verifiedSession: async () => undefined,
        authorizeOwner: async () => true,
      })
  ).not.toThrow()
})

test('missing verified session, mismatched actor claims, and owner denial all fail closed', async () => {
  const request = createRequest()
  await expect(
    administration({ verifiedSession: async () => undefined }).apply(request)
  ).rejects.toThrow('RETENTION_HOLD_SESSION_REQUIRED')
  await expect(
    administration().apply({ ...request, actorPrincipalRef: 'operator:caller-supplied' })
  ).rejects.toThrow('RETENTION_HOLD_ACTOR_MISMATCH')
  await expect(
    administration({ authorizeOwner: async () => false }).apply(request)
  ).rejects.toThrow('RETENTION_HOLD_OWNER_DENIED')
})

test('configured class policy bounds classes, scopes, and reason codes', async () => {
  await expect(administration().apply(createRequest({ classId: 'unknown-class' }))).rejects.toThrow(
    'RETENTION_HOLD_CLASS_UNCONFIGURED'
  )
  await expect(
    administration().apply(
      createRequest({
        classId: 'evaluation-runs',
        scope: { kind: 'project', workspaceId, projectId },
      })
    )
  ).rejects.toThrow('RETENTION_HOLD_SCOPE_UNSUPPORTED')
  await expect(
    administration().apply(createRequest({ reasonCode: 'unconfigured-reason' }))
  ).rejects.toThrow('RETENTION_HOLD_REASON_UNSUPPORTED')
  await expect(
    administration().apply(
      createRequest({ scope: { kind: 'project', workspaceId: 'workspace-1', projectId } })
    )
  ).rejects.toThrow('RETENTION_HOLD_INPUT_INVALID')
})

test('inherited object keys never configure a hold class', async () => {
  expect(() =>
    countMatchingActiveRetentionHolds({ holds: [], target: { classId: 'constructor' }, policy })
  ).toThrow('RETENTION_HOLD_CLASS_UNCONFIGURED')
  await expect(
    administration().apply(createRequest({ classId: 'constructor', scope: { kind: 'class' } }))
  ).rejects.toThrow('RETENTION_HOLD_CLASS_UNCONFIGURED')
})

test('an explicitly owned constructor policy key remains a valid configured class', async () => {
  const configured = { ...policy, constructor: policy['context-packages'] }
  const result = await administration({ policy: configured }).apply(
    createRequest({ classId: 'constructor', scope: { kind: 'class' } })
  )
  expect(result.hold.classId).toBe('constructor')
  expect(
    countMatchingActiveRetentionHolds({
      holds: [result.hold],
      target: { classId: 'constructor', scope: { kind: 'class' } },
      policy: configured,
    })
  ).toBe(1)
})

test('records policy owner and verified provenance, never actor claims from the request', async () => {
  const repository = new MemoryRepository()
  const authorizations = []
  const service = administration({
    repository,
    authorizeOwner: async (input) => {
      authorizations.push(input)
      return true
    },
  })
  const request = createRequest()
  const result = await service.apply(request)
  expect(result.status).toBe('applied')
  expect(result.hold).toMatchObject({
    holdId: request.holdId,
    classId: 'context-packages',
    owner: 'workspace-owner',
    reasonCode: 'legal-case',
    createdBy: session,
    createdAt: '2026-09-26T12:00:00.000Z',
    revision: 0,
  })
  expect(authorizations).toEqual([
    {
      action: 'create',
      session,
      owner: 'workspace-owner',
      classId: 'context-packages',
      scope: request.scope,
    },
  ])
})

test('create replay after release stays released; changed immutable identity conflicts', async () => {
  const repository = new MemoryRepository()
  const service = administration({ repository })
  const request = createRequest()
  const created = await service.apply(request)
  const releaseRequest = {
    operation: 'release',
    holdId: request.holdId,
    requestId: randomUUID(),
    expectedRevision: 0,
    ...session,
  }
  const released = await service.apply(releaseRequest)
  expect(released.status).toBe('applied')
  expect(released.hold.revision).toBe(1)
  expect(released.hold.release?.releasedBy).toEqual(session)

  const replayed = await service.apply(request)
  expect(replayed.status).toBe('replayed')
  expect(replayed.hold).toEqual(released.hold)
  await expect(service.apply({ ...request, reasonCode: 'regulatory-review' })).rejects.toThrow(
    'RETENTION_HOLD_ID_CONFLICT'
  )
  await expect(
    service.apply({ ...releaseRequest, requestId: randomUUID(), expectedRevision: 1 })
  ).rejects.toThrow('RETENTION_HOLD_ALREADY_RELEASED')
  expect(created.hold.release).toBeUndefined()
})

test('release replays by release request identity and rejects stale revisions', async () => {
  const repository = new MemoryRepository()
  let tick = 0
  const service = administration({
    repository,
    now: () => new Date(Date.parse('2026-09-26T12:00:00.000Z') + tick++),
  })
  const request = createRequest()
  await service.apply(request)
  const releaseRequest = {
    operation: 'release',
    holdId: request.holdId,
    requestId: randomUUID(),
    expectedRevision: 0,
    ...session,
  }
  await expect(service.apply({ ...releaseRequest, expectedRevision: 1 })).rejects.toThrow(
    'RETENTION_HOLD_REVISION_CONFLICT'
  )
  const first = await service.apply(releaseRequest)
  const replay = await service.apply(releaseRequest)
  expect(first.status).toBe('applied')
  expect(replay.status).toBe('replayed')
  expect(replay.hold.release?.releasedAt).toBe(first.hold.release?.releasedAt)
})

test('matching count honors class, workspace, and project scopes and fails on incomplete scope', () => {
  const classHold = {
    holdId: randomUUID(),
    classId: 'context-packages',
    scope: { kind: 'class' },
    owner: 'workspace-owner',
    reasonCode: 'legal-case',
    createdAt: '2026-09-26T12:00:00.000Z',
    createdBy: session,
    revision: 0,
  }
  const workspaceHold = {
    ...classHold,
    holdId: randomUUID(),
    scope: { kind: 'workspace', workspaceId },
  }
  const projectHold = {
    ...classHold,
    holdId: randomUUID(),
    scope: { kind: 'project', workspaceId, projectId },
  }
  const otherProjectHold = {
    ...classHold,
    holdId: randomUUID(),
    scope: { kind: 'project', workspaceId: otherWorkspaceId, projectId: otherProjectId },
  }
  const holds = [classHold, workspaceHold, projectHold, otherProjectHold]
  expect(
    countMatchingActiveRetentionHolds({
      holds,
      policy,
      target: { classId: 'context-packages', scope: { kind: 'project', workspaceId, projectId } },
    })
  ).toBe(3)
  expect(
    countMatchingActiveRetentionHolds({
      holds,
      policy,
      target: {
        classId: 'context-packages',
        scope: { kind: 'project', workspaceId, projectId: otherProjectId },
      },
    })
  ).toBe(2)
  expect(() =>
    countMatchingActiveRetentionHolds({
      holds,
      policy,
      target: { classId: 'context-packages', scope: { kind: 'workspace', workspaceId } },
    })
  ).toThrow('RETENTION_HOLD_TARGET_SCOPE_MISSING')
  expect(() =>
    countMatchingActiveRetentionHolds({
      holds,
      policy,
      target: { classId: 'context-packages' },
    })
  ).toThrow('RETENTION_HOLD_TARGET_SCOPE_MISSING')
  expect(() =>
    countMatchingActiveRetentionHolds({
      holds: [{ ...classHold, scope: { kind: 'project', workspaceId, projectId: 'prj_bad' } }],
      policy,
      target: { classId: 'context-packages', scope: { kind: 'project', workspaceId, projectId } },
    })
  ).toThrow('RETENTION_HOLD_STORED_RECORD_INVALID')
})
