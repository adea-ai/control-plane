import { createHash } from 'node:crypto'
import { ExecutionConstraintSetSchema } from '@control-plane/domain'
import {
  CapabilityRequirementSetSchema,
  RuntimeAdapterError,
  RuntimeAdapterInspectionSchema,
  RuntimeApprovalRequestSchema,
  RuntimeCancelRequestSchema,
  RuntimeExecutionHandleSchema,
  RuntimeExecutionProgressSchema,
  RuntimeExecutionResultSchema,
  RuntimeExecutionStatusSchema,
  RuntimeInputRequestSchema,
  RuntimeSessionOperationSchema,
  RuntimeSessionResultSchema,
  RuntimeStartRequestSchema,
  TransportedRuntimeAdapter,
  inspectRuntimeCapabilities,
  type RuntimeAdapter,
  type RuntimeAdapterInspection,
  type RuntimeExecutionHandle,
  type RuntimeExecutionProgress,
  type RuntimeExecutionStatus,
  type RuntimeProgressOptions,
  type RuntimeSessionOperation,
  type RuntimeSessionResult,
  type RuntimeTransport,
} from '@control-plane/runtime-sdk'
import { z } from 'zod'

const SemanticVersionSchema = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const TimestampSchema = z.iso.datetime()
const ReferenceSchema = z.string().min(1).max(512)

const ProfilePinSchema = z
  .object({
    profileId: ReferenceSchema,
    profileVersionId: ReferenceSchema,
    version: z.number().int().positive(),
    revision: z.number().int().positive(),
    schemaVersion: z.number().int().positive(),
    contentDigest: DigestSchema,
  })
  .strict()

const SkillPinSchema = z
  .object({
    skillId: ReferenceSchema,
    skillVersionId: ReferenceSchema,
    revision: z.number().int().positive(),
    schemaVersion: z.number().int().positive(),
    semanticVersion: SemanticVersionSchema,
    contentDigest: DigestSchema,
  })
  .strict()

const ContextPackagePinSchema = z
  .object({
    contextPackageId: ReferenceSchema,
    contentDigest: DigestSchema,
    schemaVersion: z.number().int().positive(),
    compilerVersion: SemanticVersionSchema,
  })
  .strict()

const OutputContractSchema = z.object({ contractRef: z.string().min(1).max(512) }).strict()

const ManagedPiExecutionPlanSchema = z.object({
  schemaVersion: z.number().int().positive(),
  executionPlanId: ReferenceSchema,
  contentDigest: DigestSchema,
  profile: ProfilePinSchema,
  skills: z.array(SkillPinSchema).max(128),
  contextPackage: ContextPackagePinSchema,
  runtimeRequirements: CapabilityRequirementSetSchema,
  constraints: ExecutionConstraintSetSchema,
  policySnapshot: ExecutionConstraintSetSchema.shape.policySnapshot,
  outputContract: OutputContractSchema,
})

export const ManagedPiConfigurationSchema = z
  .object({
    schemaVersion: z.literal(1),
    adapterVersion: SemanticVersionSchema,
    executionPlanId: ReferenceSchema,
    executionPlanDigest: DigestSchema,
    profile: ProfilePinSchema,
    skills: z.array(SkillPinSchema).max(128),
    contextPackage: ContextPackagePinSchema,
    runtimeRequirements: CapabilityRequirementSetSchema,
    contextPolicy: ExecutionConstraintSetSchema.shape.context,
    runtimePolicy: ExecutionConstraintSetSchema.shape.runtime,
    modelPolicy: ExecutionConstraintSetSchema.shape.models,
    toolPolicy: ExecutionConstraintSetSchema.shape.tools,
    interactionPolicy: ExecutionConstraintSetSchema.shape.interaction,
    limits: ExecutionConstraintSetSchema.shape.limits,
    policySnapshot: ExecutionConstraintSetSchema.shape.policySnapshot,
    outputContract: OutputContractSchema,
  })
  .strict()

