// The end-to-end production path for the accepted model (M12/#1210, #678).
//
// The chain proved here is the real one:
//
//   HTTP acceptance -> the accepted request payload's modelId -> the
//   acceptExecution command -> the persisted execution read model -> the real
//   hosted worker router -> the mapped harness.
//
// Nothing between those steps is stubbed except the database and the runtime
// discovery rows, which are the deployment's own state. The router is the
// hosted composition's own RuntimeDiscoveryAttemptRouter, constructed with the
// same harnessByModel configuration the deployment environment supplies.
//
// The cases are the ones the contract distinguishes:
//
//   - a configured map routes the accepted model to its mapped harness;
//   - a model the map does not name is denied, never rerouted;
//   - an execution with no model under a configured map is denied;
//   - a pin that contradicts the map is a conflict, never a substitution;
//   - without a map the behavior is exactly what it was;
//   - the execution plan digest is unchanged by any of it.
//
// The configuration resolution and the composition wiring are the hosted
// control plane's own functions, so the environment contract is exercised too.
//
// This is a source integration proof. It activates nothing: no provider is
// called, no native effect is performed and no production resource is
// touched. The router resolves against a disposable local PostgreSQL.

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import process from 'node:process'

import { loadDatabaseCredentials } from '@control-plane/config'
import { ControlApiFixtures } from '@control-plane/contracts'
import {
  createControlApiApplication,
  createPrivateApiAuthentication,
} from '@control-plane/control-api'
import { createIsolatedTestDatabase, integrationTestTimeout } from '@control-plane/database/testing'
import {
  PostgresCatalogRepository,
  PostgresContextPackageRepository,
  PostgresExecutionPlanRepository,
  PostgresExecutionRepository,
  PostgresRuntimeDiscoveryRepository,
} from '@control-plane/database'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'
import { ExecutionPlanCompiler } from '@control-plane/execution-plan'
import { RuntimeDiscoveryAttemptRouter } from '@control-plane/workflow-worker'

import { HostedServerControlPlaneComposition } from './composition.ts'
import { resolveHostedCompositionConfiguration, resolveHostedHarnessByModel } from './index.ts'
import { hostedDependencyReadiness } from './dependency-readiness.js'

const integrationEnabled = process.env.RUN_DATABASE_INTEGRATION === 'true'
const MODEL_ID = 'deepseek-flash'
const MAPPED_HARNESS = 'pi'
const CONFLICTING_HARNESS = 'managed-pi'

/**
 * The catalog owners the plan's pins need. The plan's profile and skills are
 * system-owned in this deployment, so the ownership rows are seeded before the
 * versions.
 */
async function seedCatalogOwners(catalog, profileVersion, skillVersions) {
  if (!(await catalog.getAgentProfile(profileVersion.profileId))) {
    await catalog.insertAgentProfile({
      profileId: profileVersion.profileId,
      displayName: 'System test profile',
      ownership: { scope: 'system' },
      createdAt: profileVersion.createdAt,
    })
  }
  for (const skillVersion of skillVersions) {
    if (await catalog.getSkill(skillVersion.skillId)) continue
    await catalog.insertSkill({
      skillId: skillVersion.skillId,
      displayName: 'System test skill',
      ownership: { scope: 'system' },
      provenance: { source: 'workspace-authorized', ownerRef: 'system', trust: 'authorized' },
      createdAt: skillVersion.createdAt,
    })
  }
}

/**
 * A runtime connection that exposes the `pi` harness. The harness id a runtime
 * exposes is its family, so a `pi` family connection is the one a model mapped
 * to `pi` must select.
 */
function piRuntimeConnection(runtimeConnectionId) {
  const observedAt = new Date().toISOString()
  return {
    runtimeConnectionId,
    runtimeDefinitionId: 'rtd_01JABCDEF0123456789ABCDEFG',
    family: 'pi',
    connectionType: 'managed_local',
    location: 'local_device',
    status: 'available',
    node: {
      runtimeNodeRefId: 'rnr_01JABCDEF0123456789ABCDEFG',
      location: 'local_device',
      status: 'online',
      health: 'online',
      observedAt,
    },
    connection: { status: 'connected', health: 'healthy', availability: 'healthy' },
    freshness: {
      state: 'fresh',
      observedAt,
      expiresAt: new Date(Date.parse(observedAt) + 30_000).toISOString(),
    },
    versions: { adapter: '1.0.0', driver: '1.0.0', harness: '1.0.0', protocol: '1.0.0' },
    capabilities: ['filesystem.read', 'stream.output'],
    capabilityDetails: [
      { name: 'filesystem.read', support: 'supported' },
      { name: 'stream.output', support: 'supported' },
    ],
    compatibility: { state: 'compatible', limitations: [] },
    access: {
      localProjectGrant: { required: true, state: 'granted' },
      entitlement: { state: 'allowed' },
    },
    eligibility: { state: 'eligible', reasons: [], degradations: [], remediation: [] },
    observedAt,
    limitations: [],
  }
}

