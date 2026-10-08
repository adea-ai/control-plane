import { z } from 'zod'
import type { Models } from '@earendil-works/pi-ai/models'
import type { CurrentExecutionScopeAuthority } from '@control-plane/execution-plan'
import { IdentifierSchemas } from '@control-plane/contracts'
import type { DurableToolCallRequest } from '@control-plane/tool-sdk'
import type { PiDurableEffectGate } from './effect-gate.js'
import type { PiDurableToolSource, PiDurableToolSourceReader } from './tool-source.js'
import type {
  RuntimeStartRequest,
  RuntimeExecutionHandle,
  RuntimeUsage,
  RuntimeApprovalRequest,
} from '@control-plane/runtime-sdk'

export const PiDurableVersion = Object.freeze({ runtime: '1.1.0', journal: 1, adapter: '0.1.0' })

export const ProviderSelectionReferenceSchema = z
  .object({
    selectionRef: z.string().regex(/^msel_[a-f0-9]{32}$/),
    selectionRevision: z.number().int().positive(),
  })
  .strict()

export const PiDurableAdmissionSchema = z
  .object({
    schemaVersion: z.literal('pi-durable-admission/v1'),
    prompt: z.string().min(1).max(1_000_000),
    /** Trusted canonical product actor; never inferred from the executing service. */
    canonicalActorPrincipalId: z.string().min(1).max(256).optional(),
    selection: ProviderSelectionReferenceSchema,
    authority: z
      .object({
        revision: z.number().int().positive(),
        principalRef: z.string().min(1).max(256),
        scopeRef: z.string().min(1).max(256),
        expiresAt: z.iso.datetime(),
      })
      .strict(),
  })
  .strict()

/** Projection of a trusted gateway selection, never a credential or lease. */
export const ProviderBindingSchema = z
  .object({
    selectionRef: ProviderSelectionReferenceSchema.shape.selectionRef,
    selectionRevision: ProviderSelectionReferenceSchema.shape.selectionRevision,
    workspaceId: z.string().min(1),
    provider: z.string().regex(/^[a-z][a-z0-9_-]*$/),
    providerModel: z.string().min(1).max(256),
    location: z.literal('remote_host'),
    harness: z.literal('pi_durable'),
    harnessVersion: z.literal('1.1.0'),
    providerBinding: z.literal('pi_durable_models'),
  })
  .strict()

export type PiDurableAdmission = z.output<typeof PiDurableAdmissionSchema>
export type ProviderSelectionReference = z.output<typeof ProviderSelectionReferenceSchema>
export type ProviderBinding = z.output<typeof ProviderBindingSchema>

export interface PiDurableProviderAccess extends ProviderBinding {
  /** Revalidate the gateway and hold its opaque credential lease for this callback. */
  withModels<T>(use: (models: Models) => Promise<T>): Promise<T>
}

export interface DurableExecutionAuthority {
  readonly request: RuntimeStartRequest
  readonly admission: PiDurableAdmission
}

/** Actual committed running boundary; supplied only by the journal owner. */
export interface PiDurableRunningAuthority extends DurableExecutionAuthority {
  readonly handle: RuntimeExecutionHandle
  readonly observedAt: string
}

export interface PiEngineResult {
  readonly text: string
  readonly submissionId: string
  readonly usage: { inputTokens: number; outputTokens: number; costUsd: string; durationMs: number }
  /** Each receipt is persisted atomically in the native AssistantEntry, attributed to its generation task. */
  readonly inferences: readonly {
    readonly inferenceId: string
    readonly usage: {
      inputTokens: number
      outputTokens: number
      durationMs: number
      cachedInputTokens: number
      reasoningTokens: number
    }
  }[]
}

export interface DurablePiEngine {
  run(input: { sessionId: string; requestId: string; input: string }): Promise<PiEngineResult>
  cancel(sessionId: string): Promise<void>
  close(): Promise<void>
}

