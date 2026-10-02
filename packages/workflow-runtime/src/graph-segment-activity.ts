import {
  GraphCancellationRequestSchema,
  GraphContinueRequestSchema,
  GraphExecutionRequestSchema,
  GraphResumeRequestSchema,
  type GraphReference,
  type GraphSegmentResult,
  type OrchestrationPort,
} from '@control-plane/orchestration'

export type GraphActivityOutcome =
  | {
      readonly outcome: 'completed'
      readonly resultReference?: string
      readonly checkpointId?: string
    }
  | {
      readonly outcome: 'failed'
      readonly failureCode: string
      readonly retryable: boolean
      readonly checkpointId?: string
    }
  | { readonly outcome: 'cancelled'; readonly checkpointId?: string }
  | { readonly outcome: 'reconciliation_required'; readonly checkpointId?: string }
  | {
      readonly outcome: 'awaiting_input'
      readonly interactionId: string
      readonly checkpointId: string
    }
  | { readonly outcome: 'continue'; readonly checkpointId: string }

export interface GraphSegmentActivityPort {
  runGraphSegment(input: RunGraphSegmentActivityInput): Promise<GraphActivityOutcome>
  resumeGraphSegment(input: ResumeGraphSegmentActivityInput): Promise<GraphActivityOutcome>
  continueGraphSegment(input: ContinueGraphSegmentActivityInput): Promise<GraphActivityOutcome>
  cancelGraphSegment(input: CancelGraphSegmentActivityInput): Promise<boolean>
}

export interface RunGraphSegmentActivityInput {
  readonly executionId: string
  readonly attemptId: string
  readonly workspaceId: string
  readonly workflowId: string
  readonly graph: GraphReference
  readonly threadId: string
  readonly input: Readonly<Record<string, unknown>>
  readonly idempotencyKey: string
}

export interface ResumeGraphSegmentActivityInput extends Omit<
  RunGraphSegmentActivityInput,
  'input'
> {
  readonly checkpointId: string
  readonly response: unknown
}

export interface ContinueGraphSegmentActivityInput extends Omit<
  RunGraphSegmentActivityInput,
  'input'
> {
  readonly checkpointId: string
}

export interface CancelGraphSegmentActivityInput {
  readonly executionId: string
  readonly attemptId: string
  readonly workspaceId: string
  readonly workflowId: string
  readonly graph: GraphReference
  readonly threadId: string
  readonly reason: 'user_request' | 'deadline'
  readonly idempotencyKey: string
}

export class OrchestrationGraphSegmentActivities implements GraphSegmentActivityPort {
  constructor(readonly orchestration: OrchestrationPort) {}

  async runGraphSegment(input: RunGraphSegmentActivityInput): Promise<GraphActivityOutcome> {
    return normalize(await this.orchestration.run(GraphExecutionRequestSchema.parse(input)))
  }

  async resumeGraphSegment(input: ResumeGraphSegmentActivityInput): Promise<GraphActivityOutcome> {
    return normalize(await this.orchestration.resume(GraphResumeRequestSchema.parse(input)))
  }

  async continueGraphSegment(
    input: ContinueGraphSegmentActivityInput
  ): Promise<GraphActivityOutcome> {
    return normalize(await this.orchestration.continue(GraphContinueRequestSchema.parse(input)))
  }

  async cancelGraphSegment(input: CancelGraphSegmentActivityInput): Promise<boolean> {
    return this.orchestration.cancel(
      GraphCancellationRequestSchema.parse({
        executionId: input.executionId,
        attemptId: input.attemptId,
        workspaceId: input.workspaceId,
        workflowId: input.workflowId,
        graph: input.graph,
        threadId: input.threadId,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      })
    )
  }
}

function normalize(result: GraphSegmentResult): GraphActivityOutcome {
  switch (result.status) {
    case 'completed': {
      const artifactRef = result.output['artifactRef']
      return {
        outcome: 'completed',
        ...(typeof artifactRef === 'string' ? { resultReference: artifactRef } : {}),
        ...(result.checkpointId ? { checkpointId: result.checkpointId } : {}),
      }
    }
    case 'failed':
      return {
        outcome: 'failed',
        failureCode: result.failure.code,
        retryable: result.failure.retryable,
        ...(result.checkpointId ? { checkpointId: result.checkpointId } : {}),
      }
    case 'cancelled':
    case 'reconciliation_required':
      return {
        outcome: result.status,
        ...(result.checkpointId ? { checkpointId: result.checkpointId } : {}),
      }
    case 'awaiting_input':
      return {
        outcome: 'awaiting_input',
        interactionId: result.interrupt.interactionKey,
        checkpointId: result.checkpointId,
      }
    case 'continue':
      return { outcome: 'continue', checkpointId: result.checkpointId }
  }
}
