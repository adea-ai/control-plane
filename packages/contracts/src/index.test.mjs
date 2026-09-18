import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { URL } from 'node:url'
import {
  AgentHqExecutionEventEnvelopeSchema,
  ArtifactReferenceSchema,
  ContractDeprecationSchema,
  ContractVersionSchema,
  ErrorClassSchema,
  EventEnvelopeSchema,
  IdentifierSchemas,
  PublicContractFixtures,
  PublicContractManifest,
  ReadRequestEnvelopeSchema,
  ResponseEnvelopeSchema,
  CursorSchema,
  decodeCursor,
  encodeCursor,
  RuntimeReadModelEnvelopeSchema,
  ServiceCredentialClaimsSchema,
  ServicePrincipalSchema,
  StateChangingCommandEnvelopeSchema,
  UsageEnvelopeSchema,
  assessContractCompatibility,
  negotiateContractVersion,
} from './index.ts'

describe('canonical identifiers', () => {
  test('accepts only the canonical opaque prefix for each identifier kind', () => {
    const fixtures = {
      requestId: 'req_01JABCDEF0123456789ABCDEFG',
      commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
      workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
      projectId: 'prj_01JABCDEF0123456789ABCDEFG',
      taskId: 'tsk_01JABCDEF0123456789ABCDEFG',
      agentId: 'agt_01JABCDEF0123456789ABCDEFG',
      profileId: 'prf_01JABCDEF0123456789ABCDEFG',
      profileVersionId: 'pfv_01JABCDEF0123456789ABCDEFG',
      skillId: 'skl_01JABCDEF0123456789ABCDEFG',
      skillVersionId: 'skv_01JABCDEF0123456789ABCDEFG',
      executionId: 'exe_01JABCDEF0123456789ABCDEFG',
      attemptId: 'att_01JABCDEF0123456789ABCDEFG',
      workflowId: 'wfl_01JABCDEF0123456789ABCDEFG',
      interactionId: 'int_01JABCDEF0123456789ABCDEFG',
      runtimeDefinitionId: 'rtd_01JABCDEF0123456789ABCDEFG',
      runtimeNodeRefId: 'rnr_01JABCDEF0123456789ABCDEFG',
      runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFG',
      externalSessionId: 'ses_01JABCDEF0123456789ABCDEFG',
      projectStateItemId: 'psi_01JABCDEF0123456789ABCDEFG',
      stateMutationId: 'stm_01JABCDEF0123456789ABCDEFG',
      statePromotionProposalId: 'spp_01JABCDEF0123456789ABCDEFG',
      contextPackageId: 'ctx_01JABCDEF0123456789ABCDEFG',
      executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
      artifactId: 'art_01JABCDEF0123456789ABCDEFG',
      eventId: 'evt_01JABCDEF0123456789ABCDEFG',
      traceId: 'trc_01JABCDEF0123456789ABCDEFG',
    }

    for (const [kind, value] of Object.entries(fixtures)) {
      expect(IdentifierSchemas[kind].parse(value)).toBe(value)
      expect(IdentifierSchemas[kind].safeParse(`wrong_${value}`).success).toBe(false)
    }
  })

  test('rejects raw database and runtime-native identifier shapes', () => {
    expect(
      IdentifierSchemas.executionId.safeParse('550e8400-e29b-41d4-a716-446655440000').success
    ).toBe(false)
    expect(IdentifierSchemas.workflowId.safeParse('temporal/workflow/run-123').success).toBe(false)
    expect(
      IdentifierSchemas.runtimeNodeRefId.safeParse('/Users/example/runtime-node').success
    ).toBe(false)
  })
})

describe('opaque cursor pagination', () => {
  test('round-trips a deterministic cursor without exposing transport fields', () => {
    const cursor = encodeCursor({
      sortKey: '2026-08-28T00:00:00.000Z',
      id: 'rtc_01JABCDEF0123456789ABCDEFG',
    })
    expect(cursor).toBe(
      encodeCursor({ sortKey: '2026-08-28T00:00:00.000Z', id: 'rtc_01JABCDEF0123456789ABCDEFG' })
    )
    expect(CursorSchema.parse(cursor)).toBe(cursor)
    expect(decodeCursor(cursor)).toEqual({
      sortKey: '2026-08-28T00:00:00.000Z',
      id: 'rtc_01JABCDEF0123456789ABCDEFG',
    })
    expect(() => decodeCursor('cur_invalid')).toThrow()
  })
})

