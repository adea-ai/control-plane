import { createHash } from 'node:crypto'
import { canonicalJsonStringify, IdentifierSchemas } from '@control-plane/contracts'
import { ContextPackageSchema } from '@control-plane/context'
import { ExecutionPlanSchema, type ExecutionPlan } from '@control-plane/execution-plan'
import {
  DurableToolCallRequestSchema,
  ToolCallSchema,
  ToolExecutionRequestSchema,
  type ToolExecutionRequest,
} from '@control-plane/tool-sdk'
import { z } from 'zod'
import { DelegateInputSchema, DispatchInputSchema } from './delegation.js'
import { DelegateChildToolInputSchema } from './delegation-runtime.js'

// R1 verifies the persisted native task/assistant entry and journal tuple. This
// opaque reference deliberately excludes process epochs, credentials and prompts.
export const DelegationToolSourceKeySchema = z.string().regex(/^pi-tool:[a-f0-9]{64}$/)

const ChildPlanInputSchema = z.strictObject({
  correlation: ExecutionPlanSchema.shape.correlation,
  contextPackage: ContextPackageSchema,
  constraints: ExecutionPlanSchema.shape.constraints,
  runtimeRequirements: ExecutionPlanSchema.shape.runtimeRequirements,
  outputContract: ExecutionPlanSchema.shape.outputContract,
  compiledAt: z.iso.datetime(),
  graph: ExecutionPlanSchema.shape.graph,
})

/** Trusted compiler receipt retained before calling the policy service/effect gate.
 * Existence is identity evidence only; it supplies no current effect authority. */
export const DelegationToolAdmissionSchema = z
  .strictObject({
    schemaVersion: z.literal('delegation-tool-admission/v1'),
    sourceKey: DelegationToolSourceKeySchema,
    request: DurableToolCallRequestSchema,
    command: z.strictObject({ delegation: DelegateInputSchema, dispatch: DispatchInputSchema }),
  })
  .superRefine((value, context) => {
    const { request, command } = value
    const input = DelegateChildToolInputSchema.safeParse(request.input)
    const child = ChildPlanInputSchema.safeParse(command.delegation.childPlan)
    if (
      request.operation !== 'delegate-child' ||
      !input.success ||
      !child.success ||
      command.delegation.objective !== (input.success ? input.data.objective : undefined) ||
      command.delegation.parentExecutionId !== request.executionId ||
      command.delegation.parentAttemptId !== request.attemptId ||
      command.delegation.admittedToolCallId !== request.toolCallId ||
      command.delegation.parentPlan.correlation.workspaceId !== request.workspaceId ||
      command.delegation.parentPlan.profile.profileId !== request.profileId ||
      command.dispatch.delegationId !== command.delegation.delegationId
    )
      context.addIssue({ code: 'custom', message: 'Canonical delegation admission binding denied' })
  })

export type DelegationToolAdmission = z.output<typeof DelegationToolAdmissionSchema>

export interface DelegationToolAdmissionRepository {
  retain(admission: DelegationToolAdmission): Promise<{
    readonly admission: DelegationToolAdmission
    readonly replayed: boolean
  }>
  getByRequestId(requestId: string): Promise<DelegationToolAdmission | undefined>
}

export class InMemoryDelegationToolAdmissionRepository implements DelegationToolAdmissionRepository {
  readonly #records = new Map<string, DelegationToolAdmission>()
  readonly #sources = new Set<string>()
  readonly #calls = new Set<string>()
  readonly #workspaceId: string

  constructor(workspaceId: string) {
    this.#workspaceId = IdentifierSchemas.workspaceId.parse(workspaceId)
  }

  async retain(input: DelegationToolAdmission) {
    const admission = DelegationToolAdmissionSchema.parse(input)
    if (admission.request.workspaceId !== this.#workspaceId)
      throw new Error('DELEGATION_TOOL_ADMISSION_SCOPE_DENIED')
    const stored = this.#records.get(admission.request.requestId)
    if (stored) {
      if (canonicalJsonStringify(stored) !== canonicalJsonStringify(admission))
        throw new Error('DELEGATION_TOOL_ADMISSION_CONFLICT')
      return { admission: structuredClone(stored), replayed: true }
    }
    if (this.#sources.has(admission.sourceKey) || this.#calls.has(admission.request.toolCallId))
      throw new Error('DELEGATION_TOOL_ADMISSION_CONFLICT')
    this.#records.set(admission.request.requestId, structuredClone(admission))
    this.#sources.add(admission.sourceKey)
    this.#calls.add(admission.request.toolCallId)
    return { admission: structuredClone(admission), replayed: false }
  }

  async getByRequestId(requestId: string) {
    IdentifierSchemas.requestId.parse(requestId)
    const record = this.#records.get(requestId)
    return record && structuredClone(record)
  }
}

/** Canonical lookup for GovernedDelegateChildExecutor.resolveCommand. */
export class CanonicalDelegationCommandResolver {
  constructor(
    readonly options: {
      readonly admissions: Pick<DelegationToolAdmissionRepository, 'getByRequestId'>
      readonly calls: { get(toolCallId: string): Promise<unknown> }
      readonly assertAuthority: (admission: DelegationToolAdmission) => Promise<void>
    }
  ) {}

  async resolve(input: ToolExecutionRequest) {
    const request = ToolExecutionRequestSchema.parse(input)
    const stored = await this.options.admissions.getByRequestId(request.requestId)
    if (!stored) throw new Error('DELEGATION_TOOL_ADMISSION_MISSING')
    const admission = DelegationToolAdmissionSchema.parse(stored)
    const projection = ToolExecutionRequestSchema.strip().parse(admission.request)
    if (canonicalJsonStringify(request) !== canonicalJsonStringify(projection))
      throw new Error('DELEGATION_TOOL_ADMISSION_CONFLICT')
    const call = ToolCallSchema.parse(await this.options.calls.get(admission.request.toolCallId))
    if (
      call.status !== 'executing' ||
      call.executionId !== request.executionId ||
      call.attemptId !== request.attemptId ||
      call.workspaceId !== request.workspaceId ||
      call.profileId !== request.profileId ||
      call.principalRef !== request.audit.principalRef ||
      call.toolDefinitionId !== request.toolDefinitionId ||
      call.toolVersionId !== request.toolVersionId ||
      call.operation !== request.operation ||
      call.inputDigest !==
        `sha256:${createHash('sha256')
          .update(canonicalJsonStringify(request.input) ?? 'null')
          .digest('hex')}` ||
      call.policySnapshotRef !== admission.request.policySnapshotRef ||
      call.idempotencyKey !== admission.request.idempotencyKey
    )
      throw new Error('DELEGATION_TOOL_ADMISSION_DENIED')
    await this.options.assertAuthority(structuredClone(admission))
    return structuredClone(admission.command)
  }

  /** Host authority bridges reload full grants/approval/actor evidence separately. */
  async getAdmission(requestId: string): Promise<DelegationToolAdmission> {
    const admission = await this.options.admissions.getByRequestId(requestId)
    if (!admission) throw new Error('DELEGATION_TOOL_ADMISSION_MISSING')
    return DelegationToolAdmissionSchema.parse(admission)
  }
}

export function assertDelegationToolParentPlan(
  admission: DelegationToolAdmission,
  parent: ExecutionPlan
): void {
  if (
    canonicalJsonStringify(admission.command.delegation.parentPlan) !==
    canonicalJsonStringify(parent)
  )
    throw new Error('DELEGATION_TOOL_ADMISSION_CONFLICT')
}