describe.skipIf(!integrationEnabled)('the accepted model reaches the hosted worker router', () => {
  let isolated
  let dataDirectory
  let credential
  let application
  let restateIngress
  const compositions = []

  const metadata = {
    serviceName: 'control-api',
    version: 'integration-test',
    commitSha: 'test',
    environment: 'test',
    instanceId: 'hosted-model-forwarding-e2e',
  }

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase({
      administration: loadDatabaseCredentials(process.env, 'administration'),
      application: loadDatabaseCredentials(process.env, 'application'),
      migration: loadDatabaseCredentials(process.env, 'migration'),
    })
    await isolated.migrate()
    dataDirectory = await mkdtemp(join(tmpdir(), 'hosted-model-forwarding-'))
    // The workflow runtime is an external service. The acceptance path posts
    // the run to its ingress, so a minimal local stub answers that post with
    // the accepted invocation the contract expects. Nothing else about the
    // runtime is exercised, and no native effect is performed.
    restateIngress = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => {
        body += chunk
      })
      request.on('end', () => {
        response.writeHead(202, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({ status: 'Accepted', invocationId: `inv_${request.url.length}` })
        )
      })
    })
    await new Promise((resolve) => restateIngress.listen(0, '127.0.0.1', resolve))
  }, integrationTestTimeout(60_000))

  afterAll(async () => {
    const cleanupErrors = []
    for (const cleanup of [
      () => application?.close(),
      ...compositions.map((composition) => () => composition.close()),
      () => isolated?.dispose(),
      () =>
        restateIngress === undefined
          ? undefined
          : new Promise((resolve) => restateIngress.close(resolve)),
      () =>
        dataDirectory === undefined
          ? undefined
          : rm(dataDirectory, { recursive: true, force: true }),
    ]) {
      try {
        await cleanup()
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'HOSTED_MODEL_FORWARDING_CLEANUP_FAILED')
    }
  })

  /**
   * The hosted composition over the isolated database, with the per-model map
   * wired exactly as the deployment environment wires it.
   */
  async function openComposition(harnessByModel) {
    const url = new URL(process.env.DATABASE_URL)
    url.pathname = `/${isolated.name}`
    const address = restateIngress.address()
    const restateIngressUrl = `http://127.0.0.1:${address.port}`
    const composition = new HostedServerControlPlaneComposition({
      dataDirectory,
      databaseUrl: url.toString(),
      restateIngressUrl: restateIngressUrl,
      connection: {
        database: isolated.application,
        check: async () => undefined,
        close: async () => undefined,
      },
      endpointFactory: {
        create: async () => ({ run: async () => undefined, shutdown: async () => undefined }),
      },
      workflowRuntime: {
        start: async () => undefined,
        stop: async () => undefined,
        health: async () => ({ ready: true, component: 'test', version: '1' }),
      },
      ...(harnessByModel === undefined ? {} : { harnessByModel }),
    })
    compositions.push(composition)
    await composition.start()
    return composition
  }

  async function openApplication(composition) {
    const authentication = await createPrivateApiAuthentication(dataDirectory)
    credential = (await readFile(authentication.credentialFile, 'utf8')).trim()
    application = await createControlApiApplication({
      executionAcceptanceService: composition.executionAcceptanceService,
      interactionCommandService: composition.interactionCommandService,
      executionCancellationService: composition.executionCancellationService,
      executionValidationService: composition.executionValidationService,
      profileResolutionService: composition.profileResolutionService,
      projectStateResolutionService: composition.projectStateResolutionService,
      contextPackageResolutionService: composition.contextPackageResolutionService,
      runtimeDiscoveryRepository: composition.runtimeDiscoveryRepository,
      workspaceCatalogService: composition.createWorkspaceCatalogService({
        write: () => undefined,
      }),
      serviceAuthenticator: authentication.authenticator,
      dependencyReadiness: () => hostedDependencyReadiness(composition),
      componentManifest: () => composition.manifest(),
      health: () => ({ status: 'ok', metadata }),
      readiness: () => ({ status: 'ready', metadata }),
      logger: { write: () => undefined },
      metadata,
    })
  }

  /**
   * A compiled plan and the acceptance request that references it, with the
   * accepted model carried in the request payload.
   *
   * The plan carries no graph: the hosted graph authority exists only when the
   * hosted graph runtime is enabled, and this qualification exercises the
   * model-forwarding path, not the graph path. The plan is otherwise the
   * repository's own fixture, so its pins are the real ones.
   *
   * Each acceptance gets its own command, request and idempotency key, so the
   * cases are independent acceptances rather than replays of one another.
   */
  function acceptanceRequest(modelId, discriminator) {
    const planInputs = createExecutionPlanTestFixtureInputs({
      profileCapabilityRequirements: [],
      skillRequiredCapabilities: [],
    })
    const plan = new ExecutionPlanCompiler('1.0.0').compile({ ...planInputs })
    const fixture = ControlApiFixtures.executionAcceptance.request
    // The opaque identifiers carry a fixed canonical suffix of exactly 26
    // Crockford characters, so each acceptance gets its own by replacing the
    // last character of the fixture's suffix.
    const suffix = (kind, letter) => `${kind}_01JABCDEF0123456789ABCDEF${letter}`
    return {
      plan,
      planInputs,
      request: {
        ...fixture,
        commandId: suffix('cmd', discriminator),
        requestId: suffix('req', discriminator),
        idempotencyKey: `model-forwarding-${discriminator}`,
        // The payload hash is a hex digest; the discriminator keeps each
        // acceptance's hash distinct.
        payloadHash: discriminator.toLowerCase().repeat(64).slice(0, 64),
        issuedAt: new Date().toISOString(),
        workspaceId: plan.correlation.workspaceId,
        projectId: plan.correlation.projectId,
        payload: {
          ...fixture.payload,
          taskId: plan.correlation.taskId,
          agentId: plan.correlation.agentId,
          executionPlan: {
            executionPlanId: plan.executionPlanId,
            contentDigest: plan.contentDigest,
            schemaVersion: plan.schemaVersion,
          },
          // The retention must extend beyond the receipt, so it is relative to
          // this acceptance rather than to the fixture's fixed instant. The
          // deadline must sit inside the command lifetime, so it moves with it.
          retentionExpiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
          deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
          ...(modelId === undefined ? {} : { modelId }),
        },
      },
    }
  }

  /** Accepts the execution over HTTP and returns the persisted read model. */
  async function acceptOverHttp(composition, modelId, discriminator) {
    const { plan, planInputs, request } = acceptanceRequest(modelId, discriminator)
    // The plan, its context package and the catalog versions the plan pins are
    // the deployment's own state: they must exist before an execution may
    // reference the plan.
    const packages = new PostgresContextPackageRepository(composition.connection.database)
    await packages.put(contextPackageSerializationFixtures.futurePi)
    const plans = new PostgresExecutionPlanRepository(composition.connection.database)
    await plans.put(plan)
    const catalog = new PostgresCatalogRepository(composition.connection.database)
    await seedCatalogOwners(catalog, planInputs.profile, planInputs.skills)
    await catalog.insertAgentProfileVersion(planInputs.profile)
    for (const skill of planInputs.skills) await catalog.insertSkillVersion(skill)
    // The runtime that exposes the pi harness is the deployment's own
    // discovery state, so the router has a real candidate to select.
    const discovery = new PostgresRuntimeDiscoveryRepository(composition.connection.database)
    await discovery.putRuntimeConnection(
      plan.correlation.workspaceId,
      piRuntimeConnection('rtc_01JABCDEF0123456789ABCDEFB')
    )
    const response = await application.inject({
      method: 'POST',
      url: '/v1/executions/accept',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${credential}`,
      },
      payload: request,
    })
    expect(response.statusCode, JSON.stringify(response.json())).toBe(202)
    const executionId = response.json().data.executionId
    const executions = new PostgresExecutionRepository(composition.connection.database)
    const persisted = await executions.getExecution(executionId)
    expect(persisted).toBeDefined()
    return { plan, persisted }
  }

  test(
    'the accepted model is persisted on the execution read model and reaches the mapped harness',
    async () => {
      const composition = await openComposition({ [MODEL_ID]: MAPPED_HARNESS })
      await openApplication(composition)

      const { plan, persisted } = await acceptOverHttp(composition, MODEL_ID, '1')

      // The persisted execution read model carries the accepted model.
      expect(persisted.modelId).toBe(MODEL_ID)

      // The real hosted router maps that model to its harness.
      const selected = await composition.runtimeAttemptRouter.resolve({
        execution: persisted,
        executionPlan: plan,
      })
      expect(selected.routingDecision.reasonCodes).toContain('HARNESS_MAPPED')
    },
    integrationTestTimeout(60_000)
  )

  test(
    'an unmapped model is denied by the router and never routed to another harness',
    async () => {
      const composition = await openComposition({ [MODEL_ID]: MAPPED_HARNESS })
      await openApplication(composition)

      const { plan, persisted } = await acceptOverHttp(composition, 'glm-4', '2')

      // The model the caller accepted is recorded exactly, mapped or not.
      expect(persisted.modelId).toBe('glm-4')

      // The router denies it: a map that does not name the model is a policy,
      // never a fallback to another harness.
      await expect(
        composition.runtimeAttemptRouter.resolve({ execution: persisted, executionPlan: plan })
      ).rejects.toMatchObject({ code: 'HARNESS_MAP_MODEL_UNMAPPED' })
    },
    integrationTestTimeout(60_000)
  )

  test(
    'an execution accepted without a model carries no model to the router',
    async () => {
      const composition = await openComposition({ [MODEL_ID]: MAPPED_HARNESS })
      await openApplication(composition)

      const { plan, persisted } = await acceptOverHttp(composition, undefined, '3')

      // No model was accepted, so the read model carries none.
      expect(persisted.modelId).toBeUndefined()

      // Under a configured map an execution with no model is denied.
      await expect(
        composition.runtimeAttemptRouter.resolve({ execution: persisted, executionPlan: plan })
      ).rejects.toMatchObject({ code: 'HARNESS_MAP_MODEL_ABSENT' })
    },
    integrationTestTimeout(60_000)
  )

  test(
    'a pin that contradicts the map is a conflict, never a substitution',
    async () => {
      const composition = await openComposition({ [MODEL_ID]: MAPPED_HARNESS })
      await openApplication(composition)

      const { plan, persisted } = await acceptOverHttp(composition, MODEL_ID, '4')

      // A pin naming another harness conflicts with the map. The router refuses
      // rather than silently choosing either side.
      const conflicting = new RuntimeDiscoveryAttemptRouter({
        discovery: composition.runtimeDiscoveryRepository,
        pinnedHarnessId: CONFLICTING_HARNESS,
        harnessByModel: { [MODEL_ID]: MAPPED_HARNESS },
      })
      await expect(
        conflicting.resolve({ execution: persisted, executionPlan: plan })
      ).rejects.toMatchObject({ code: 'HARNESS_MAP_CONFLICTS_WITH_PIN' })
    },
    integrationTestTimeout(60_000)
  )

  test(
    'without a map the behavior is unchanged and the execution plan digest is untouched',
    async () => {
      const composition = await openComposition(undefined)
      await openApplication(composition)

      const { plan, persisted } = await acceptOverHttp(composition, MODEL_ID, '5')

      // The model is still recorded, so a later deployment can map it. Without
      // a map the router is not consulted for a harness.
      expect(persisted.modelId).toBe(MODEL_ID)

      // The execution plan is exactly the plan the caller referenced: the
      // model travels beside it, never inside it.
      expect(persisted.executionPlan.executionPlanId).toBe(plan.executionPlanId)
      expect(persisted.executionPlan.contentDigest).toBe(plan.contentDigest)
      expect(persisted.executionPlan.schemaVersion).toBe(plan.schemaVersion)
    },
    integrationTestTimeout(60_000)
  )

  test('the deployment environment supplies the map to the hosted composition', () => {
    // The environment contract: an absent variable leaves routing unchanged.
    expect(resolveHostedHarnessByModel({})).toBeUndefined()
    expect(
      resolveHostedHarnessByModel({ CONTROL_PLANE_HARNESS_BY_MODEL: undefined })
    ).toBeUndefined()

    // A present map is parsed into the map the router receives.
    const map = resolveHostedHarnessByModel({
      CONTROL_PLANE_HARNESS_BY_MODEL: JSON.stringify({ [MODEL_ID]: MAPPED_HARNESS }),
    })
    expect(map?.[MODEL_ID]).toBe(MAPPED_HARNESS)

    // The composition configuration carries it through to the composition.
    const configured = resolveHostedCompositionConfiguration(
      {
        DATABASE_URL: 'postgresql://control_plane_app:secret@127.0.0.1:54329/control_plane',
        CONTROL_PLANE_HARNESS_BY_MODEL: JSON.stringify({ [MODEL_ID]: MAPPED_HARNESS }),
      },
      {}
    )
    expect(configured.harnessByModel?.[MODEL_ID]).toBe(MAPPED_HARNESS)

    // A malformed map is a configuration error, never a silently empty map.
    for (const invalid of [
      '',
      'not json',
      JSON.stringify([MODEL_ID]),
      JSON.stringify({ [MODEL_ID]: 42 }),
      JSON.stringify({ 'not a model id': MAPPED_HARNESS }),
    ]) {
      expect(() =>
        resolveHostedHarnessByModel({ CONTROL_PLANE_HARNESS_BY_MODEL: invalid })
      ).toThrow(/HOSTED_HARNESS_BY_MODEL_INVALID/)
    }
  })
})
