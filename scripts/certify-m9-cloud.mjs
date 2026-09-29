import { Buffer } from 'node:buffer'
import { createHash, createPrivateKey, randomBytes, sign, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { URL } from 'node:url'
import { TextEncoder } from 'node:util'
import { ContextPackageCompiler } from '@control-plane/context'
import {
  ExecutionAcceptanceRequestSchema,
  ExecutionAcceptanceResponseSchema,
  ServiceCredentialClaimsSchema,
} from '@control-plane/contracts'
import { ExecutionPlanCompiler, ExecutionPlanSchema } from '@control-plane/execution-plan'

const certificationContract = 'contract://control-plane/m9-cloud-certification/v1'
const crockfordAlphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function createCertificationPlan({ runSuffix, compiledAt }) {
  assertRunSuffix(runSuffix)
  const ids = certificationIds(runSuffix)
  const contextPackage = new ContextPackageCompiler('1.0.0').compile({
    objective: 'Certify the managed-cloud execution lifecycle and retained result.',
    projectState: {
      schemaVersion: 1,
      workspaceId: ids.workspaceId,
      projectId: ids.projectId,
      revision: 0,
      items: [],
      createdAt: compiledAt,
      updatedAt: compiledAt,
    },
    expectedProjectStateRevision: 0,
    candidates: [],
    artifacts: [],
    constraints: {
      allowedSensitivities: ['public'],
      allowedStateItemIds: [],
      allowedArtifactIds: [],
    },
    permissions: [],
    successCriteria: ['Persist and integrity-check one deterministic terminal result.'],
    returnContract: { contractRef: certificationContract },
    budgets: { maximumBytes: 1_024, maximumTokens: 256 },
    compiledAt,
  })
  const constraints = certificationConstraints()
  return new ExecutionPlanCompiler('1.0.0').compile({
    correlation: {
      workspaceId: ids.workspaceId,
      projectId: ids.projectId,
      taskId: ids.taskId,
      agentId: ids.agentId,
      requestId: ids.requestId,
    },
    profile: {
      profileVersionId: ids.profileVersionId,
      profileId: ids.profileId,
      version: 1,
      revision: 1,
      lifecycle: 'published',
      contentDigest: digest(`m9-certification-profile:${runSuffix}`),
      definition: {
        schemaVersion: 1,
        roleInstructions: 'Execute only the bounded M9 cloud certification contract.',
        skills: [],
        capabilityRequirements: [],
        executionConstraints: constraints,
        outputContractRefs: [certificationContract],
      },
      createdAt: compiledAt,
      lifecycleMetadata: { publishedAt: compiledAt },
    },
    skills: [],
    contextPackage,
    constraints,
    requestConstraints: [],
    runtimeRequirements: [],
    outputContract: { contractRef: certificationContract },
    compiledAt,
  })
}

export function createCertificationRequest({ plan: planValue, runSuffix, now }) {
  const plan = ExecutionPlanSchema.parse(planValue)
  assertRunSuffix(runSuffix)
  const ids = certificationIds(runSuffix)
  if (
    plan.correlation.workspaceId !== ids.workspaceId ||
    plan.correlation.projectId !== ids.projectId ||
    plan.correlation.taskId !== ids.taskId ||
    plan.correlation.agentId !== ids.agentId
  ) {
    throw new Error('M9_CERTIFICATION_SCOPE_MISMATCH')
  }
  return ExecutionAcceptanceRequestSchema.parse({
    caller: { servicePrincipalId: 'svc_agent-hq' },
    contractVersion: { major: 1, minor: 0 },
    requestId: ids.requestId,
    workspaceId: ids.workspaceId,
    projectId: ids.projectId,
    correlation: { traceId: ids.traceId },
    commandId: ids.commandId,
    idempotencyKey: `m9-certification:${runSuffix}`,
    payloadHash: createHash('sha256').update(plan.contentDigest).digest('hex'),
    operation: 'execution.accept',
    issuedAt: now.toISOString(),
    payload: {
      taskId: ids.taskId,
      agentId: ids.agentId,
      executionPlan: {
        executionPlanId: plan.executionPlanId,
        contentDigest: plan.contentDigest,
        schemaVersion: plan.schemaVersion,
      },
      deadlineAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
      retentionExpiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60_000).toISOString(),
    },
  })
}

