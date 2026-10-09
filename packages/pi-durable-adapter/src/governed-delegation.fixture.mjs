import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'
import { ExecutionPlanCompiler } from '@control-plane/execution-plan'
import {
  InMemoryToolRegistryRepository,
  InMemoryToolRateLimiter,
  PolicyControlledToolExecutionService,
  StaticToolPolicyAuthorizer,
  ToolGateway,
  ToolRegistry,
} from '@control-plane/tool-execution'
import { PiDurableEngineToolBlockedError } from './pi-engine.ts'
import { piDurableToolSourceKey } from './tool-source.ts'

export const id = (prefix) => `${prefix}_01JABCDEF0123456789ABCDEFG`
const at = '2026-10-08T00:00:00.000Z'
export const inference = (n) => ({
  inferenceId: `pi-generation:${n}`,
  usage: {
    inputTokens: 3,
    outputTokens: 4,
    durationMs: 2,
    cachedInputTokens: 0,
    reasoningTokens: 0,
  },
})
export async function governedFixture(directory) {
  const inputs = createExecutionPlanTestFixtureInputs({
    profileCapabilityRequirements: [],
    skillRequiredCapabilities: [],
  })
  inputs.constraints.limits.childExecutions.maximumTotal = 1
  inputs.profile.definition.executionConstraints.limits.childExecutions.maximumTotal = 1
  const plan = new ExecutionPlanCompiler('1.0.0').compile(inputs)
  const request = {
    executionId: id('exe'),
    attemptId: id('att'),
    idempotencyKey: 'governed:turn:one',
    executionPlan: plan,
    attemptBudget: {
      schemaVersion: 1,
      workspaceId: plan.correlation.workspaceId,
      executionId: id('exe'),
      attemptId: id('att'),
      executionPlanId: plan.executionPlanId,
      executionPlanDigest: plan.contentDigest,
      reservationKey: `runtime-attempt:${id('att')}`,
      currency: 'USD',
      maximumMicrounits: 1000,
      maximumTokens: 100,
    },
  }
  const admission = {
    schemaVersion: 'pi-durable-admission/v1',
    prompt: 'Delegate one bounded objective',
    canonicalActorPrincipalId: 'principal:original-actor',
    selection: { selectionRef: `msel_${'a'.repeat(32)}`, selectionRevision: 1 },
    authority: {
      revision: 1,
      principalRef: 'lease:transport-service',
      scopeRef: 'scope:one',
      expiresAt: '2027-01-01T00:00:00.000Z',
    },
  }
  const database = new DatabaseSync(join(directory, 'host-compiler.sqlite'))
  database.exec(
    'CREATE TABLE IF NOT EXISTS compiled (source_key TEXT PRIMARY KEY, request TEXT); CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, revision INTEGER, body TEXT); CREATE TABLE IF NOT EXISTS settlements (key TEXT PRIMARY KEY, usage TEXT)'
  )
  const state = {
    effects: 0,
    approved: false,
    revoked: false,
    preparations: [],
    outcomes: [],
    ports: [],
    calls: 0,
    controller: new AbortController(),
  }
  const calls = {
    get: async (key) => {
      const row = database.prepare('SELECT body FROM calls WHERE id=?').get(key)
      return row ? JSON.parse(row.body) : undefined
    },
    getByIdempotencyKey: async (workspaceId, key) =>
      database
        .prepare('SELECT body FROM calls')
        .all()
        .map((row) => JSON.parse(row.body))
        .find((call) => call.workspaceId === workspaceId && call.idempotencyKey === key),
    insert: async (call) =>
      database
        .prepare('INSERT OR IGNORE INTO calls VALUES (?,?,?)')
        .run(call.toolCallId, call.revision, JSON.stringify(call)).changes === 1,
    compareAndSet: async (revision, call) =>
      database
        .prepare('UPDATE calls SET revision=?,body=? WHERE id=? AND revision=?')
        .run(call.revision, JSON.stringify(call), call.toolCallId, revision).changes === 1,
    listByExecution: async () => [],
  }
  const registry = new ToolRegistry(new InMemoryToolRegistryRepository())
  await registry.createDefinition({
    toolDefinitionId: id('tld'),
    name: 'delegate-child',
    displayName: 'Delegate child',
    description: 'Server governed child bridge mock',
    ownership: { scope: 'workspace', workspaceId: request.attemptBudget.workspaceId },
    createdAt: at,
  })
  await registry.publishVersion({
    toolDefinitionId: id('tld'),
    toolVersionId: id('tlv'),
    semanticVersion: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: { objective: { type: 'string' } },
      required: ['objective'],
      additionalProperties: false,
    },
    outputSchema: { type: 'object' },
    operations: [
      {
        name: 'delegate-child',
        requiredCapabilities: [],
        riskClass: 'high',
        approvalMode: 'always',
        idempotency: 'provider_key',
        retryPolicy: { maxAttempts: 1, retryableErrorCodes: [] },
      },
    ],
    executor: { type: 'connector', reference: 'child-bridge:one' },
    limits: { maxInputBytes: 10000, maxOutputBytes: 10000, timeoutMs: 1000 },
    createdAt: at,
    publishedAt: at,
  })
  const gateway = new ToolGateway(registry)
  gateway.registerExecutor('connector', 'child-bridge:one', {
    execute: async () => {
      state.effects++
      await state.afterEffect?.()
      return {
        output: {
          delegationId: id('dlg'),
          childExecutionId: id('exe').replace(/G$/, 'H'),
          childAttemptId: id('att').replace(/G$/, 'H'),
          externalSessionId: id('ses'),
          ignoredPrivateField: 'opaque-private-diagnostic',
        },
      }
    },
  })
  const service = new PolicyControlledToolExecutionService({
    gateway,
    calls,
    authorizer: new StaticToolPolicyAuthorizer({
      effect: 'allow',
      decisionId: 'policy:one',
      policyVersion: '1',
      reasonCode: 'GRANTED',
      requiresApproval: true,
      evaluatedAt: at,
    }),
    approvals: {
      review: async (input) => {
        state.calls++
        await state.onReview?.()
        return {
          state: state.approved ? 'approved' : 'pending',
          interactionId: input.interactionId,
          ...(state.approved ? { decisionPrincipalRef: admission.canonicalActorPrincipalId } : {}),
        }
      },
    },
    rateLimiter: new InMemoryToolRateLimiter(),
    now: () => at,
  })
  const options = {
    directory,
    now: () => at,
    resolveAdmission: async () => admission,
    assertAuthority: async () => {
      if (state.revoked) throw new Error('secret-canonical-revocation')
    },
    resolveProvider: async () => ({
      selectionRef: admission.selection.selectionRef,
      selectionRevision: 1,
      workspaceId: plan.correlation.workspaceId,
      provider: 'scripted',
      providerModel: 'mock',
      location: 'remote_host',
      harness: 'pi_durable',
      harnessVersion: '1.1.0',
      providerBinding: 'pi_durable_models',
      withModels: async (use) => use({}),
    }),
    authorizeInference: async () => ({
      maxOutputTokens: 10,
      maximumInputTokens: 64,
      assertActive: async () => {},
    }),
    settleUsage: async (_authority, key, counts) => {
      const row = database.prepare('SELECT usage FROM settlements WHERE key=?').get(key)
      if (row) return JSON.parse(row.usage)
      const usage = {
        ...counts,
        cost: { amount: '0.000007', currency: 'USD' },
        accounting: {
          schemaVersion: 1,
          sourceId: key,
          fundingSource: state.mixedFunding && key.endsWith(':2') ? 'hq_managed' : 'byo_api',
          currency: 'USD',
          chargedMicrounits: 7,
          costExact: true,
        },
      }
      database.prepare('INSERT INTO settlements VALUES (?,?)').run(key, JSON.stringify(usage))
      return usage
    },
    reconcileInference: async () => 'safe_to_resume',
    verifyApproval: async (_authority, _identity, submitted) =>
      state.approved && submitted.decision === 'approve',
    tools: {
      service,
      assertAuthority: async () => {
        if (state.revoked) throw new Error('secret-host-policy')
      },
      now: () => at,
    },
    governedDelegateChild: {
      prepare: async (authority, verified) => {
        state.preparations.push(structuredClone({ authority, verified }))
        await state.beforePrepare?.(verified)
        const previous = database
          .prepare('SELECT request FROM compiled WHERE source_key=?')
          .get(verified.sourceKey)
        if (previous) return JSON.parse(previous.request)
        const full = {
          requestId: id('req'),
          toolCallId: id('tlc'),
          executionId: authority.request.executionId,
          attemptId: authority.request.attemptId,
          workspaceId: authority.request.attemptBudget.workspaceId,
          profileId: plan.profile.profileId,
          toolDefinitionId: id('tld'),
          toolVersionId: id('tlv'),
          operation: 'delegate-child',
          input: { objective: verified.objective },
          idempotencyKey: verified.sourceKey,
          requestedAt: at,
          policySnapshotRef: 'policy://canonical/one',
          grant: {
            workspaceId: plan.correlation.workspaceId,
            profileId: plan.profile.profileId,
            toolDefinitionId: id('tld'),
            toolVersionId: id('tlv'),
            operations: ['delegate-child'],
            expiresAt: '2027-01-01T00:00:00.000Z',
          },
          audit: { principalRef: admission.canonicalActorPrincipalId, traceId: id('trc') },
          approval: {
            interactionId: id('int'),
            allowedPrincipalIds: [admission.canonicalActorPrincipalId],
            requestedAt: at,
            expiresAt: '2027-01-01T00:00:00.000Z',
          },
        }
        Object.assign(full, state.forgeRequest?.(full) ?? {})
        database
          .prepare('INSERT INTO compiled VALUES (?,?)')
          .run(verified.sourceKey, JSON.stringify(full))
        return full
      },
    },
    engineFactory: async (ports) => {
      state.ports.push(ports)
      return {
        run: async () => {
          if (!ports.governedDelegateChild)
            return {
              text: 'Tools disabled',
              submissionId: 'submission:one',
              usage: {},
              inferences: [inference(1)],
            }
          const source = {
            schemaVersion: 'pi-tool-source/v1',
            ...ports.governedDelegateChild.source,
            conversationId: '1',
            taskId: '2',
            assistantEntryId: '3',
            callId: 'native:call:one',
          }
          const objective = 'Inspect one child target'
          const task = {
            id: 2,
            conversationId: 1,
            kind: 'pi.tool',
            version: 1,
            abortRequested: false,
            input: { assistant: 3, callId: source.callId },
            state: {
              status: 'running',
              checkpoint: { phase: 'execute', arguments: { objective }, replay: 'safe' },
            },
          }
          const entry = {
            id: 3,
            conversationId: 1,
            kind: 'pi.assistant',
            model: [
              {
                role: 'assistant',
                content: [
                  {
                    type: 'toolCall',
                    id: source.callId,
                    name: 'delegate_child',
                    arguments: { objective },
                  },
                ],
              },
            ],
          }
          state.currentTask = task
          await state.beforeNative?.(source, task, entry)
          const reader = {
            readTask: async () => structuredClone(task),
            readAssistantEntry: async () => structuredClone(entry),
          }
          const input = { source, sourceKey: piDurableToolSourceKey(source), objective }
          const outcome = await ports.governedDelegateChild.execute(
            input,
            reader,
            state.controller.signal
          )
          state.outcomes.push(outcome)
          if (outcome.state !== 'succeeded')
            throw new PiDurableEngineToolBlockedError(outcome, source, input.sourceKey, [
              inference(1),
            ])
          return {
            text: 'Child admitted',
            submissionId: 'submission:one',
            usage: {},
            inferences: [inference(1), inference(2)],
          }
        },
        close: async () => {},
        cancel: async () => {},
      }
    },
  }
  return { options, request, admission, state, database, close: () => database.close() }
}
