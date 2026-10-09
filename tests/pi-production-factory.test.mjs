import { test, expect } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { createProductionFactoryFixture } from './pi-production-factory.fixture.mjs'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createControlApiApplication } from '../apps/control-api/src/application.ts'
import { PolicyServiceAuthenticator } from '../apps/control-api/src/auth/service-authentication.ts'
import {
  countProductionProductReads,
  productionFactorySourceIdentity,
} from './pi-production-factory-provenance.fixture.mjs'

test('actual selected HTTP product reader reports every request without provider work', async () => {
  let host
  let httpReads = 0
  let denied = false
  host = await createProductionFactoryFixture({
    productHttp: {
      endpoint:
        'https://production-factory.test.invalid/api/internal/pi-durable/lead-product/current',
      credentials: { getExistingCredential: async () => 'fixture.fixture.fixture' },
      fetch: async (_url, request) => {
        httpReads++
        const selectors = JSON.parse(request.body)
        expect(Object.keys(selectors).toSorted()).toEqual([
          'intentId',
          'principalId',
          'workspaceId',
        ])
        if (denied) return new Response(null, { status: 404 })
        return Response.json(host.rawProductEvidence(selectors.intentId))
      },
    },
  })
  try {
    const intentId = host.setIntent()
    await host.composition.piDurableLeadService.prepare(
      host.command('pi-durable.lead.prepare', { intentId }),
      host.principal
    )
    expect(httpReads).toBeGreaterThan(0)
    expect(host.state.productReads).toBe(httpReads)
    denied = true
    await expect(
      host.composition.product.readCurrent({
        schemaVersion: 'pi-lead-intent/v1',
        workspaceId: host.workspaceId,
        intentId,
        principalId: host.principal.principalId,
      })
    ).resolves.toBeUndefined()
    expect(host.state.productReads).toBe(httpReads)
    expect(host.state.physicalSends).toBe(0)
    expect(host.models.secretProvider.resolveCount).toBe(0)
    expect(host.composition.adapter.journal.list()).toHaveLength(0)
  } finally {
    await host.close()
  }
}, 30000)