export function createSignedServiceCredential({ privateKey, issuer, keyId, runSuffix, now }) {
  assertRunSuffix(runSuffix)
  const ids = certificationIds(runSuffix)
  const claims = ServiceCredentialClaimsSchema.parse({
    audience: 'control-plane',
    credentialId: `m9-certification-${runSuffix}`,
    credentialKind: 'service',
    issuedAt: new Date(now.getTime() - 5_000).toISOString(),
    expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
    issuer,
    keyId,
    principalId: 'svc_agent-hq',
    projectIds: [ids.projectId],
    scopes: ['execution:accept'],
    workspaceIds: [ids.workspaceId],
  })
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: keyId, typ: 'JWT' })).toString(
    'base64url'
  )
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const signingInput = `${header}.${payload}`
  const signature = sign(null, Buffer.from(signingInput), privateKey).toString('base64url')
  return `${signingInput}.${signature}`
}

export async function runCloudCertification(options, adapters) {
  if (typeof options.objectPrefix !== 'string' || options.objectPrefix.length === 0) {
    throw new Error('M9_CERTIFICATION_R2_PREFIX_REQUIRED')
  }
  const startedAt = adapters.now()
  const plan = ExecutionPlanSchema.parse(options.plan)
  const request = ExecutionAcceptanceRequestSchema.parse(options.request)
  await adapters.seedPlan(plan)
  const accepted = ExecutionAcceptanceResponseSchema.parse(
    await adapters.acceptExecution(request, options.credential)
  )
  const executionId = accepted.data.executionId
  const deadline = startedAt.getTime() + options.timeoutMs
  let state
  while (adapters.now().getTime() <= deadline) {
    state = await adapters.readAuthoritativeState({
      callerPrincipalId: 'svc_agent-hq',
      operation: request.operation,
      workspaceId: request.workspaceId,
      projectId: request.projectId,
      idempotencyKey: request.idempotencyKey,
      executionId,
    })
    if (isTerminalCertificationState(state)) break
    await adapters.sleep(options.pollIntervalMs)
  }
  if (!isTerminalCertificationState(state)) throw new Error('M9_CERTIFICATION_TERMINAL_TIMEOUT')

  const artifactId = `art_${executionId.slice(4)}`
  if (
    state.command.resultReference !== artifactId ||
    state.execution.terminalResultRef !== artifactId ||
    state.attempts.length !== 1 ||
    state.attempts[0].terminalResultRef !== artifactId
  ) {
    throw new Error('M9_CERTIFICATION_AUTHORITATIVE_STATE_MISMATCH')
  }
  const key = certificationObjectKey(executionId, plan.contentDigest)
  const artifact = await adapters.readArtifact(key)
  assertCertificationArtifact(artifact, plan, executionId, artifactId)

  const replay = ExecutionAcceptanceResponseSchema.parse(
    await adapters.acceptExecution(request, options.credential)
  )
  if (
    !replay.data.replayed ||
    replay.data.executionId !== executionId ||
    replay.data.commandId !== request.commandId ||
    replay.data.resultReference !== artifactId
  ) {
    throw new Error('M9_CERTIFICATION_REPLAY_MISMATCH')
  }

  return {
    schemaVersion: 1,
    status: 'passed',
    profile: 'cloud',
    executionId,
    artifactId,
    commandStatus: state.command.status,
    executionState: state.execution.state,
    attemptCount: state.attempts.length,
    replayed: replay.data.replayed,
    objectKey: key,
    objectPrefix: options.objectPrefix,
    objectSha256: artifact.sha256,
    startedAt: startedAt.toISOString(),
    completedAt: adapters.now().toISOString(),
  }
}

