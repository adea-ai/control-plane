import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { URL } from 'node:url'
import {
  GenericRuntimeReferenceClient,
  acceptanceNow,
  conformanceReports,
  createAcpFixture,
  createPiFixture,
  createRuntimeAdaptersAcceptanceHarness,
  runtimeAdapterAcceptanceIds,
} from './support/runtime-adapters-acceptance.mjs'

describe('M6 runtime adapters acceptance', () => {
  test('publishes an independent version-pinned acceptance target for both adapter families', async () => {
    const { manifest, plan, pi, acp } = await createRuntimeAdaptersAcceptanceHarness()
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8')
    )
    const support = await readFile(
      new URL('./support/runtime-adapters-acceptance.mjs', import.meta.url),
      'utf8'
    )

    expect(packageJson.scripts['test:m6-acceptance']).toBe(
      'bun run build && bun test tests/m6-runtime-adapters.test.mjs'
    )
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      profile: {
        version: plan.profile.version,
        revision: plan.profile.revision,
        contentDigest: plan.profile.contentDigest,
      },
      skills: [
        {
          semanticVersion: plan.skills[0].semanticVersion,
          revision: plan.skills[0].revision,
          contentDigest: plan.skills[0].contentDigest,
        },
      ],
    })
    expect(manifest.runtimes.map(({ runtimeId }) => runtimeId)).toEqual([
      'managed-pi-local',
      'managed-pi-hosted',
      'acp-local',
    ])
    const reports = await conformanceReports([pi, acp], plan)
    expect(reports).toEqual([
      expect.objectContaining({ passed: true }),
      expect.objectContaining({ passed: true }),
    ])
    expect(support).not.toMatch(/agent-hq|github\.com|git clone|child_process/)
  })

  test('uses one generic execution contract for identical managed Pi and ACP plans', async () => {
    const { client, plan, pi, acp } = await createRuntimeAdaptersAcceptanceHarness()
    const piResult = await client.execute({
      plan,
      attemptId: runtimeAdapterAcceptanceIds.piAttemptId,
      preference: { runtimeConnectionId: pi.runtimeConnectionId },
    })
    const acpResult = await client.execute({
      plan,
      attemptId: runtimeAdapterAcceptanceIds.acpAttemptId,
      preference: { runtimeConnectionId: acp.runtimeConnectionId },
    })

    for (const result of [piResult, acpResult]) {
      expect(result.status).toMatchObject({ state: 'completed', result: { outcome: 'completed' } })
      expect(result.progress.map(({ type }) => type)).toEqual([
        'status',
        'output',
        'interaction',
        'usage',
        'artifact',
        'status',
      ])
      expect(result.versions).toMatchObject({
        adapterVersion: '1.0.0',
        driverVersion: '1.0.0',
      })
      expect(JSON.stringify(result)).not.toMatch(
        /native-session|\/Users\/|credential|apiKey|accessToken|privateKey/
      )
    }
    expect(pi.transport.commands()[0].payload.parameters.configuration).toMatchObject({
      profile: { version: 3, revision: 2 },
      skills: [{ semanticVersion: '2.1.0', revision: 4 }],
    })
    expect(
      acp.transport.commands().find(({ operation }) => operation === 'runtime.execute')
    ).toBeDefined()
  })

  test('supports automatic, explicit, and standalone hosted managed Pi routing', async () => {
    const { client, plan, pi, hosted } = await createRuntimeAdaptersAcceptanceHarness()
    const automatic = await client.route({ plan })
    const preferredHosted = await client.execute({
      plan,
      attemptId: runtimeAdapterAcceptanceIds.hostedAttemptId,
      preference: { deployment: 'managed' },
    })

    expect(automatic.decision.selected.runtimeConnectionId).toBe(pi.runtimeConnectionId)
    expect(preferredHosted).toMatchObject({
      runtimeConnectionId: hosted.runtimeConnectionId,
      family: 'managed-pi',
      status: { state: 'completed', result: { outcome: 'completed' } },
    })
    const hostedInspection = automatic.inspected.find(
      ({ fixture }) => fixture.runtimeConnectionId === hosted.runtimeConnectionId
    )
    expect(hostedInspection).toMatchObject({
      connection: {
        compatibilityState: 'untested',
        health: 'degraded',
        limitations: expect.arrayContaining([
          'COMPATIBILITY_UNTESTED',
          'STANDALONE_HOSTED_FIXTURE',
        ]),
      },
      eligibility: { eligible: true, mode: 'degraded' },
    })
  })

  test('makes capability degradation and stale version certification explicit', async () => {
    const { client, plan, pi } = await createRuntimeAdaptersAcceptanceHarness()
    const optionalHistory = {
      ...plan,
      runtimeRequirements: [
        ...plan.runtimeRequirements,
        { capability: 'session.history', necessity: 'optional', minimumSupport: 'supported' },
      ],
    }
    const degraded = await client.route({ plan: optionalHistory })
    const piEligibility = degraded.inspected.find(
      ({ fixture }) => fixture.runtimeConnectionId === pi.runtimeConnectionId
    ).eligibility
    const upgraded = await client.inspect(
      plan,
      new Map([[pi.runtimeConnectionId, { adapterVersion: '1.0.1' }]])
    )
    const upgradedPi = upgraded.find(
      ({ fixture }) => fixture.runtimeConnectionId === pi.runtimeConnectionId
    )

    expect(piEligibility).toMatchObject({
      eligible: true,
      mode: 'degraded',
      degradations: expect.arrayContaining([
        { code: 'OPTIONAL_CAPABILITY_MISSING', capability: 'session.history' },
      ]),
    })
    expect(upgradedPi).toMatchObject({
      connection: { compatibilityState: 'untested', health: 'degraded' },
      eligibility: {
        eligible: true,
        mode: 'degraded',
        degradations: expect.arrayContaining([{ code: 'COMPATIBILITY_UNTESTED' }]),
      },
    })
  })

  test('normalizes interactions, cancellation, crashes, disconnects, and revoked grants', async () => {
    const { manifest, matrix, plan } = await createRuntimeAdaptersAcceptanceHarness()
    const piWaiting = createPiFixture(manifest.runtimes[0], { scenario: 'awaiting_input' })
    const piHandle = await piWaiting.adapter.start({
      attemptId: runtimeAdapterAcceptanceIds.piAttemptId,
      idempotencyKey: 'm6:pi-interaction',
      executionPlan: plan,
    })
    expect(await piWaiting.adapter.status(piHandle)).toMatchObject({ state: 'awaiting_input' })
    expect(
      await piWaiting.adapter.submitInput(piHandle, {
        interactionId: 'int_01JABCDEF0123456789ABCDEFG',
        idempotencyKey: 'm6:pi-input',
        text: 'continue',
      })
    ).toMatchObject({ state: 'running' })
    expect(
      await piWaiting.adapter.cancel(piHandle, {
        idempotencyKey: 'm6:pi-cancel',
        requestedAt: acceptanceNow,
      })
    ).toMatchObject({ state: 'cancelled' })

    const acpRunning = createAcpFixture(manifest.runtimes[2], { scenario: 'running' })
    const acpHandle = await acpRunning.adapter.start({
      attemptId: runtimeAdapterAcceptanceIds.acpAttemptId,
      idempotencyKey: 'm6:acp-interaction',
      executionPlan: plan,
    })
    const acpProgress = []
    for await (const event of acpRunning.adapter.progress(acpHandle)) acpProgress.push(event)
    expect(acpProgress).toContainEqual(expect.objectContaining({ type: 'interaction' }))
    expect(
      await acpRunning.adapter.cancel(acpHandle, {
        idempotencyKey: 'm6:acp-cancel',
        requestedAt: acceptanceNow,
      })
    ).toMatchObject({ state: 'cancelled' })
    acpRunning.transport.disconnect()
    expect(await acpRunning.adapter.inspect()).toMatchObject({ health: 'unavailable' })
    acpRunning.transport.connect()
    expect(await acpRunning.adapter.reconcile(acpHandle)).toMatchObject({ state: 'cancelled' })

    const crashed = createPiFixture(manifest.runtimes[0], { scenario: 'crash' })
    const crashHandle = await crashed.adapter.start({
      attemptId: runtimeAdapterAcceptanceIds.piAttemptId,
      idempotencyKey: 'm6:pi-crash',
      executionPlan: plan,
    })
    expect(await crashed.adapter.status(crashHandle)).toMatchObject({
      state: 'failed',
      error: { code: 'PI_PROCESS_CRASHED', retryable: true },
    })

    const revoked = createPiFixture(manifest.runtimes[0], { grantState: 'revoked' })
    const revokedClient = new GenericRuntimeReferenceClient({ fixtures: [revoked], matrix })
    const revokedRoute = await revokedClient.route({ plan })
    expect(revokedRoute.decision).toMatchObject({
      outcome: 'no_candidate',
      excluded: [
        {
          runtimeConnectionId: revoked.runtimeConnectionId,
          eligibilityReasons: expect.arrayContaining(['LOCAL_PROJECT_GRANT_REVOKED']),
        },
      ],
    })
    expect(revoked.transport.commands()).toHaveLength(0)
  })

  test('resumes ACP sessions independently with and without history support', async () => {
    const { manifest } = await createRuntimeAdaptersAcceptanceHarness()
    const withHistory = createAcpFixture(manifest.runtimes[2])
    const listed = await withHistory.adapter.session({ operation: 'list' })
    const sessionId = listed.sessions[0].sessionId
    const resumed = await withHistory.adapter.session({
      operation: 'resume',
      sessionId,
      idempotencyKey: 'm6:session-resume',
    })
    const history = await withHistory.adapter.session({ operation: 'history', sessionId })

    expect(resumed).toMatchObject({ operation: 'resume', session: { sessionId } })
    expect(history).toMatchObject({ operation: 'history', completeness: 'complete' })
    expect(JSON.stringify([listed, resumed, history])).not.toContain('native-session-1')

    const withoutHistory = createAcpFixture(manifest.runtimes[2], { history: false })
    const inspection = await withoutHistory.adapter.inspect()
    expect(inspection.capabilities.map(({ name }) => name)).toContain('session.resume')
    expect(inspection.capabilities.map(({ name }) => name)).not.toContain('session.history')
    const noHistorySessions = await withoutHistory.adapter.session({ operation: 'list' })
    await expect(
      withoutHistory.adapter.session({
        operation: 'history',
        sessionId: noHistorySessions.sessions[0].sessionId,
      })
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED', retryable: false })
  })

  test('rejects unsupported harness and protocol versions before execution', async () => {
    const { manifest, matrix, plan } = await createRuntimeAdaptersAcceptanceHarness()
    const oldPi = createPiFixture(manifest.runtimes[0], { harnessVersion: '0.51.9' })
    const oldAcp = createAcpFixture(manifest.runtimes[2], { acpProtocolVersion: 1 })
    const client = new GenericRuntimeReferenceClient({ fixtures: [oldPi, oldAcp], matrix })
    const { decision, inspected } = await client.route({ plan })

    expect(decision.selected).toBeUndefined()
    expect(decision.excluded).toHaveLength(2)
    expect(inspected.map(({ connection }) => connection.health)).toEqual([
      'unavailable',
      'unavailable',
    ])
    expect(inspected[0].inspection.limitations).toContain('UNSUPPORTED_PI_RUNTIME_VERSION:0.51.9')
    expect(inspected[1].inspection.limitations).toContain('ACP_PROTOCOL_VERSION_UNSUPPORTED:1')
    expect(oldPi.transport.commands()).toHaveLength(0)
    expect(oldAcp.transport.commands()).toHaveLength(1)
  })
})