export type ManagedPiConfiguration = z.output<typeof ManagedPiConfigurationSchema>

export function translateExecutionPlanToManagedPi(
  executionPlanInput: unknown,
  adapterVersionInput: string
): ManagedPiConfiguration {
  const executionPlan = ManagedPiExecutionPlanSchema.parse(executionPlanInput)
  const adapterVersion = SemanticVersionSchema.parse(adapterVersionInput)
  const constraints = canonicalConstraints(executionPlan.constraints)
  return ManagedPiConfigurationSchema.parse({
    schemaVersion: 1,
    adapterVersion,
    executionPlanId: executionPlan.executionPlanId,
    executionPlanDigest: executionPlan.contentDigest,
    profile: executionPlan.profile,
    skills: [...executionPlan.skills].toSorted((left, right) =>
      left.skillVersionId.localeCompare(right.skillVersionId)
    ),
    contextPackage: executionPlan.contextPackage,
    runtimeRequirements: [...executionPlan.runtimeRequirements].toSorted((left, right) =>
      left.capability.localeCompare(right.capability)
    ),
    contextPolicy: constraints.context,
    runtimePolicy: constraints.runtime,
    modelPolicy: constraints.models,
    toolPolicy: constraints.tools,
    interactionPolicy: constraints.interaction,
    limits: constraints.limits,
    policySnapshot: executionPlan.policySnapshot,
    outputContract: executionPlan.outputContract,
  })
}

export const ManagedPiInspectionSchema = z
  .object({
    driverVersion: SemanticVersionSchema,
    runtimeVersion: SemanticVersionSchema,
    protocolVersion: SemanticVersionSchema,
    health: z.enum(['healthy', 'degraded', 'unavailable']),
    capabilities: RuntimeAdapterInspectionSchema.shape.capabilities,
    limitations: RuntimeAdapterInspectionSchema.shape.limitations,
    observedAt: TimestampSchema,
  })
  .strict()

export const ManagedPiEventSchema = z.discriminatedUnion('kind', [
  z
    .object({
      sequence: z.number().int().positive(),
      occurredAt: TimestampSchema,
      kind: z.literal('status'),
      state: z.enum([
        'queued',
        'running',
        'waiting_input',
        'stopping',
        'succeeded',
        'errored',
        'cancelled',
        'timed_out',
        'unknown',
      ]),
    })
    .strict(),
  z
    .object({
      sequence: z.number().int().positive(),
      occurredAt: TimestampSchema,
      kind: z.literal('output'),
      text: z.string().max(1_000_000),
    })
    .strict(),
  z
    .object({
      sequence: z.number().int().positive(),
      occurredAt: TimestampSchema,
      kind: z.literal('tool_request'),
      interactionId: ReferenceSchema,
      toolId: z.string().min(1).max(128),
      operation: z.string().min(1).max(128),
    })
    .strict(),
  z
    .object({
      sequence: z.number().int().positive(),
      occurredAt: TimestampSchema,
      kind: z.literal('interaction'),
      interactionId: ReferenceSchema,
      interactionKind: z.enum(['input', 'approval']),
      prompt: z.string().min(1).max(4096),
    })
    .strict(),
  z
    .object({
      sequence: z.number().int().positive(),
      occurredAt: TimestampSchema,
      kind: z.literal('usage'),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      durationMs: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      sequence: z.number().int().positive(),
      occurredAt: TimestampSchema,
      kind: z.literal('artifact'),
      artifact: RuntimeExecutionResultSchema.shape.artifacts.element,
    })
    .strict(),
  z
    .object({
      sequence: z.number().int().positive(),
      occurredAt: TimestampSchema,
      kind: z.literal('error'),
      error: RuntimeExecutionStatusSchema.shape.error.unwrap(),
    })
    .strict(),
])