export const PiDurableDelegateChildOutcomeSchema = z.strictObject({
  schemaVersion: z.literal('pi-delegate-child-outcome/v1'),
  state: z.enum(['succeeded', 'awaiting_approval', 'reconciliation_required', 'denied']),
  toolCallId: IdentifierSchemas.toolCallId,
  interactionId: IdentifierSchemas.interactionId.optional(),
  reasonCode: z
    .enum(['PI_CHILD_APPROVAL_PENDING', 'PI_CHILD_OUTCOME_UNKNOWN', 'PI_CHILD_DELEGATION_DENIED'])
    .optional(),
  delegationId: IdentifierSchemas.delegationId.optional(),
  childExecutionId: IdentifierSchemas.executionId.optional(),
  childAttemptId: IdentifierSchemas.attemptId.optional(),
  externalSessionId: IdentifierSchemas.externalSessionId.optional(),
})
export type PiDurableDelegateChildOutcome = z.output<typeof PiDurableDelegateChildOutcomeSchema>
export interface PiDurableVerifiedToolSource {
  readonly source: PiDurableToolSource
  readonly sourceKey: string
  readonly objective: string
}
export interface PiDurableGovernedDelegateChildEnginePort {
  readonly source: Pick<
    PiDurableToolSource,
    | 'workspaceId'
    | 'parentExecutionId'
    | 'parentAttemptId'
    | 'runtimeHandleId'
    | 'externalSessionId'
    | 'admittedTurnKey'
  >
  readonly assertCurrent: (source: PiDurableToolSource) => Promise<void>
  readonly execute: (
    input: PiDurableVerifiedToolSource,
    reader: Pick<PiDurableToolSourceReader, 'readTask' | 'readAssistantEntry'>,
    signal?: AbortSignal
  ) => Promise<PiDurableDelegateChildOutcome>
}
/** Host compiler retains the full originating request by verified native source identity. */
export interface PiDurableGovernedDelegateChildCompiler {
  readonly prepare: (
    authority: DurableExecutionAuthority,
    input: PiDurableVerifiedToolSource
  ) => Promise<DurableToolCallRequest>
}

export interface PiDurableRuntimeOptions {
  readonly directory: string
  readonly now?: () => string
  readonly resolveAdmission: (request: RuntimeStartRequest) => Promise<PiDurableAdmission>
  readonly assertAuthority: (authority: DurableExecutionAuthority) => Promise<void>
  /** Synchronize canonical host lifecycle before constructing or resuming native tasks. */
  readonly onExecutionRunning?: (authority: PiDurableRunningAuthority) => Promise<void>
  /** Server-owned current scope read; required for every explicit plan2 scope. */
  readonly scopeAuthority?: CurrentExecutionScopeAuthority
  readonly resolveProvider: (
    reference: ProviderSelectionReference,
    authority: DurableExecutionAuthority
  ) => Promise<PiDurableProviderAccess>
  /** Requires recorded spending authority and a trusted ledger hold; rechecked at the provider send boundary. */
  readonly authorizeInference: (
    authority: DurableExecutionAuthority,
    key: string
  ) => Promise<{
    maxOutputTokens: number
    maximumInputTokens: number
    assertActive: () => Promise<void>
  }>
  readonly settleUsage: (
    authority: DurableExecutionAuthority,
    key: string,
    usage: RuntimeUsage,
    counts?: { readonly cachedInputTokens?: number; readonly reasoningTokens?: number }
  ) => Promise<RuntimeUsage>
  readonly reconcileInference: (
    authority: DurableExecutionAuthority,
    key: string
  ) => Promise<'safe_to_resume' | 'unresolved'>
  /** Reads an already authorized domain decision; never creates approval from this request. */
  readonly verifyApproval?: (
    authority: DurableExecutionAuthority,
    effectIdentity: string,
    request: RuntimeApprovalRequest
  ) => Promise<boolean>
  readonly governedDelegateChild?: PiDurableGovernedDelegateChildCompiler & {
    readonly gate: () => PiDurableEffectGate
  }
  readonly engineFactory?: (options: {
    directory: string
    model: { provider: string; modelId: string }
    maxOutputTokens: number
    assertAuthority: () => Promise<void>
    authorizeInference: (request: {
      sessionId: string
      inferenceId: string
      provider: string
      modelId: string
    }) => Promise<{
      maxOutputTokens: number
      maximumInputTokens: number
      assertActive: () => Promise<void>
    }>
    withModels: <T>(use: (models: Models) => Promise<T>) => Promise<T>
    readonly governedDelegateChild?: PiDurableGovernedDelegateChildEnginePort
  }) => Promise<DurablePiEngine>
}