test('authenticated model metadata selections bind distinct lead and child choices from fresh product evidence', async () => {
  const leadModel = 'gpt-5-mini'
  const childModel = 'gpt-5'
  const host = await createProductionFactoryFixture()
  const metadata = {
    serviceName: 'control-api',
    version: 'test-candidate',
    commitSha: 'test-candidate',
    environment: 'test',
  }
  const principalId = host.models.refs.administratorPrincipalRef
  expect(principalId).toBe(host.principal.principalId)
  expect(principalId).not.toBe(host.actorPrincipalId)
  const claims = {
    audience: 'control-plane',
    credentialId: 'synthetic-model-metadata-auth',
    credentialKind: 'service',
    expiresAt: host.expiresAt,
    issuedAt: host.at,
    issuer: 'https://factory.test.invalid',
    keyId: 'synthetic-test-verifier',
    principalId,
    projectIds: [],
    scopes: ['credential:read', 'credential:write'],
    workspaceIds: [host.workspaceId],
  }
  let app
  try {
    app = await createControlApiApplication({
      metadata,
      health: () => ({ status: 'ok', metadata }),
      readiness: () => ({ status: 'ready', metadata }),
      logger: { write: () => {} },
      serviceAuthenticator: new PolicyServiceAuthenticator({
        audience: claims.audience,
        issuer: claims.issuer,
        logger: { write: () => {} },
        now: () => new Date(host.at),
        revocationChecker: { isRevoked: async () => false },
        verifier: { verify: async () => claims },
      }),
      modelConnectionService: host.composition.modelConnectionService,
    })
    const post = (path, body) =>
      app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: 'POST',
          url: `/v1/model-connections/${path}`,
          headers: { authorization: 'Bearer synthetic-test-assertion' },
          payload: body,
        })
    const requestId = () => 'req_01JABCDEF0123456789ABCDEFG'
    const traceId = () => 'trc_01JABCDEF0123456789ABCDEFG'
    const read = (operation, parameters) => ({
      contractVersion: { major: 1, minor: 0 },
      caller: { servicePrincipalId: principalId },
      requestId: requestId(),
      workspaceId: host.workspaceId,
      correlation: { traceId: traceId() },
      operation,
      requestedAt: host.at,
      parameters,
    })
    await host.models.setupDefault()
    const listed = await post(
      'list',
      read('model-connections.list', { target: host.models.target })
    )
    expect(listed.statusCode).toBe(200)
    expect(listed.json().data.connections[0].models.map((model) => model.providerModel)).toEqual(
      expect.arrayContaining([leadModel, childModel])
    )
    const connectionRef = host.models.refs.connectionRef
    const resolveRole = async (role, providerModel) => {
      const response = await post(
        'selection/resolve',
        read('model-selection.resolve', {
          role,
          target: host.models.target,
          override: { connectionRef, providerModel },
        })
      )
      expect(response.statusCode).toBe(200)
      expect(response.json().data.selection.providerModel).toBe(providerModel)
      return response.json().data.selection
    }
    const lead = await resolveRole('lead', leadModel)
    const child = await resolveRole('child', childModel)
    expect(lead.selectionRef).not.toBe(child.selectionRef)
    expect(lead.workspaceId).toBe(host.workspaceId)
    expect(child.workspaceId).toBe(host.workspaceId)
    const intentId = host.setIntent(randomUUID(), {
      requestedModelSelections: {
        lead: { selectionRef: lead.selectionRef, selectionRevision: lead.selectionRevision },
        child: { selectionRef: child.selectionRef, selectionRevision: child.selectionRevision },
      },
    })
    const prepared = (
      await host.composition.piDurableLeadService.prepare(
        host.command('pi-durable.lead.prepare', { intentId }),
        host.principal
      )
    ).data
    expect(prepared.funding).toMatchObject({
      state: 'ready',
      selectionRef: lead.selectionRef,
      selectionRevision: lead.selectionRevision,
      providerModel: leadModel,
    })
    const admitted = await host.composition.product.readCurrent({
      schemaVersion: 'pi-lead-intent/v1',
      workspaceId: host.workspaceId,
      intentId,
      principalId: host.principal.principalId,
    })
    expect(admitted.selectionRef).toBe(lead.selectionRef)
    expect(admitted.selectionRevision).toBe(lead.selectionRevision)
    expect(host.rawProductEvidence(intentId).requestedModelSelections).toEqual({
      lead: { selectionRef: lead.selectionRef, selectionRevision: lead.selectionRevision },
      child: { selectionRef: child.selectionRef, selectionRevision: child.selectionRevision },
    })
    const childSelection = await host.composition.resolveChildSelection(
      {
        schemaVersion: 'pi-lead-intent/v1',
        workspaceId: host.workspaceId,
        intentId,
        principalId: host.principal.principalId,
      },
      {
        childRequestId: requestId(),
        childRequestDigest: `sha256:${'a'.repeat(64)}`,
        canonicalActorPrincipalId: host.actorPrincipalId,
      }
    )
    expect(childSelection.selectionRef).toBe(child.selectionRef)
    expect(childSelection.selectionRevision).toBe(child.selectionRevision)
    expect(childSelection.providerModel).toBe(childModel)
    expect(host.state.physicalSends).toBe(0)
    expect(host.models.secretProvider.resolveCount).toBe(0)
    expect(host.canonicalCounts()).toMatchObject({ commands: 1, executions: 1, attempts: 1 })
    const dispatched = (
      await host.composition.piDurableLeadService.dispatch(
        host.command('pi-durable.lead.dispatch', {
          intentId,
          preparationRef: prepared.preparationRef,
        }),
        host.principal
      )
    ).data
    await host.composition.adapter.drain()
    const status = (
      await host.composition.piDurableLeadService.status(
        host.read('pi-durable.lead.status', { dispatchId: dispatched.dispatchId }),
        host.principal
      )
    ).data.status
    expect(status.state).toBe('completed')
    expect(host.state.providerModels).toEqual([leadModel])
    expect(host.state.physicalSends).toBe(1)
    expect(
      (await host.ledger.entries(host.workspaceId, dispatched.executionId)).filter(
        (entry) => entry.kind === 'model_usage'
      )
    ).toHaveLength(1)
  } finally {
    await app?.close()
    await host.close()
  }
}, 30000)