export const ManagedPiStatusSchema = z
  .object({
    state: z.enum([
      'queued',
      'running',
      'waiting_input',
      'stopping',
      'succeeded',
      'errored',
      'cancelled',
      'timed_out',
      'unknown',
    ]),
    observedAt: TimestampSchema,
    result: RuntimeExecutionResultSchema.omit({ outcome: true }).optional(),
    error: RuntimeExecutionStatusSchema.shape.error.optional(),
  })
  .strict()
  .superRefine((status, context) => {
    if ((status.state === 'succeeded') !== (status.result !== undefined)) {
      context.addIssue({ code: 'custom', message: 'Succeeded Pi status requires one result' })
    }
    const failed = status.state === 'errored' || status.state === 'timed_out'
    if (failed !== (status.error !== undefined)) {
      context.addIssue({ code: 'custom', message: 'Failed Pi status requires one error' })
    }
  })

export interface ManagedPiStartCommand {
  readonly attemptId: string
  readonly idempotencyKey: string
  readonly configuration: ManagedPiConfiguration
}

export type ManagedPiInspection = z.output<typeof ManagedPiInspectionSchema>
export type ManagedPiEvent = z.output<typeof ManagedPiEventSchema>
export type ManagedPiStatus = z.output<typeof ManagedPiStatusSchema>

export interface ManagedPiClient {
  inspect(): Promise<z.input<typeof ManagedPiInspectionSchema>>
  start(command: ManagedPiStartCommand): Promise<RuntimeExecutionHandle>
  progress(
    handle: RuntimeExecutionHandle,
    afterSequence?: number,
    signal?: AbortSignal
  ): AsyncIterable<z.input<typeof ManagedPiEventSchema>>
  submitInput(
    handle: RuntimeExecutionHandle,
    request: z.input<typeof RuntimeInputRequestSchema>
  ): Promise<z.input<typeof ManagedPiStatusSchema>>
  submitApproval(
    handle: RuntimeExecutionHandle,
    request: z.input<typeof RuntimeApprovalRequestSchema>
  ): Promise<z.input<typeof ManagedPiStatusSchema>>
  cancel(
    handle: RuntimeExecutionHandle,
    request: z.input<typeof RuntimeCancelRequestSchema>
  ): Promise<z.input<typeof ManagedPiStatusSchema>>
  status(handle: RuntimeExecutionHandle): Promise<z.input<typeof ManagedPiStatusSchema>>
  reconcile(handle: RuntimeExecutionHandle): Promise<z.input<typeof ManagedPiStatusSchema>>
  session(operation: RuntimeSessionOperation): Promise<RuntimeSessionResult>
  cleanup(handle: RuntimeExecutionHandle): Promise<void>
}

export interface ManagedPiDriverOptions {
  readonly client: ManagedPiClient
  readonly adapterVersion: string
  readonly minimumRuntimeVersion?: string
  readonly maximumRuntimeVersionExclusive?: string
}

interface CachedStart {
  readonly fingerprint: string
  readonly handle: RuntimeExecutionHandle
}

interface CachedAction {
  readonly fingerprint: string
  readonly status: RuntimeExecutionStatus
}

export class ManagedPiDriver implements RuntimeAdapter {
  readonly #client: ManagedPiClient
  readonly #adapterVersion: string
  readonly #minimumRuntimeVersion: string
  readonly #maximumRuntimeVersionExclusive: string
  readonly #starts = new Map<string, CachedStart>()
  readonly #actions = new Map<string, CachedAction>()
  readonly #cleaned = new Set<string>()

