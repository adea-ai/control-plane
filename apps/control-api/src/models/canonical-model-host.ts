import {
  canonicalJsonStringify,
  executionScopesEqual,
  IdentifierSchemas,
} from '@control-plane/contracts'
import {
  ExecutionSchema,
  ExecutionAttemptSchema,
  ExecutionPlanPinSchema,
  type ExecutionRepository,
} from '@control-plane/domain'
import {
  assertExecutionPlanIntegrity,
  currentExecutionScopeAllows,
  type ExecutionPlanRepository,
  type CurrentExecutionScopeAuthority,
} from '@control-plane/execution-plan'
import {
  ExecutionModelSelectionBindingSchema,
  ModelConnectionSchema,
  ModelSelectionError,
} from '@control-plane/model-gateway'
import type { AcceptedModelFundingExecutionAuthority } from './recorded-model-funding.js'

const Ref = ExecutionModelSelectionBindingSchema.shape.canonicalActorPrincipalId
// A metadata projection of the retained canonical intent, not another public intent schema.
const Metadata = ExecutionModelSelectionBindingSchema.pick({
  workspaceId: true,
  executionId: true,
  attemptId: true,
  canonicalActorPrincipalId: true,
  principalRef: true,
  authorityRevision: true,
  selectionRef: true,
  selectionRevision: true,
}).extend({
  intentId: Ref.regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i),
  scopeRef: Ref,
  expiresAt: ModelConnectionSchema.shape.workspaceGrant.shape.expiresAt,
  allowedPrincipalIds: Ref.array()
    .min(1)
    .max(256)
    .refine((values) => new Set(values).size === values.length),
})
function projection(input: unknown) {
  if (!input || typeof input !== 'object') deny()
  return Metadata.parse(
    Object.fromEntries(Object.keys(Metadata.shape).map((key) => [key, Reflect.get(input, key)]))
  )
}
function deny(): never {
  throw new ModelSelectionError('PROVIDER_POLICY_DENIED')
}
const same = (left: unknown, right: unknown) =>
  canonicalJsonStringify(left) === canonicalJsonStringify(right)
const liveExecution = new Set(['accepted', 'queued', 'starting', 'running', 'awaiting_input'])
const liveAttempt = new Set(['queued', 'starting', 'running', 'awaiting_input'])

export interface CanonicalModelExecutionHostOptions {
  readonly executions: Pick<ExecutionRepository, 'getExecution' | 'getAttempt'>
  readonly plans: Pick<ExecutionPlanRepository, 'get'>
  /** Actual retained Node store. marker actor is the transport principal; intent actor is original product actor. */
  readonly intents: {
    getByAttempt(attemptId: string): Promise<unknown | undefined>
    marker(intentId: string): unknown | undefined
  }
  /** Existing authenticated product authority port; return canonical evidence, never a client body. */
  readonly product: {
    readCurrent(input: {
      schemaVersion: 'pi-lead-intent/v1'
      intentId: string
      workspaceId: string
      principalId: string
    }): Promise<unknown | undefined>
  }
  readonly scopeAuthority: CurrentExecutionScopeAuthority
  readonly leasePrincipalRef: string
  readonly modelAlias: string
  readonly now?: () => string
}

/** Concrete repository-backed host shared by funding reads and R1's per-execution facade.
 * Contains references only. No credential, prompt, grant creation, budget allocation or registry.
 */
