import {
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common'
import { isDeepStrictEqual } from 'node:util'
import type { ContextPackageRepository } from '@control-plane/context'
import {
  ExecutionRequestValidationRequestSchema,
  ExecutionRequestValidationResponseSchema,
  type ExecutionRequestValidationResponse,
  type ExecutionRequestValidationRequest,
} from '@control-plane/contracts'
import {
  ProjectStateSchema,
  type AgentProfileRepository,
  type ProjectStateRepository,
  type SkillRepository,
} from '@control-plane/domain'
import {
  ExecutionPlanCompiler,
  ExecutionPlanError,
  ExecutionValidationCommandRecordSchema,
  executionValidationPayloadHash,
  type ExecutionValidationCommandRepository,
  type ExecutionValidationCommandScope,
} from '@control-plane/execution-plan'

export const EXECUTION_VALIDATION_SERVICE = Symbol('EXECUTION_VALIDATION_SERVICE')

export interface ExecutionValidationService {
  validate(
    envelope: unknown,
    callerPrincipalId: string
  ): Promise<ExecutionRequestValidationResponse>
}

export interface DurableExecutionValidationServiceOptions {
  readonly compilerVersion: string
  readonly contextPackages: ContextPackageRepository
  readonly commands: ExecutionValidationCommandRepository
  readonly now?: () => string
  readonly profiles: Pick<AgentProfileRepository, 'getAgentProfileVersion'>
  readonly projectStates: Pick<ProjectStateRepository, 'getAtRevision'>
  readonly skills: Pick<SkillRepository, 'getSkillVersion'>
}

export class DurableExecutionValidationService implements ExecutionValidationService {
  readonly #compiler: ExecutionPlanCompiler

  constructor(readonly options: DurableExecutionValidationServiceOptions) {
    this.#compiler = new ExecutionPlanCompiler(options.compilerVersion)
  }

  async validate(
    input: unknown,
    callerPrincipalId: string
  ): Promise<ExecutionRequestValidationResponse> {
    const request = ExecutionRequestValidationRequestSchema.parse(input)
    if (callerPrincipalId !== request.caller.servicePrincipalId) {
      throw new ForbiddenException({
        code: 'EXECUTION_VALIDATION_CALLER_MISMATCH',
        message: 'Execution validation requires the authenticated caller',
      })
    }
    const projectId = request.projectId
    if (projectId === undefined) reject()
    const scope: ExecutionValidationCommandScope = {
      callerPrincipalId,
      workspaceId: request.workspaceId,
      projectId,
      operation: request.operation,
      idempotencyKey: request.idempotencyKey,
    }
    const payloadHash = executionValidationPayloadHash(request)
    const existing = await this.options.commands.get(scope)
    if (existing) return replayResponse(request, scope, payloadHash, existing)

    const [profile, projectState, contextPackage, ...skills] = await Promise.all([
      this.options.profiles.getAgentProfileVersion(request.payload.profileVersionId),
      this.options.projectStates.getAtRevision(
        request.workspaceId,
        projectId,
        request.payload.projectState.revision
      ),
      this.options.contextPackages.get({
        contextPackageId: request.payload.contextPackage.contextPackageId,
        contentDigest: request.payload.contextPackage.contentDigest,
      }),
      ...request.payload.skillVersionIds.map((skillVersionId) =>
        this.options.skills.getSkillVersion(skillVersionId)
      ),
    ])
    if (!profile || !projectState || !contextPackage || skills.some((skill) => !skill)) reject()

    const state = ProjectStateSchema.parse(projectState)
    if (
      state.workspaceId !== request.workspaceId ||
      state.projectId !== projectId ||
      contextPackage.projectState.workspaceId !== request.workspaceId ||
      contextPackage.projectState.projectId !== projectId ||
      contextPackage.projectState.revision !== state.revision ||
      contextPackage.schemaVersion !== request.payload.contextPackage.schemaVersion ||
      contextPackage.compiler.version !== request.payload.contextPackage.compilerVersion
    ) {
      reject()
    }
    const policy = profile.definition.executionConstraints.policySnapshot
    if (
      policy.policyId !== request.payload.policySnapshot.policySnapshotId ||
      policy.version !== request.payload.policySnapshot.revision ||
      policy.digest !== request.payload.policySnapshot.contentDigest
    ) {
      reject()
    }

    try {
      const compiledAt = (this.options.now ?? (() => new Date().toISOString()))()
      const plan = this.#compiler.compile({
        correlation: {
          workspaceId: request.workspaceId,
          projectId,
          taskId: request.payload.taskId,
          agentId: request.payload.agentId,
          requestId: request.requestId,
        },
        profile,
        skills,
        contextPackage,
        constraints: profile.definition.executionConstraints,
        requestConstraints: [],
        runtimeRequirements: request.payload.runtimeRequirements.map((capability) => ({
          capability,
          necessity: 'required' as const,
          minimumSupport: 'supported' as const,
        })),
        outputContract: { contractRef: request.payload.outputContractRef },
        compiledAt,
      })
      const record = await this.options.commands.commit(
        {
          scope,
          commandId: request.commandId,
          requestId: request.requestId,
          payloadHash,
          executionPlan: {
            executionPlanId: plan.executionPlanId,
            contentDigest: plan.contentDigest,
          },
          recordedAt: compiledAt,
        },
        plan
      )
      return replayResponse(request, scope, payloadHash, record)
    } catch (error) {
      if (error instanceof ExecutionPlanError) reject()
      if (error instanceof Error && error.message === 'EXECUTION_VALIDATION_COMMAND_CONFLICT')
        conflict()
      throw error
    }
  }
}

function replayResponse(
  request: ExecutionRequestValidationRequest,
  scope: ExecutionValidationCommandScope,
  payloadHash: string,
  input: unknown
): ExecutionRequestValidationResponse {
  const record = ExecutionValidationCommandRecordSchema.parse(input)
  if (!isDeepStrictEqual(record.scope, scope))
    throw new Error('EXECUTION_VALIDATION_COMMAND_SCOPE_MISMATCH')
  if (record.payloadHash !== payloadHash) conflict()
  return ExecutionRequestValidationResponseSchema.parse({
    contractVersion: request.contractVersion,
    requestId: request.requestId,
    correlation: request.correlation,
    data: { valid: true, executionPlan: record.executionPlan },
  })
}

function conflict(): never {
  throw new ConflictException({
    code: 'EXECUTION_VALIDATION_COMMAND_CONFLICT',
    message: 'Idempotency key was already used with different validation inputs',
  })
}

@Injectable()
export class UnavailableExecutionValidationService implements ExecutionValidationService {
  async validate(): Promise<ExecutionRequestValidationResponse> {
    throw new ServiceUnavailableException({
      code: 'EXECUTION_VALIDATION_NOT_CONFIGURED',
      message: 'Execution validation is unavailable',
    })
  }
}

function reject(): never {
  throw new UnprocessableEntityException({
    code: 'EXECUTION_VALIDATION_REJECTED',
    message: 'Execution request validation failed',
  })
}