  constructor(options: ManagedPiDriverOptions) {
    this.#client = options.client
    this.#adapterVersion = SemanticVersionSchema.parse(options.adapterVersion)
    this.#minimumRuntimeVersion = SemanticVersionSchema.parse(
      options.minimumRuntimeVersion ?? '0.52.0'
    )
    this.#maximumRuntimeVersionExclusive = SemanticVersionSchema.parse(
      options.maximumRuntimeVersionExclusive ?? '0.53.0'
    )
    if (compareVersions(this.#minimumRuntimeVersion, this.#maximumRuntimeVersionExclusive) >= 0) {
      throw new Error('INVALID_MANAGED_PI_VERSION_RANGE')
    }
  }

  async inspect(
    requirements?: Parameters<RuntimeAdapter['inspect']>[0]
  ): Promise<RuntimeAdapterInspection> {
    const native = ManagedPiInspectionSchema.parse(await this.#client.inspect())
    const supported =
      compareVersions(native.runtimeVersion, this.#minimumRuntimeVersion) >= 0 &&
      compareVersions(native.runtimeVersion, this.#maximumRuntimeVersionExclusive) < 0
    const capabilities = supported ? native.capabilities : []
    const limitations = supported
      ? native.limitations
      : [...native.limitations, `UNSUPPORTED_PI_RUNTIME_VERSION:${native.runtimeVersion}`]
    return RuntimeAdapterInspectionSchema.parse({
      metadata: {
        contractVersion: { major: 1, minor: 0 },
        adapterName: 'managed-pi',
        adapterVersion: this.#adapterVersion,
        runtimeFamily: 'pi',
        driverVersion: native.driverVersion,
        harnessVersion: native.runtimeVersion,
      },
      health: supported ? native.health : 'unavailable',
      capabilities,
      limitations,
      observedAt: native.observedAt,
      ...(requirements
        ? { capabilityEvaluation: inspectRuntimeCapabilities(capabilities, requirements) }
        : {}),
    })
  }

  async start(
    requestInput: Parameters<RuntimeAdapter['start']>[0]
  ): Promise<RuntimeExecutionHandle> {
    const request = RuntimeStartRequestSchema.parse(requestInput)
    const fingerprint = stable(request)
    const replay = this.#starts.get(request.idempotencyKey)
    if (replay) {
      if (replay.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', 'conflict', false)
      return clone(replay.handle)
    }
    const inspection = await this.inspect(request.executionPlan.runtimeRequirements)
    if (inspection.health === 'unavailable' || !inspection.capabilityEvaluation?.eligible) {
      fail('MANAGED_PI_INELIGIBLE', 'unsupported', false, {
        health: inspection.health,
        missingRequired: inspection.capabilityEvaluation?.missingRequired.join(',') ?? '',
        insufficientRequired: inspection.capabilityEvaluation?.insufficientRequired.join(',') ?? '',
      })
    }
    const configuration = translateExecutionPlanToManagedPi(
      request.executionPlan,
      this.#adapterVersion
    )
    const handle = RuntimeExecutionHandleSchema.parse(
      await this.#client.start({
        attemptId: request.attemptId,
        idempotencyKey: request.idempotencyKey,
        configuration,
      })
    )
    if (handle.attemptId !== request.attemptId) {
      fail('MANAGED_PI_ATTEMPT_MISMATCH', 'runtime', false)
    }
    this.#starts.set(request.idempotencyKey, { fingerprint, handle: clone(handle) })
    return clone(handle)
  }

  async *progress(
    handleInput: RuntimeExecutionHandle,
    options: RuntimeProgressOptions = {}
  ): AsyncIterable<RuntimeExecutionProgress> {
    const handle = RuntimeExecutionHandleSchema.parse(handleInput)
    const events = this.#client.progress(handle, options.afterSequence, options.signal)
    let previousSequence = options.afterSequence ?? 0
    for await (const eventInput of events) {
      const event = ManagedPiEventSchema.parse(eventInput)
      if (event.sequence <= previousSequence) {
        fail('MANAGED_PI_EVENT_ORDER_INVALID', 'runtime', false)
      }
      previousSequence = event.sequence
      yield normalizeEvent(handle, event)
    }
  }

  async submitInput(
    handleInput: RuntimeExecutionHandle,
    requestInput: Parameters<RuntimeAdapter['submitInput']>[1]
  ): Promise<RuntimeExecutionStatus> {
    const handle = RuntimeExecutionHandleSchema.parse(handleInput)
    const request = RuntimeInputRequestSchema.parse(requestInput)
    return this.#idempotentAction(handle, 'input', request.idempotencyKey, request, () =>
      this.#client.submitInput(handle, request)
    )
  }

  async submitApproval(
    handleInput: RuntimeExecutionHandle,
    requestInput: Parameters<RuntimeAdapter['submitApproval']>[1]
  ): Promise<RuntimeExecutionStatus> {
    const handle = RuntimeExecutionHandleSchema.parse(handleInput)
    const request = RuntimeApprovalRequestSchema.parse(requestInput)
    return this.#idempotentAction(handle, 'approval', request.idempotencyKey, request, () =>
      this.#client.submitApproval(handle, request)
    )
  }

  async cancel(
    handleInput: RuntimeExecutionHandle,
    requestInput: Parameters<RuntimeAdapter['cancel']>[1]
  ): Promise<RuntimeExecutionStatus> {
    const handle = RuntimeExecutionHandleSchema.parse(handleInput)
    const request = RuntimeCancelRequestSchema.parse(requestInput)
    return this.#idempotentAction(handle, 'cancel', request.idempotencyKey, request, () =>
      this.#client.cancel(handle, request)
    )
  }

  async status(handleInput: RuntimeExecutionHandle): Promise<RuntimeExecutionStatus> {
    const handle = RuntimeExecutionHandleSchema.parse(handleInput)
    return normalizeStatus(handle, await this.#client.status(handle))
  }

  async reconcile(handleInput: RuntimeExecutionHandle): Promise<RuntimeExecutionStatus> {
    const handle = RuntimeExecutionHandleSchema.parse(handleInput)
    return normalizeStatus(handle, await this.#client.reconcile(handle))
  }

  async session(operationInput: RuntimeSessionOperation): Promise<RuntimeSessionResult> {
    const operation = RuntimeSessionOperationSchema.parse(operationInput)
    return RuntimeSessionResultSchema.parse(await this.#client.session(operation))
  }

  async cleanup(handleInput: RuntimeExecutionHandle): Promise<void> {
    const handle = RuntimeExecutionHandleSchema.parse(handleInput)
    if (this.#cleaned.has(handle.handleId)) return
    await this.#client.cleanup(handle)
    this.#cleaned.add(handle.handleId)
  }

  async #idempotentAction(
    handle: RuntimeExecutionHandle,
    operation: string,
    idempotencyKey: string,
    request: unknown,
    action: () => Promise<z.input<typeof ManagedPiStatusSchema>>
  ): Promise<RuntimeExecutionStatus> {
    const key = `${handle.handleId}:${operation}:${idempotencyKey}`
    const fingerprint = stable(request)
    const replay = this.#actions.get(key)
    if (replay) {
      if (replay.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', 'conflict', false)
      return clone(replay.status)
    }
    const status = normalizeStatus(handle, await action())
    this.#actions.set(key, { fingerprint, status: clone(status) })
    return status
  }
}

export interface ManagedPiAdapterOptions {
  readonly transport: RuntimeTransport
}

export class ManagedPiAdapter extends TransportedRuntimeAdapter {
  constructor(options: ManagedPiAdapterOptions) {
    super(options.transport, 'managed-pi')
  }
}

function canonicalConstraints(
  constraintsInput: z.input<typeof ExecutionConstraintSetSchema>
): z.output<typeof ExecutionConstraintSetSchema> {
  const constraints = ExecutionConstraintSetSchema.parse(constraintsInput)
  return ExecutionConstraintSetSchema.parse({
    ...constraints,
    context: {
      ...constraints.context,
      allowedClassifications: [...constraints.context.allowedClassifications].toSorted(),
    },
    tools: {
      ...constraints.tools,
      grants: constraints.tools.grants
        .map((grant) => ({
          ...grant,
          operations: [...grant.operations].toSorted(),
          requiredCapabilities: [...grant.requiredCapabilities].toSorted(),
        }))
        .toSorted((left, right) =>
          `${left.tool.toolId}:${left.tool.versionRange}`.localeCompare(
            `${right.tool.toolId}:${right.tool.versionRange}`
          )
        ),
    },
    models: constraints.models
      .map((model) => ({
        ...model,
        requiredCapabilities: [...model.requiredCapabilities].toSorted(),
        providerPolicy: {
          ...model.providerPolicy,
          allowedClasses: [...model.providerPolicy.allowedClasses].toSorted(),
          deniedProviders: [...model.providerPolicy.deniedProviders].toSorted(),
          dataResidency: [...model.providerPolicy.dataResidency].toSorted(),
        },
      }))
      .toSorted((left, right) => left.alias.localeCompare(right.alias)),
    runtime: {
      ...constraints.runtime,
      allowedFamilies: [...constraints.runtime.allowedFamilies].toSorted(),
      allowedLocations: [...constraints.runtime.allowedLocations].toSorted(),
      requiredCapabilities: [...constraints.runtime.requiredCapabilities].toSorted(),
    },
  })
}

function normalizeEvent(
  handle: RuntimeExecutionHandle,
  event: z.output<typeof ManagedPiEventSchema>
): RuntimeExecutionProgress {
  const base = {
    handleId: handle.handleId,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
  }
  switch (event.kind) {
    case 'status':
      return RuntimeExecutionProgressSchema.parse({
        ...base,
        type: 'status',
        data: { state: normalizeState(event.state) },
      })
    case 'output':
      return RuntimeExecutionProgressSchema.parse({
        ...base,
        type: 'output',
        data: { text: event.text },
      })
    case 'tool_request':
      return RuntimeExecutionProgressSchema.parse({
        ...base,
        type: 'interaction',
        data: {
          interactionId: event.interactionId,
          kind: 'tool',
          toolId: event.toolId,
          operation: event.operation,
        },
      })
    case 'interaction':
      return RuntimeExecutionProgressSchema.parse({
        ...base,
        type: 'interaction',
        data: {
          interactionId: event.interactionId,
          kind: event.interactionKind,
          prompt: event.prompt,
        },
      })
    case 'usage':
      return RuntimeExecutionProgressSchema.parse({
        ...base,
        type: 'usage',
        data: {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          durationMs: event.durationMs,
        },
      })
    case 'artifact':
      return RuntimeExecutionProgressSchema.parse({
        ...base,
        type: 'artifact',
        data: { artifact: event.artifact },
      })
    case 'error':
      return RuntimeExecutionProgressSchema.parse({
        ...base,
        type: 'status',
        data: { state: 'failed', error: event.error },
      })
  }
}

function normalizeStatus(
  handle: RuntimeExecutionHandle,
  statusInput: z.input<typeof ManagedPiStatusSchema>
): RuntimeExecutionStatus {
  const status = ManagedPiStatusSchema.parse(statusInput)
  return RuntimeExecutionStatusSchema.parse({
    handle,
    state: normalizeState(status.state),
    observedAt: status.observedAt,
    ...(status.result
      ? { result: RuntimeExecutionResultSchema.parse({ outcome: 'completed', ...status.result }) }
      : {}),
    ...(status.error ? { error: status.error } : {}),
  })
}

function normalizeState(
  state: z.output<typeof ManagedPiStatusSchema>['state']
): RuntimeExecutionStatus['state'] {
  switch (state) {
    case 'queued':
      return 'starting'
    case 'running':
      return 'running'
    case 'waiting_input':
      return 'awaiting_input'
    case 'stopping':
      return 'cancelling'
    case 'succeeded':
      return 'completed'
    case 'errored':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    case 'timed_out':
      return 'timed_out'
    case 'unknown':
      return 'unknown'
  }
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number)
  const rightParts = right.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

function fail(
  code: string,
  classification: ConstructorParameters<typeof RuntimeAdapterError>[0]['classification'],
  retryable: boolean,
  details?: Record<string, string>
): never {
  throw new RuntimeAdapterError({
    code,
    classification,
    message: code,
    retryable,
    ...(details ? { details } : {}),
  })
}

function stable(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function clone<Value>(value: Value): Value {
  return structuredClone(value)
}

export * from './gateway.js'
export * from './process-client.js'
