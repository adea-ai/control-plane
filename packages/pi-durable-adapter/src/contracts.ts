import { z } from 'zod'
import type { Models } from '@earendil-works/pi-ai/models'
import type { AbortCommitReceipt } from '@earendil-works/pi-durable'
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

const CancellationDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)

export const PiDurableCancellationGenerationSchema = z
  .strictObject({
    schemaVersion: z.literal('pi-inference-generation/v1'),
    attemptId: IdentifierSchemas.attemptId,
    turnKey: z.string().min(1).max(4096),
    inferenceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/),
    inferenceKey: z.string().min(1).max(8192),
  })
  .superRefine((generation, context) => {
    if (generation.inferenceKey !== `${generation.turnKey}:${generation.inferenceId}`)
      context.addIssue({ code: 'custom', path: ['inferenceKey'], message: 'invalid inference key' })
  })

const CancellationTargetFields = {
  targetKind: z.enum(['active_generation', 'no_active_generation', 'untracked_generation']),
  /** Turn snapshot targeted by this request, including when no generation was observed. */
  turnKey: z.string().min(1).max(4096),
  generation: PiDurableCancellationGenerationSchema.nullable(),
}

/** Historical #1048 retained-request format, used only for effect-free history qualification.
 * These identifiers and persisted fields never grant current permission to cancel. */
export const PiDurableCancellationProposalSchema = z
  .strictObject({
    handleId: z.string().min(1).max(256),
    executionId: IdentifierSchemas.executionId,
    attemptId: IdentifierSchemas.attemptId,
    workspaceId: IdentifierSchemas.workspaceId,
    idempotencyKey: z.string().min(1).max(256),
    requestedAt: z.iso.datetime(),
    requestDigest: CancellationDigestSchema,
    admissionDigest: CancellationDigestSchema,
    ...CancellationTargetFields,
  })
  .superRefine((proposal, context) => {
    if ((proposal.targetKind === 'active_generation') !== (proposal.generation !== null))
      context.addIssue({ code: 'custom', path: ['generation'], message: 'invalid target binding' })
    if (
      proposal.generation &&
      (proposal.generation.attemptId !== proposal.attemptId ||
        proposal.generation.turnKey !== proposal.turnKey)
    )
      context.addIssue({ code: 'custom', path: ['generation'], message: 'mismatched target' })
  })

export const PiDurableCommittedCancellationIntentSchema = z
  .strictObject({
    schemaVersion: z.literal('pi-committed-cancellation/v1'),
    intentId: z.uuid(),
    committedAuthorityVersion: z.number().int().positive(),
    committedAt: z.iso.datetime(),
    ...PiDurableCancellationProposalSchema.shape,
  })
  .superRefine((intent, context) => {
    if ((intent.targetKind === 'active_generation') !== (intent.generation !== null))
      context.addIssue({ code: 'custom', path: ['generation'], message: 'invalid target binding' })
    if (
      intent.generation &&
      (intent.generation.attemptId !== intent.attemptId ||
        intent.generation.turnKey !== intent.turnKey)
    )
      context.addIssue({ code: 'custom', path: ['generation'], message: 'mismatched target' })
  })

export type PiDurableCancellationProposal = z.output<typeof PiDurableCancellationProposalSchema>
export type PiDurableCommittedCancellationIntent = z.output<
  typeof PiDurableCommittedCancellationIntentSchema
>

/** Historical source/test retention interface. Deliberately absent from runtime/composition
 * options: neither commit nor acknowledgement authorizes a native cancellation effect. Current
 * production coordinator contracts are separately defined in cancellation-owner.ts and unavailable.
 */