test('real production factory prepares without inference and publishes exact native committed output through actual retained SQLite records', async () => {
  let publicationTime = new Date().toISOString()
  const host = await createProductionFactoryFixture({
    publicationNow: () => publicationTime,
  })
  publicationTime = host.at
  try {
    const intentId = host.setIntent()
    const prepared = (
      await host.composition.piDurableLeadService.prepare(
        host.command('pi-durable.lead.prepare', { intentId }),
        host.principal
      )
    ).data
    expect(prepared.intentId).toBe(intentId)
    expect(prepared.funding.state).toBe('ready')
    expect(prepared.funding.selectionRef).toBe(host.selection.selectionRef)
    expect(prepared.funding.accountRef).toBe(host.selection.accountRef)
    expect(host.state.productReads).toBeGreaterThan(0)
    expect(host.state.physicalSends).toBe(0)
    expect(host.composition.adapter.journal.list()).toHaveLength(0)
    expect(host.models.secretProvider.resolveCount).toBe(0)
    const dispatched = (
      await host.composition.piDurableLeadService.dispatch(
        host.command('pi-durable.lead.dispatch', {
          intentId,
          preparationRef: prepared.preparationRef,
        }),
        host.principal
      )
    ).data
    await host.composition.adapter.drain()
    const status = (
      await host.composition.piDurableLeadService.status(
        host.read('pi-durable.lead.status', { dispatchId: dispatched.dispatchId }),
        host.principal
      )
    ).data.status
    expect(status.state).toBe('completed')
    expect(status.result.output.text).toBe(host.exactText)
    expect(host.state.physicalSends).toBe(1)
    const originalGrant = structuredClone(host.records.get(intentId).decision.grant)
    // Model a long-running connected consumer: publication advances while admission keeps
    // its deterministic startup clock for the retained execution.
    publicationTime = new Date(Date.parse(host.at) + 60_000).toISOString()
    const before = {
      product: host.state.productReads,
      sends: host.state.physicalSends,
      secretResolutions: host.models.secretProvider.resolveCount,
    }
    const request = host.read('pi-durable.lead.publication.current', {
      dispatchId: dispatched.dispatchId,
      preparationRef: prepared.preparationRef,
    })
    const publication = (await host.composition.publicationService.current(request, host.principal))
      .data.publication
    expect(publication).toMatchObject({
      workspaceId: host.workspaceId,
      intentId,
      dispatchId: dispatched.dispatchId,
      preparationRef: prepared.preparationRef,
      executionId: dispatched.executionId,
      attemptId: dispatched.attemptId,
      runtimeSessionId: status.handle.externalSessionId,
      selectionRef: host.selection.selectionRef,
      selectionRevision: host.selection.selectionRevision,
      canonicalActorPrincipalId: host.actorPrincipalId,
      resultContentDigest: `sha256:${createHash('sha256').update(host.exactText, 'utf8').digest('hex')}`,
    })
    expect(publication.expiresAt).toBe(new Date(Date.parse(publicationTime) + 30_000).toISOString())
    expect(Date.parse(publication.expiresAt)).toBeLessThanOrEqual(Date.parse(host.expiresAt))
    expect(host.actorPrincipalId).not.toBe(host.principal.principalId)
    expect(host.state.productReads).toBe(before.product)
    expect(host.state.physicalSends).toBe(before.sends)
    expect(host.models.secretProvider.resolveCount).toBe(before.secretResolutions)
    expect(
      (await host.ledger.entries(host.workspaceId, dispatched.executionId)).filter(
        (entry) => entry.kind === 'model_usage'
      )
    ).toHaveLength(1)
    expect(
      (await host.composition.publicationService.current(request, host.principal)).data.publication
    ).toEqual(publication)
    publicationTime = new Date(Date.parse(host.at) + 225_000).toISOString()
    const cappedPublication = (
      await host.composition.publicationService.current(request, host.principal)
    ).data.publication
    expect(cappedPublication.expiresAt).toBe(host.expiresAt)
    expect(cappedPublication.selectionRef).toBe(publication.selectionRef)
    expect(cappedPublication.selectionRevision).toBe(publication.selectionRevision)
    expect(host.records.get(intentId).decision.grant).toEqual(originalGrant)
    publicationTime = host.expiresAt
    await expect(
      host.composition.publicationService.current(request, host.principal)
    ).rejects.toThrow('TEST_PUBLICATION_DENIED')
    expect(host.state.physicalSends).toBe(1)
    expect(host.state.productReads).toBe(before.product)
    publicationTime = new Date(Date.parse(host.at) + 60_000).toISOString()
    const recordPath = host.records.get(intentId).recordPath
    const acceptedRecord = await readFile(recordPath, 'utf8')
    for (const mutate of [
      (record) => {
        record.binding.canonicalActorPrincipalId = 'user:f643a115-617d-4bae-8d52-cfe458c0b8ac'
      },
      (record) => {
        record.decision.grant.authorizationId = 'changed:authorization'
      },
      (record) => {
        record.expiresAt = 'invalid'
      },
      (record) => {
        record.decision.price.validUntil = host.at
      },
    ]) {
      const changed = JSON.parse(acceptedRecord)
      mutate(changed)
      await writeFile(recordPath, JSON.stringify(changed), { mode: 0o600 })
      await expect(
        host.composition.publicationService.current(request, host.principal)
      ).rejects.toThrow()
      await writeFile(recordPath, acceptedRecord, { mode: 0o600 })
    }
    host.state.publicationRevoked = true
    await expect(
      host.composition.publicationService.current(request, host.principal)
    ).rejects.toThrow('TEST_PUBLICATION_DENIED')
    expect(host.state.productReads).toBe(before.product)
    expect(host.state.physicalSends).toBe(1)
  } finally {
    await host.close()
  }
}, 30000)