describe('contract version compatibility', () => {
  test('classifies same-major additive versions in both consumption directions', () => {
    expect(
      assessContractCompatibility({
        consumer: { major: 1, minor: 2 },
        producer: { major: 1, minor: 4 },
      })
    ).toEqual({ compatible: true, direction: 'backward-compatible' })
    expect(
      assessContractCompatibility({
        consumer: { major: 1, minor: 4 },
        producer: { major: 1, minor: 2 },
      })
    ).toEqual({ compatible: true, direction: 'forward-compatible' })
  })

  test('rejects breaking major changes and negotiates the highest common boundary', () => {
    expect(
      assessContractCompatibility({
        consumer: { major: 1, minor: 9 },
        producer: { major: 2, minor: 0 },
      })
    ).toEqual({ compatible: false, direction: 'breaking' })

    expect(
      negotiateContractVersion(
        [
          { major: 1, minor: 3 },
          { major: 2, minor: 1 },
        ],
        [
          { major: 1, minor: 5 },
          { major: 2, minor: 0 },
        ]
      )
    ).toEqual({ major: 2, minor: 0 })
    expect(negotiateContractVersion([{ major: 1, minor: 0 }], [{ major: 2, minor: 0 }])).toBe(
      undefined
    )
  })

  test('rejects invalid version numbers', () => {
    expect(ContractVersionSchema.safeParse({ major: 0, minor: 1 }).success).toBe(false)
    expect(ContractVersionSchema.safeParse({ major: 1, minor: -1 }).success).toBe(false)
  })

  test('publishes the supported boundary and rejects an inverted deprecation window', () => {
    expect(PublicContractManifest).toEqual({
      name: 'agent-hq-control-plane',
      current: { major: 3, minor: 0 },
      supported: [
        { major: 1, minor: 0 },
        { major: 2, minor: 0 },
        { major: 3, minor: 0 },
      ],
    })
    expect(
      ContractDeprecationSchema.safeParse({
        deprecatedAt: '2026-09-01T00:00:00.000Z',
        sunsetAt: '2026-08-01T00:00:00.000Z',
      }).success
    ).toBe(false)
  })
})