function certificationConstraints() {
  return {
    schemaVersion: 1,
    context: { allowedClassifications: ['public'], maximumItems: 1, maximumBytes: 1_024 },
    tools: { default: 'deny', grants: [] },
    models: [
      {
        alias: 'certification.none',
        requiredCapabilities: [],
        providerPolicy: {
          allowedClasses: ['local'],
          deniedProviders: [],
          dataResidency: ['local'],
        },
        fallback: 'none',
      },
    ],
    runtime: { allowedFamilies: ['mock'], allowedLocations: ['remote'], requiredCapabilities: [] },
    limits: {
      budget: { currency: 'USD', maximumMicrounits: 1 },
      tokens: { maximumTotal: 1 },
      duration: { maximumMs: 900_000 },
      concurrency: { maximumParallel: 1 },
      childExecutions: { maximumTotal: 0, maximumDepth: 0 },
      sandbox: { cpuMillicores: 1, memoryMebibytes: 1, storageMebibytes: 1 },
    },
    interaction: {
      approvals: 'disabled',
      userInput: 'disabled',
      destructiveOperations: 'deny',
      approvalExpiryMs: 1,
    },
    policySnapshot: {
      policyId: 'm9-cloud-certification',
      version: 1,
      digest: digest('m9-cloud-certification-policy-v1'),
    },
  }
}

function certificationIds(runSuffix) {
  return {
    workspaceId: `wsp_${runSuffix}`,
    projectId: `prj_${runSuffix}`,
    taskId: `tsk_${runSuffix}`,
    agentId: `agt_${runSuffix}`,
    requestId: `req_${runSuffix}`,
    traceId: `trc_${runSuffix}`,
    commandId: `cmd_${runSuffix}`,
    profileId: `prf_${runSuffix}`,
    profileVersionId: `pfv_${runSuffix}`,
  }
}

function certificationObjectKey(executionId, contentDigest) {
  return `m9/certification/executions/${executionId}/${contentDigest.slice(7)}.json`
}

function isTerminalCertificationState(state) {
  return (
    state?.command?.status === 'completed' &&
    state?.execution?.state === 'completed' &&
    state?.attempts?.length === 1 &&
    state.attempts[0]?.state === 'completed'
  )
}

function assertCertificationArtifact(artifact, plan, executionId, artifactId) {
  const runSuffix = executionId.slice(4)
  const attemptId = `att_${runSuffix}`
  const expectedBody = new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: 1,
      kind: 'cloud-certification-result',
      artifactId,
      executionId,
      attemptId,
      executionPlan: {
        executionPlanId: plan.executionPlanId,
        contentDigest: plan.contentDigest,
        schemaVersion: plan.schemaVersion,
      },
      effectKey: `wfl_${runSuffix}:execution-lifecycle-v1:dispatch`,
    })
  )
  const expectedDigest = `sha256:${createHash('sha256').update(expectedBody).digest('hex')}`
  if (
    artifact.size !== expectedBody.byteLength ||
    artifact.sha256 !== expectedDigest ||
    artifact.contentType !== 'application/json' ||
    artifact.metadata?.['execution-id'] !== executionId ||
    artifact.metadata?.['attempt-id'] !== attemptId ||
    artifact.body.byteLength !== expectedBody.byteLength ||
    !timingSafeEqual(artifact.body, expectedBody)
  ) {
    throw new Error('M9_CERTIFICATION_R2_INTEGRITY_MISMATCH')
  }
}

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function assertRunSuffix(value) {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(value)) throw new Error('M9_CERTIFICATION_RUN_ID_INVALID')
}

function createRunSuffix() {
  let value = BigInt(`0x${randomBytes(16).toString('hex')}`)
  let encoded = ''
  for (let index = 0; index < 26; index += 1) {
    encoded = crockfordAlphabet[Number(value & 31n)] + encoded
    value >>= 5n
  }
  return encoded
}