test('actual factory current original actor and account denial never mint a canonical admission or start native work', async () => {
  const host = await createProductionFactoryFixture()
  try {
    const intentId = host.setIntent()
    const empty = { commands: 0, executions: 0, attempts: 0, budgets: 0, usage: 0 }
    expect(host.canonicalCounts()).toEqual(empty)
    host.state.revoked = true
    await expect(
      host.composition.piDurableLeadService.prepare(
        host.command('pi-durable.lead.prepare', { intentId }),
        host.principal
      )
    ).rejects.toThrow()
    expect(host.state.physicalSends).toBe(0)
    expect(host.composition.adapter.journal.list()).toHaveLength(0)
    expect(host.models.secretProvider.resolveCount).toBe(0)
    expect(host.canonicalCounts()).toEqual(empty)
    host.state.revoked = false
    host.models.setCurrentAccount({ quota: 'exhausted' })
    await expect(
      host.composition.piDurableLeadService.prepare(
        host.command('pi-durable.lead.prepare', { intentId }),
        host.principal
      )
    ).rejects.toThrow()
    expect(host.state.physicalSends).toBe(0)
    expect(host.composition.adapter.journal.list()).toHaveLength(0)
    expect(host.canonicalCounts()).toEqual(empty)
  } finally {
    await host.close()
  }
}, 30000)

test('selected product port counts successful and denied reads without changing results', async () => {
  for (const kind of ['raw', 'http']) {
    const state = { productReads: 0 }
    const input = { workspaceId: 'workspace', intentId: 'intent', principalId: 'principal' }
    const result = { kind }
    const denied = new Error('FIXTURE_DENIED')
    const actual = {
      calls: 0,
      async readCurrent(value) {
        expect(value).toBe(input)
        this.calls++
        if (this.calls === 1) return result
        if (this.calls === 2) return undefined
        throw denied
      },
    }
    const selected = countProductionProductReads(actual, state)
    expect(await selected.readCurrent(input)).toBe(result)
    expect(await selected.readCurrent(input)).toBeUndefined()
    await expect(selected.readCurrent(input)).rejects.toBe(denied)
    expect(state.productReads).toBe(3)
    expect(actual.calls).toBe(3)
  }
})

test('source identity resolves from owning repository when invoked from a foreign cwd', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-factory-foreign-cwd-'))
  try {
    const module = new URL('./pi-production-factory-provenance.fixture.mjs', import.meta.url).href
    const result = execFileSync(
      process.execPath,
      [
        '-e',
        `import {productionFactorySourceIdentity} from ${JSON.stringify(module)}; process.stdout.write(productionFactorySourceIdentity())`,
      ],
      { cwd: directory, encoding: 'utf8' }
    )
    expect(result).toBe(productionFactorySourceIdentity())
    expect(result).toMatch(/^[a-f0-9]{40}$/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

// Resolve the root script's declared dependencies before any configuration or effects.
test('root launcher resolves dependencies and fails closed before unconfigured startup', () => {
  const env = { ...process.env }
  delete env.PI_PRODUCTION_FACTORY_TEST_CONFIG
  delete env.PI_PRODUCTION_FACTORY_PRODUCT_ASSERTION
  const result = spawnSync(process.execPath, ['scripts/pi-production-factory-candidate.mjs'], {
    cwd: new URL('..', import.meta.url),
    env,
    encoding: 'utf8',
    timeout: 10000,
  })
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(1)
  expect(result.stdout).toBe('')
  expect(result.stderr).toContain('TEST_PRODUCTION_FACTORY_CONFIGURATION_REQUIRED')
  expect(result.stderr).not.toContain('Cannot find package')
}, 30000)