describe('versioned public envelopes', () => {
  test('requires retry and correlation metadata on every state-changing command', () => {
    expect(StateChangingCommandEnvelopeSchema.parse(PublicContractFixtures.command)).toEqual(
      PublicContractFixtures.command
    )

    for (const requiredField of [
      'contractVersion',
      'requestId',
      'commandId',
      'idempotencyKey',
      'workspaceId',
      'payloadHash',
      'correlation',
      'operation',
      'issuedAt',
      'payload',
    ]) {
      const incomplete = Object.fromEntries(
        Object.entries(PublicContractFixtures.command).filter(([field]) => field !== requiredField)
      )
      expect(StateChangingCommandEnvelopeSchema.safeParse(incomplete).success).toBe(false)
    }
  })

  test('supports an additive calling-service assertion for authenticated routes', () => {
    expect(ReadRequestEnvelopeSchema.parse(PublicContractFixtures.request).caller).toEqual({
      servicePrincipalId: 'svc_agent-hq',
    })
    expect(
      ReadRequestEnvelopeSchema.safeParse({
        ...PublicContractFixtures.request,
        caller: undefined,
      }).success
    ).toBe(true)
    expect(
      ReadRequestEnvelopeSchema.safeParse({
        ...PublicContractFixtures.request,
        operation: 'project-state.resolve',
      }).success
    ).toBe(true)
    for (const operation of ['project--state.resolve', 'project-.resolve', '-project.resolve']) {
      expect(
        ReadRequestEnvelopeSchema.safeParse({ ...PublicContractFixtures.request, operation })
          .success
      ).toBe(false)
    }
  })

  test('validates request, response, event, usage, Artifact, and runtime read-model fixtures', () => {
    expect(ReadRequestEnvelopeSchema.parse(PublicContractFixtures.request)).toBeDefined()
    expect(ResponseEnvelopeSchema.parse(PublicContractFixtures.response)).toBeDefined()
    expect(EventEnvelopeSchema.parse(PublicContractFixtures.event)).toBeDefined()
    expect(UsageEnvelopeSchema.parse(PublicContractFixtures.usage)).toBeDefined()
    expect(ArtifactReferenceSchema.parse(PublicContractFixtures.artifact)).toBeDefined()
    expect(RuntimeReadModelEnvelopeSchema.parse(PublicContractFixtures.runtime)).toBeDefined()
  })

  test('validates the versioned Agent HQ execution event inbox boundary', () => {
    expect(
      AgentHqExecutionEventEnvelopeSchema.parse({
        contractVersion: { major: 1, minor: 0 },
        eventId: 'evt_01JABCDEF0123456789ABCDEFG',
        eventType: 'execution.awaiting_input',
        executionId: 'exe_01JABCDEF0123456789ABCDEFG',
        attemptId: 'att_01JABCDEF0123456789ABCDEFG',
        workflowId: 'wfl_01JABCDEF0123456789ABCDEFG',
        workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
        projectId: 'prj_01JABCDEF0123456789ABCDEFG',
        taskId: 'tsk_01JABCDEF0123456789ABCDEFG',
        agentId: 'agt_01JABCDEF0123456789ABCDEFG',
        sequence: 7,
        schemaVersion: 1,
        payloadHash: 'a'.repeat(64),
        occurredAt: '2026-08-24T12:00:00.000Z',
        recordedAt: '2026-08-24T12:00:01.000Z',
        correlation: {
          requestId: 'req_01JABCDEF0123456789ABCDEFG',
          commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
          traceId: 'trc_01JABCDEF0123456789ABCDEFG',
        },
        data: { state: 'awaiting_input' },
      }).sequence
    ).toBe(7)
  })

  test('distinguishes every normalized failure class', () => {
    expect(ErrorClassSchema.options).toEqual([
      'validation',
      'authentication',
      'authorization',
      'conflict',
      'stale_reference',
      'capability_mismatch',
      'runtime_unavailable',
      'internal',
    ])

    for (const errorClass of ErrorClassSchema.options) {
      expect(
        ResponseEnvelopeSchema.safeParse({
          ...PublicContractFixtures.errorResponse,
          error: { ...PublicContractFixtures.errorResponse.error, class: errorClass },
        }).success
      ).toBe(true)
    }
  })

  test('accepts additive envelope fields without requiring vendor or harness details', () => {
    expect(
      StateChangingCommandEnvelopeSchema.safeParse({
        ...PublicContractFixtures.command,
        additiveFutureField: 'ignored-by-v1-consumers',
      }).success
    ).toBe(true)

    const serializedFixtures = JSON.stringify(PublicContractFixtures).toLowerCase()
    for (const prohibitedTerm of [
      'temporal',
      'langgraph',
      'litellm',
      'claude',
      'codex',
      'pi_',
      'mcp_',
      'providercredential',
      'databaseid',
    ]) {
      expect(serializedFixtures).not.toContain(prohibitedTerm)
    }
  })

  test('keeps the public schema package independent of Control Plane implementation packages', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

    expect(manifest.dependencies).toEqual({ zod: '4.6.5' })
    expect(JSON.stringify(manifest)).not.toContain('@control-plane/domain')
    expect(JSON.stringify(manifest)).not.toContain('@control-plane/database')
  })
})

describe('service authentication contracts', () => {
  test('keeps credential classes distinct and models a stable least-privilege principal', () => {
    const claims = {
      audience: 'control-plane',
      credentialId: 'credential-agent-hq-2026-08',
      credentialKind: 'service',
      expiresAt: '2026-08-23T13:00:00.000Z',
      issuedAt: '2026-08-23T12:00:00.000Z',
      issuer: 'https://agent-hq.example',
      keyId: 'agent-hq-2026-08',
      principalId: 'svc_agent-hq',
      projectIds: ['prj_01JABCDEF0123456789ABCDEFG'],
      scopes: ['system:authenticate'],
      workspaceIds: ['wsp_01JABCDEF0123456789ABCDEFG'],
    }

    expect(ServiceCredentialClaimsSchema.parse(claims)).toEqual(claims)
    expect(
      ServicePrincipalSchema.parse({
        kind: 'agent_hq_service',
        principalId: claims.principalId,
        projectIds: claims.projectIds,
        scopes: claims.scopes,
        workspaceIds: claims.workspaceIds,
      })
    ).toBeDefined()

    for (const credentialKind of ['browser_session', 'runtime_device', 'provider']) {
      expect(ServiceCredentialClaimsSchema.safeParse({ ...claims, credentialKind }).success).toBe(
        true
      )
    }
  })

  test('rejects ambient and malformed scope grants', () => {
    const principal = {
      kind: 'internal_service',
      principalId: 'svc_execution-dispatcher',
      projectIds: [],
      scopes: ['*'],
      workspaceIds: [],
    }

    expect(ServicePrincipalSchema.safeParse(principal).success).toBe(false)
    expect(
      ServicePrincipalSchema.safeParse({ ...principal, scopes: ['execution:dispatch'] }).success
    ).toBe(true)
  })
})