async function main() {
  const environment = requiredEnvironment(process.env)
  const runSuffix = createRunSuffix()
  const now = new Date()
  const plan = createCertificationPlan({ runSuffix, compiledAt: now.toISOString() })
  const request = createCertificationRequest({ plan, runSuffix, now })
  const privateKey = createPrivateKey(await readFile(environment.privateKeyFile))
  const credential = createSignedServiceCredential({
    privateKey,
    issuer: environment.issuer,
    keyId: environment.keyId,
    runSuffix,
    now,
  })
  const [
    {
      createPostgresConnection,
      PostgresCommandAcceptanceRepository,
      PostgresExecutionPlanRepository,
      PostgresExecutionRepository,
    },
    { createR2ObjectStore },
  ] = await Promise.all([import('@control-plane/database'), import('@control-plane/object-store')])
  const connection = createPostgresConnection(
    { role: 'application', url: environment.databaseUrl },
    { maxConnections: 1 }
  )
  const plans = new PostgresExecutionPlanRepository(connection.database)
  const commands = new PostgresCommandAcceptanceRepository(connection.database)
  const executions = new PostgresExecutionRepository(connection.database)
  const objects = createCertificationObjectStore(environment, createR2ObjectStore)
  try {
    const evidence = await runCloudCertification(
      {
        plan,
        request,
        credential,
        objectPrefix: environment.r2Prefix,
        pollIntervalMs: 1_000,
        timeoutMs: 120_000,
      },
      {
        seedPlan: (value) => plans.put(value),
        acceptExecution: (input, bearer) => acceptExecution(environment.apiUrl, input, bearer),
        readAuthoritativeState: async (scope) => ({
          command: await commands.get(scope),
          execution: await executions.getExecution(scope.executionId),
          attempts: await executions.listAttempts(scope.executionId),
        }),
        readArtifact: (key) => objects.get(key),
        sleep: (milliseconds) => delay(milliseconds),
        now: () => new Date(),
      }
    )
    globalThis.console.log(JSON.stringify(evidence))
  } finally {
    await Promise.allSettled([connection.close(), objects.close()])
  }
}

async function acceptExecution(apiUrl, request, credential) {
  const response = await globalThis.fetch(new URL('/v1/executions/accept', apiUrl), {
    method: 'POST',
    redirect: 'error',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${credential}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(request),
    signal: globalThis.AbortSignal.timeout(15_000),
  })
  const body = await response.json().catch(() => undefined)
  if (!response.ok) {
    const code =
      body && typeof body === 'object' && typeof body.error?.code === 'string'
        ? body.error.code
        : 'UNKNOWN'
    throw new Error(`M9_CERTIFICATION_API_REJECTED:${response.status}:${code}`)
  }
  return ExecutionAcceptanceResponseSchema.parse(body)
}

export function requiredEnvironment(environment) {
  const names = [
    'M9_CONTROL_API_URL',
    'M9_SERVICE_AUTH_ISSUER',
    'M9_SERVICE_AUTH_KEY_ID',
    'M9_SERVICE_AUTH_PRIVATE_KEY_FILE',
    'DATABASE_URL',
    'R2_ENDPOINT',
    'R2_BUCKET',
    'R2_PREFIX',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
  ]
  const missing = names.filter((name) => !environment[name])
  if (missing.length > 0)
    throw new Error(`M9_CERTIFICATION_CONFIGURATION_MISSING:${missing.join(',')}`)
  return {
    apiUrl: environment.M9_CONTROL_API_URL,
    issuer: environment.M9_SERVICE_AUTH_ISSUER,
    keyId: environment.M9_SERVICE_AUTH_KEY_ID,
    privateKeyFile: environment.M9_SERVICE_AUTH_PRIVATE_KEY_FILE,
    databaseUrl: environment.DATABASE_URL,
    r2Endpoint: environment.R2_ENDPOINT,
    r2Bucket: environment.R2_BUCKET,
    r2Prefix: environment.R2_PREFIX,
    r2AccessKeyId: environment.R2_ACCESS_KEY_ID,
    r2SecretAccessKey: environment.R2_SECRET_ACCESS_KEY,
  }
}

export function createCertificationObjectStore(environment, createR2ObjectStore) {
  return createR2ObjectStore(
    {
      endpoint: environment.r2Endpoint,
      bucket: environment.r2Bucket,
      region: 'auto',
      accessKeyId: environment.r2AccessKeyId,
      secretAccessKey: environment.r2SecretAccessKey,
      prefix: environment.r2Prefix,
    },
    { maxObjectBytes: 1_048_576 }
  )
}

if (import.meta.main) await main()