export function createCanonicalModelExecutionAuthority(
  options: CanonicalModelExecutionHostOptions
): AcceptedModelFundingExecutionAuthority {
  const leasePrincipalRef = Ref.parse(options.leasePrincipalRef)
  const modelAlias = Ref.parse(options.modelAlias)
  const now = options.now ?? (() => new Date().toISOString())
  async function safe<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof ModelSelectionError) throw error
      return deny()
    }
  }
  async function derive(attemptId: string) {
    IdentifierSchemas.attemptId.parse(attemptId)
    const intentInput = await options.intents.getByAttempt(attemptId)
    const intent = projection(intentInput)
    if (intent.attemptId !== attemptId) deny()
    const marker = options.intents.marker(intent.intentId)
    if (!marker || typeof marker !== 'object' || Reflect.get(marker, 'state') !== 'ready') deny()
    const transport = Ref.parse(Reflect.get(marker, 'actorPrincipalId'))
    if (!same(projection(Reflect.get(marker, 'intent')), intent)) deny()
    const markerPin = ExecutionPlanPinSchema.parse(Reflect.get(marker, 'planPin'))
    const execution = ExecutionSchema.parse(
      await options.executions.getExecution(intent.executionId)
    )
    const attempt = ExecutionAttemptSchema.parse(await options.executions.getAttempt(attemptId))
    const checkOwners = (owner: typeof execution, child: typeof attempt) => {
      const at = Date.parse(now())
      if (
        !Number.isFinite(at) ||
        !liveExecution.has(owner.state) ||
        !liveAttempt.has(child.state) ||
        owner.executionId !== intent.executionId ||
        child.attemptId !== intent.attemptId ||
        child.executionId !== owner.executionId ||
        owner.latestAttemptId !== child.attemptId ||
        owner.correlation.workspaceId !== intent.workspaceId ||
        !same(owner.executionPlan, markerPin) ||
        at >= Date.parse(intent.expiresAt) ||
        [owner.deadlineAt, child.deadlineAt].some(
          (value) => value !== undefined && at >= Date.parse(value)
        )
      )
        deny()
    }
    checkOwners(execution, attempt)
    const plan = assertExecutionPlanIntegrity(await options.plans.get(execution.executionPlan))
    if (
      plan.schemaVersion !== 2 ||
      !same(
        {
          executionPlanId: plan.executionPlanId,
          contentDigest: plan.contentDigest,
          schemaVersion: plan.schemaVersion,
        },
        execution.executionPlan
      ) ||
      !same(plan.correlation, execution.correlation) ||
      !executionScopesEqual(
        plan.correlation,
        intentInput as Parameters<typeof executionScopesEqual>[1]
      ) ||
      !plan.constraints.models.some((model) => model.alias === modelAlias)
    )
      deny()
    const currentProduct = async () => {
      const evidence = await options.product.readCurrent({
        schemaVersion: 'pi-lead-intent/v1',
        intentId: intent.intentId,
        workspaceId: intent.workspaceId,
        principalId: transport,
      })
      if (!evidence || typeof evidence !== 'object') deny()
      if (
        !executionScopesEqual(
          plan.correlation,
          evidence as Parameters<typeof executionScopesEqual>[1]
        )
      )
        deny()
      // CP execution/attempt IDs belong to the retained server record, not product evidence.
      const current = projection({
        ...evidence,
        executionId: intent.executionId,
        attemptId: intent.attemptId,
      })
      if (
        !same(
          { ...current, allowedPrincipalIds: current.allowedPrincipalIds.toSorted() },
          { ...intent, allowedPrincipalIds: intent.allowedPrincipalIds.toSorted() }
        ) ||
        !current.allowedPrincipalIds.includes(transport) ||
        Date.parse(now()) >= Date.parse(current.expiresAt)
      )
        deny()
    }
    let scopeExpiresAt = -Infinity
    const currentScope = async () => {
      const started = Date.parse(now())
      if (!Number.isFinite(started)) deny()
      const completedReadAuthority: CurrentExecutionScopeAuthority = {
        async readCurrent(input) {
          const snapshot = await options.scopeAuthority.readCurrent(input)
          const completed = Date.parse(now())
          if (
            !snapshot ||
            !Number.isFinite(completed) ||
            completed < started ||
            completed >= Date.parse(snapshot.expiresAt)
          )
            deny()
          scopeExpiresAt = Date.parse(snapshot.expiresAt)
          return snapshot
        },
      }
      if (
        !(await currentExecutionScopeAllows(
          completedReadAuthority,
          {
            ...plan.correlation,
            callerPrincipalId: intent.canonicalActorPrincipalId,
            executionPlan: execution.executionPlan,
          },
          new Date(started).toISOString()
        ))
      )
        deny()
    }
    await currentProduct()
    await currentScope()
    await currentProduct()
    const finalExecution = ExecutionSchema.parse(
      await options.executions.getExecution(intent.executionId)
    )
    const finalAttempt = ExecutionAttemptSchema.parse(
      await options.executions.getAttempt(attemptId)
    )
    checkOwners(finalExecution, finalAttempt)
    if (!same(finalExecution.correlation, execution.correlation)) deny()
    await currentScope()
    const completedExecution = ExecutionSchema.parse(
      await options.executions.getExecution(intent.executionId)
    )
    const completedAttempt = ExecutionAttemptSchema.parse(
      await options.executions.getAttempt(attemptId)
    )
    checkOwners(completedExecution, completedAttempt)
    if (
      !same(completedExecution.correlation, execution.correlation) ||
      Date.parse(now()) >= scopeExpiresAt
    )
      deny()
    const binding = ExecutionModelSelectionBindingSchema.parse({
      schemaVersion: 'execution-model-selection/v1',
      workspaceId: intent.workspaceId,
      executionId: intent.executionId,
      attemptId,
      requestId: plan.correlation.requestId,
      executionPlanId: plan.executionPlanId,
      executionPlanDigest: plan.contentDigest,
      executionPlanSchemaVersion: plan.schemaVersion,
      policySnapshotDigest: plan.policySnapshot.digest,
      principalRef: intent.principalRef,
      canonicalActorPrincipalId: intent.canonicalActorPrincipalId,
      leasePrincipalRef,
      modelAlias,
      authorityRevision: intent.authorityRevision,
      selectionRef: intent.selectionRef,
      selectionRevision: intent.selectionRevision,
    })
    return { binding, audience: intent.allowedPrincipalIds }
  }
  return {
    resolveForReader: (input) =>
      safe(async () => {
        const { binding, audience } = await derive(input.attemptId)
        if (!audience.includes(input.principalId)) deny()
        if (
          binding.workspaceId !== input.workspaceId ||
          binding.executionId !== input.executionId ||
          binding.selectionRef !== input.selectionRef ||
          binding.selectionRevision !== input.selectionRevision
        )
          throw new ModelSelectionError('SELECTION_CHANGED')
        return binding
      }),
    assertCurrent: (input) =>
      safe(async () => {
        const claimed = ExecutionModelSelectionBindingSchema.parse(input)
        const { binding } = await derive(claimed.attemptId)
        if (!same(binding, claimed)) throw new ModelSelectionError('SELECTION_CHANGED')
      }),
  }
}