export interface PiDurableCommittedCancellationAuthority {
  readonly commit: (
    proposal: PiDurableCancellationProposal
  ) => Promise<PiDurableCommittedCancellationIntent>
  /** List handles with unacknowledged intents without parsing their payloads. */
  readonly pendingHandles: () => Promise<readonly string[]>
  /** Read one handle's payloads so a malformed entry cannot block other handles. */
  readonly pendingForHandle: (
    handleId: string
  ) => Promise<readonly PiDurableCommittedCancellationIntent[]>
  readonly acknowledge: (intentId: string) => Promise<void>
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

/** Opt-in native qualification only; production factories do not supply this capability. */
export interface PiGuardedCancellationInput {
  readonly sessionId: string
  readonly requestId: string
  readonly requestDigest: string
  readonly targetDigest: string
  readonly expiresAt: string
  readonly turnKey: string
  readonly inferenceId: string | null
}

/** Identity-bound by the engine; a structurally identical object is not a prepared operation. */
export interface PiGuardedCancellationPreparation extends PiGuardedCancellationInput {}

export interface PiGuardedCancellationEngine {
  prepare(input: PiGuardedCancellationInput): Promise<PiGuardedCancellationPreparation>
  commit(preparation: PiGuardedCancellationPreparation): Promise<AbortCommitReceipt>
}

export interface DurablePiEngine {
  readonly guardedCancellation?: PiGuardedCancellationEngine
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
  /** Optional server-only continuation admission. Called after the governed
   * child has a committed handle, before native Pi receives the outcome. The
   * host must atomically retain current canonical lineage and approval; this
   * callback never admits a new child or supplies provider/spending authority.
   */
  readonly retainContinuation?: (input: {
    readonly authority: DurableExecutionAuthority
    readonly source: PiDurableVerifiedToolSource
    readonly request: DurableToolCallRequest
    readonly outcome: PiDurableDelegateChildOutcome
  }) => Promise<void>
}

/** One governed management effect outcome, structurally identical to the app caller. */
export type PiDurableGovernedManagementCallOutcome =
  | Readonly<{ state: 'succeeded'; value: unknown }>
  | Readonly<{ state: 'refused'; code: string; reason?: string }>
  | Readonly<{ state: 'reconciliation_required'; code: 'PI_MANAGEMENT_EFFECT_UNKNOWN' }>

/** Engine-facing management port built by the adapter from the host compiler. */
export interface PiDurableGovernedManagementCallEnginePort {
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
    input: {
      readonly input: Readonly<Record<string, unknown>>
      readonly operation: string
      readonly source: PiDurableToolSource
      readonly sourceKey: string
    },
    reader: Pick<PiDurableToolSourceReader, 'readAssistantEntry' | 'readTask'>,
    signal?: AbortSignal
  ) => Promise<PiDurableGovernedManagementCallOutcome>
}

/**
 * Host compiler that retains the full immutable DurableToolCallRequest for the
 * exact verified native source, plus the durable caller that fences on the
 * canonical workspaceId + idempotencyKey identity.
 */
/** Verified management call arguments bound to the native source. */
export interface PiDurableVerifiedManagementToolSource {
  readonly args: Readonly<{
    readonly input: Readonly<Record<string, unknown>>
    readonly operation: string
  }>
  readonly source: PiDurableToolSource
  readonly sourceKey: string
}

export interface PiDurableGovernedManagementCallCompiler {
  readonly prepare: (
    authority: DurableExecutionAuthority,
    input: PiDurableVerifiedManagementToolSource
  ) => Promise<DurableToolCallRequest>
  readonly execute: (
    request: DurableToolCallRequest,
    signal?: AbortSignal
  ) => Promise<PiDurableGovernedManagementCallOutcome>
}

export type PiDurableAuthorityPurpose = 'inference' | 'cancel'

export interface PiDurableRuntimeOptions {
  readonly directory: string
  readonly now?: () => string
  readonly resolveAdmission: (request: RuntimeStartRequest) => Promise<PiDurableAdmission>
  /** `cancel` re-derives authority to stop or settle a stop: current actor, audience, scope and
   * lineage, but never model readiness. Every other call is `inference` (the default). */
  readonly assertAuthority: (
    authority: DurableExecutionAuthority,
    purpose?: PiDurableAuthorityPurpose
  ) => Promise<void>
  /** Revalidates retained state for observation without allocating a new budget or attempt. */
  readonly assertReadAuthority?: (authority: DurableExecutionAuthority) => Promise<void>
  /** Revalidates retained recovery authority without allocating a new budget or attempt. */
  readonly assertRecoveryAuthority?: (authority: DurableExecutionAuthority) => Promise<void>
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
    key: string,
    safeResume?: PiDurableInferenceResumePermit
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
  /** Durable governed management caller; retains the full immutable request. */
  readonly governedManagementCall?: PiDurableGovernedManagementCallCompiler
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
      preparePhysicalSend?: (requestDigest: string) => Promise<void>
      armPhysicalSend?: (requestDigest: string) => Promise<void>
    }>
    withModels: <T>(use: (models: Models) => Promise<T>) => Promise<T>
    readonly retainInferences?: (inferences: PiEngineResult['inferences']) => Promise<void>
    readonly governedDelegateChild?: PiDurableGovernedDelegateChildEnginePort
    readonly governedManagementCall?: PiDurableGovernedManagementCallEnginePort
  }) => Promise<DurablePiEngine>
}

/** Created by runtime recovery only after a trusted no-send verdict for this exact key. */
export interface PiDurableInferenceResumePermit {
  readonly schemaVersion: 'pi-inference-resume-permit/v1'
  readonly inferenceKey: string
}
