import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  canonicalJsonStringify,
  compareCodePointOrder,
  GraphReferenceSchema,
  GraphToolPinSchema,
  IdentifierSchemas,
} from '@control-plane/contracts'
import {
  CatalogApprovalDecisionSchema,
  CatalogVersionKindSchema,
  type CatalogApprovalDecision,
} from './catalog-approval.js'
import { evaluateCatalogApproval } from './catalog-approval-policy.js'
import { ExecutionPlanPinSchema, MarketplacePluginReferenceSchema } from './execution-lifecycle.js'

/**
 * Report-only replacement compatibility assessment (M16.02, #939).
 *
 * Compares an IMMUTABLE retained workflow definition against a PROPOSED
 * replacement (the typed approval → authorized write → receipt → settlement
 * durable task that would take over its retained execution) and returns an
 * advisory compatibility REPORT built from existing domain contracts:
 *
 * - Pins reuse `ExecutionPlanPinSchema` (implementation), the retained input
 *   pin digest, `GraphToolPinSchema` (tools) and `MarketplacePluginReference`
 *   canonical artifact versions — the exact accepted pins that must survive a
 *   replacement unchanged.
 * - Approvals reuse `CatalogApprovalDecision` and the shared
 *   `evaluateCatalogApproval` evaluator (#188): an explicit decision bound to
 *   the pinned revision and digest, recorded BEFORE the earliest retained
 *   effect (approval-before-effect).
 * - Effect keys follow the retained durable-key derivation
 *   (`workflowId:lifecyclePolicyVersion:operation`, the shape
 *   workflow-runtime derives); keys must be stable and collision-free.
 * - Receipt evidence restates the receipt identity the runtime event effect
 *   sink persists (`commandId`, `messageKind`, `messageSequence`,
 *   `frameHash`, `outcome`); every effect must resolve to one retained
 *   applied receipt with the same frame hash.
 * - Settlement evidence must resolve to exactly ONE logical settlement id per
 *   settlement key, including across recorded restarts.
 *
 * REPORT-ONLY BY CONSTRUCTION: the returned `ReplacementCompatibilityReport`
 * is frozen, carries no handle, callback, verdict flag or follow-up action of
 * any kind, and its advisory block types every authorization affordance as
 * the literal `false`. An `evidence-equivalent` outcome states that the
 * evidence sets are equivalent; it must never be treated as permission to
 * execute, adopt, drain, retire, or convert checkpoints.
 *
 * INPUT PROVENANCE: real-workflow qualification is explicitly still blocked
 * on the reviewed retirement inventory (#938, plus #935/#937). Only
 * fixture-labelled evidence (`evidenceKind: 'fixture'`) is assessed; anything
 * else is rejected as `invalid_provenance`, and every report is labelled as
 * fixture evidence that does not qualify real workflows.
 */

const TimestampSchema = z.iso.datetime()
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)

/** Fixture-only provenance; real-workflow evidence stays unexpressible (#938). */
export const ReplacementEvidenceProvenanceSchema = z
  .object({
    /** Only the `fixture` label is assessed today; any other value is `invalid_provenance`. */
    evidenceKind: z.string().min(1).max(64),
    fixtureId: z.string().min(1).max(128),
    generatedAt: TimestampSchema,
    note: z.string().min(1).max(1024).optional(),
  })
  .strict()
export type ReplacementEvidenceProvenance = z.output<typeof ReplacementEvidenceProvenanceSchema>

const ApprovalSubjectSchema = z
  .object({
    versionKind: CatalogVersionKindSchema,
    versionId: z.string().min(1).max(128),
    revision: z.number().int().positive(),
    contentDigest: DigestSchema,
  })
  .strict()
export type ReplacementApprovalSubject = z.output<typeof ApprovalSubjectSchema>

const InputPinSchema = z
  .object({
    inputDigest: DigestSchema,
    inputSchemaRef: z.string().min(1).max(256),
  })
  .strict()
export type ReplacementInputPin = z.output<typeof InputPinSchema>

const GraphAuthoritySchema = GraphReferenceSchema.extend({
  lifecycle: z.enum(['published', 'deprecated', 'revoked']),
})
export type ReplacementGraphAuthority = z.output<typeof GraphAuthoritySchema>

/** Pin core shared verbatim by both sides of the comparison. */
const DefinitionPinCoreSchema = z
  .object({
    workflowId: IdentifierSchemas.workflowId,
    lifecyclePolicyVersion: z
      .string()
      .regex(/^[a-z0-9.-]+$/)
      .min(1)
      .max(64),
    implementationPin: ExecutionPlanPinSchema,
    inputPin: InputPinSchema,
    toolPins: z.array(GraphToolPinSchema).max(256),
    artifactVersions: z.array(MarketplacePluginReferenceSchema).max(128),
    graphReference: GraphAuthoritySchema.optional(),
    approvalSubject: ApprovalSubjectSchema,
  })
  .strict()

const ReceiptRefSchema = z
  .object({
    commandId: IdentifierSchemas.commandId,
    messageKind: z.enum(['progress', 'terminal']),
    messageSequence: z.number().int().nonnegative(),
  })
  .strict()
export type ReplacementReceiptRef = z.output<typeof ReceiptRefSchema>

/** Identity mirror of a retained runtime event receipt (see runtime-event-receipts). */
const RetainedReceiptSchema = z
  .object({
    commandId: IdentifierSchemas.commandId,
    messageKind: z.enum(['progress', 'terminal']),
    messageSequence: z.number().int().nonnegative(),
    frameHash: DigestSchema,
    outcome: z.enum(['applied', 'out_of_order', 'terminal_conflict']),
    eventId: IdentifierSchemas.eventId.optional(),
  })
  .strict()
export type RetainedReceiptEvidence = z.output<typeof RetainedReceiptSchema>

const RetainedEffectSchema = z
  .object({
    effectKey: z.string().min(1).max(256),
    kind: z.enum(['progress', 'authorized_write', 'terminal']),
    frameHash: DigestSchema,
    occurredAt: TimestampSchema,
    receipt: ReceiptRefSchema,
  })
  .strict()
export type RetainedEffectEvidence = z.output<typeof RetainedEffectSchema>

const SettlementEvidenceSchema = z
  .object({
    settlementKey: z.string().min(1).max(256),
    settlementId: z.string().min(1).max(256),
    recordedAt: TimestampSchema,
    restartId: z.string().min(1).max(128).optional(),
  })
  .strict()
export type SettlementEvidence = z.output<typeof SettlementEvidenceSchema>

const RestartEvidenceSchema = z
  .object({
    restartId: z.string().min(1).max(128),
    observedAt: TimestampSchema,
  })
  .strict()
export type RestartEvidence = z.output<typeof RestartEvidenceSchema>

export const RetainedWorkflowEvidenceSchema = DefinitionPinCoreSchema.extend({
  approvals: z.array(CatalogApprovalDecisionSchema).max(32),
  effects: z.array(RetainedEffectSchema).min(1).max(1_024),
  receipts: z.array(RetainedReceiptSchema).max(1_024),
  settlements: z.array(SettlementEvidenceSchema).max(64),
  restarts: z.array(RestartEvidenceSchema).max(64),
}).strict()
export type RetainedWorkflowEvidence = z.output<typeof RetainedWorkflowEvidenceSchema>

const ProposedEffectSchema = z
  .object({
    /** The stable operation the replacement task derives its effect key from. */
    operation: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9][a-z0-9.:_-]*$/),
    effectKey: z.string().min(1).max(256),
    kind: z.enum(['progress', 'authorized_write', 'terminal']),
    receipt: ReceiptRefSchema,
  })
  .strict()
export type ProposedEffectEvidence = z.output<typeof ProposedEffectSchema>

export const ProposedReplacementEvidenceSchema = DefinitionPinCoreSchema.extend({
  taskKind: z.literal('typed-durable-task'),
  effects: z.array(ProposedEffectSchema).min(1).max(1_024),
  /** The one logical settlement the replacement task commits. */
  settlementKey: z.string().min(1).max(256),
}).strict()
export type ProposedReplacementEvidence = z.output<typeof ProposedReplacementEvidenceSchema>

export const ReplacementCompatibilityEvidenceSchema = z
  .object({
    provenance: ReplacementEvidenceProvenanceSchema,
    retained: RetainedWorkflowEvidenceSchema,
    proposed: ProposedReplacementEvidenceSchema,
  })
  .strict()
export type ReplacementCompatibilityEvidence = z.output<
  typeof ReplacementCompatibilityEvidenceSchema
>

/** Comparison axes; every assessment reports a finding for each axis. */
export const replacementCompatibilityAxes = [
  'evidence_provenance',
  'implementation_pin',
  'input_pin',
  'tool_pins',
  'artifact_versions',
  'authority_lifecycle',
  'approval_before_effect',
  'effect_keys',
  'receipt_linkage',
  'logical_settlement',
] as const
export type ReplacementCompatibilityAxis = (typeof replacementCompatibilityAxes)[number]

export type ReplacementCompatibilityRejectionFamily =
  | 'malformed_evidence'
  | 'invalid_provenance'
  | 'missing_evidence'
  | 'stale_evidence'
  | 'version_drift'
  | 'revoked_authority'
  | 'ordering_violation'
  | 'unstable_effect_key'
  | 'ambiguous_effect'
  | 'conflicting_receipt'
  | 'settlement_ambiguity'

export interface ReplacementCompatibilityRejection {
  readonly family: ReplacementCompatibilityRejectionFamily
  readonly axis: ReplacementCompatibilityAxis
  readonly reference: string
  readonly detail: string
}

export type ReplacementCompatibilityOutcome = 'evidence-equivalent' | 'evidence-divergent'

/**
 * The report's only advisory block. Every authorization affordance is typed
 * as the literal `false`, so a caller cannot read permission out of a report
 * nor widen these flags without an explicit, reviewable type change.
 */
export interface ReplacementCompatibilityAdvisory {
  readonly reportOnly: true
  readonly authorizesExecution: false
  readonly authorizesAdoption: false
  readonly authorizesDraining: false
  readonly authorizesRetirement: false
  readonly authorizesCheckpointConversion: false
}

export interface ReplacementCompatibilityAxisFinding {
  readonly axis: ReplacementCompatibilityAxis
  readonly outcome: 'equivalent' | 'divergent' | 'not_assessed'
  readonly rejections: readonly ReplacementCompatibilityRejection[]
}

export interface ReplacementCompatibilityReport {
  readonly report: 'replacement-compatibility.v1'
  readonly evidenceProvenance: 'fixture' | 'unverified'
  /** Fixture evidence never qualifies real workflows (#938/#935/#937 pending). */
  readonly qualification: 'fixture-evidence-only' | 'not-qualified'
  readonly subject: {
    readonly workflowId?: string
    readonly retainedEvidenceDigest: string
    readonly proposedEvidenceDigest: string
  }
  readonly outcome: ReplacementCompatibilityOutcome
  readonly axes: readonly ReplacementCompatibilityAxisFinding[]
  readonly rejections: readonly ReplacementCompatibilityRejection[]
  readonly advisory: ReplacementCompatibilityAdvisory
}

const ADVISORY: ReplacementCompatibilityAdvisory = Object.freeze({
  reportOnly: true,
  authorizesExecution: false,
  authorizesAdoption: false,
  authorizesDraining: false,
  authorizesRetirement: false,
  authorizesCheckpointConversion: false,
})

/**
 * Deterministic durable effect key for a typed task operation — the same
 * `workflowId:policyVersion:operation` shape the retained execution lifecycle
 * derives. Exported so task authors and fixtures derive keys instead of
 * hand-writing them.
 */
export function deriveTaskEffectKey(input: {
  readonly workflowId: string
  readonly lifecyclePolicyVersion: string
  readonly operation: string
}): string {
  return `${input.workflowId}:${input.lifecyclePolicyVersion}:${input.operation}`
}

function rejection(
  family: ReplacementCompatibilityRejectionFamily,
  axis: ReplacementCompatibilityAxis,
  reference: string,
  detail: string
): ReplacementCompatibilityRejection {
  return { family, axis, reference, detail }
}

function evidenceDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJsonStringify(value)).digest('hex')}`
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJsonStringify(left) === canonicalJsonStringify(right)
}

function pinDriftRejections(
  axis: ReplacementCompatibilityAxis,
  reference: string,
  retained: unknown,
  proposed: unknown
): ReplacementCompatibilityRejection[] {
  return sameJson(retained, proposed)
    ? []
    : [
        rejection(
          'version_drift',
          axis,
          reference,
          'Proposed evidence does not match the immutable retained pin'
        ),
      ]
}

function pinnedSetDiffers<Value>(
  retained: readonly Value[],
  proposed: readonly Value[],
  keyOf: (entry: Value) => string
): boolean {
  const key = (entries: readonly Value[]) =>
    entries.map(keyOf).toSorted(compareCodePointOrder).join('|')
  return key(retained) !== key(proposed)
}

function latestDecision(
  approvals: readonly CatalogApprovalDecision[],
  subject: ReplacementApprovalSubject
): CatalogApprovalDecision | undefined {
  return approvals
    .filter(
      (decision) =>
        decision.versionKind === subject.versionKind && decision.versionId === subject.versionId
    )
    .toSorted(
      (left, right) =>
        left.revision - right.revision || Date.parse(left.decidedAt) - Date.parse(right.decidedAt)
    )
    .at(-1)
}

interface ApprovalAssessment {
  readonly rejections: ReplacementCompatibilityRejection[]
}

function assessApproval(retained: RetainedWorkflowEvidence): ApprovalAssessment {
  const subject = retained.approvalSubject
  const rejections: ReplacementCompatibilityRejection[] = []
  if (subject.contentDigest !== retained.implementationPin.contentDigest) {
    rejections.push(
      rejection(
        'stale_evidence',
        'approval_before_effect',
        `approvalSubject:${subject.versionId}`,
        'Approval subject digest does not bind to the pinned implementation digest'
      )
    )
  }
  const decision = latestDecision(retained.approvals, subject)
  if (decision === undefined) {
    rejections.push(
      rejection(
        'missing_evidence',
        'approval_before_effect',
        `approvalSubject:${subject.versionId}`,
        'No approval decision is recorded for the approval subject'
      )
    )
    return { rejections }
  }
  const evaluation = evaluateCatalogApproval({
    policy: { required: true },
    version: { revision: subject.revision, contentDigest: subject.contentDigest },
    approval: decision,
  })
  const authorityHolds = evaluation.verdict === 'approved' || evaluation.verdict === 'grandfathered'
  if (!authorityHolds && evaluation.verdict === 'rejected') {
    rejections.push(
      rejection(
        'revoked_authority',
        'approval_before_effect',
        `approval:${decision.versionId}`,
        'The latest recorded decision for the pinned version is a rejection'
      )
    )
  } else if (!authorityHolds) {
    rejections.push(
      rejection(
        evaluation.reason === 'DECISION_BINDING_STALE' ? 'stale_evidence' : 'missing_evidence',
        'approval_before_effect',
        `approval:${decision.versionId}`,
        evaluation.reason ?? 'APPROVAL_EVALUATION_MISSING'
      )
    )
  }
  for (const effect of retained.effects) {
    if (Date.parse(effect.occurredAt) < Date.parse(decision.decidedAt)) {
      rejections.push(
        rejection(
          'ordering_violation',
          'approval_before_effect',
          effect.effectKey,
          'Effect predates the recorded approval decision (approval-before-effect violated)'
        )
      )
    }
  }
  return { rejections }
}

function receiptKeyOf(ref: ReplacementReceiptRef): string {
  return `${ref.commandId}:${ref.messageKind}:${ref.messageSequence}`
}

function assessRetainedEffectCoherence(
  retained: RetainedWorkflowEvidence
): ReplacementCompatibilityRejection[] {
  const rejections: ReplacementCompatibilityRejection[] = []
  const keyPrefix = `${retained.workflowId}:${retained.lifecyclePolicyVersion}:`
  const seenKeys = new Set<string>()
  const receipts = new Map(retained.receipts.map((receipt) => [receiptKeyOf(receipt), receipt]))
  for (const effect of retained.effects) {
    if (!effect.effectKey.startsWith(keyPrefix)) {
      rejections.push(
        rejection(
          'unstable_effect_key',
          'effect_keys',
          effect.effectKey,
          'Retained effect key is not derived from the retained workflow and policy version'
        )
      )
    }
    if (seenKeys.has(effect.effectKey)) {
      rejections.push(
        rejection(
          'ambiguous_effect',
          'effect_keys',
          effect.effectKey,
          'Effect key is recorded more than once in the retained evidence'
        )
      )
    }
    seenKeys.add(effect.effectKey)
    const receipt = receipts.get(receiptKeyOf(effect.receipt))
    if (receipt === undefined) {
      rejections.push(
        rejection(
          'missing_evidence',
          'receipt_linkage',
          receiptKeyOf(effect.receipt),
          'Retained effect has no retained receipt'
        )
      )
      continue
    }
    if (receipt.frameHash !== effect.frameHash) {
      rejections.push(
        rejection(
          'ambiguous_effect',
          'receipt_linkage',
          receiptKeyOf(effect.receipt),
          'Retained effect and receipt disagree on the frame hash'
        )
      )
    }
    if (receipt.outcome === 'terminal_conflict') {
      rejections.push(
        rejection(
          'conflicting_receipt',
          'receipt_linkage',
          receiptKeyOf(effect.receipt),
          'Retained receipt records a terminal conflict'
        )
      )
    } else if (receipt.outcome === 'out_of_order') {
      rejections.push(
        rejection(
          'ambiguous_effect',
          'receipt_linkage',
          receiptKeyOf(effect.receipt),
          'Retained receipt records an out-of-order (uncertain) application'
        )
      )
    }
  }
  for (const [firstIndex, left] of retained.receipts.entries()) {
    for (const right of retained.receipts.slice(firstIndex + 1)) {
      if (receiptKeyOf(left) === receiptKeyOf(right) && left.frameHash !== right.frameHash) {
        rejections.push(
          rejection(
            'conflicting_receipt',
            'receipt_linkage',
            receiptKeyOf(left),
            'Two retained receipts share an identity but disagree on the frame hash'
          )
        )
      }
    }
  }
  return rejections
}

function assessReceiptLinkage(
  retained: RetainedWorkflowEvidence,
  proposed: ProposedReplacementEvidence
): ReplacementCompatibilityRejection[] {
  const rejections: ReplacementCompatibilityRejection[] = []
  const retainedEffects = new Map(
    retained.effects.map((effect) => [receiptKeyOf(effect.receipt), effect])
  )
  const claimed = new Set<string>()
  for (const effect of proposed.effects) {
    const key = receiptKeyOf(effect.receipt)
    if (claimed.has(key)) {
      rejections.push(
        rejection(
          'ambiguous_effect',
          'receipt_linkage',
          key,
          'Proposed replacement claims the same retained receipt twice'
        )
      )
      continue
    }
    claimed.add(key)
    const retainedEffect = retainedEffects.get(key)
    if (retainedEffect === undefined) {
      rejections.push(
        rejection(
          'missing_evidence',
          'receipt_linkage',
          key,
          'Proposed effect links a receipt the retained evidence does not retain'
        )
      )
      continue
    }
    if (retainedEffect.effectKey !== effect.effectKey) {
      rejections.push(
        rejection(
          'unstable_effect_key',
          'effect_keys',
          effect.effectKey,
          'Proposed effect key differs from the retained effect key for the same receipt'
        )
      )
    }
    if (retainedEffect.kind !== effect.kind) {
      rejections.push(
        rejection(
          'ambiguous_effect',
          'effect_keys',
          effect.effectKey,
          'Proposed effect re-types a retained effect (uncertain effect mapping)'
        )
      )
    }
    if (
      effect.effectKey !==
      deriveTaskEffectKey({
        workflowId: proposed.workflowId,
        lifecyclePolicyVersion: proposed.lifecyclePolicyVersion,
        operation: effect.operation,
      })
    ) {
      rejections.push(
        rejection(
          'unstable_effect_key',
          'effect_keys',
          effect.effectKey,
          'Proposed effect key is not derived from its declared operation'
        )
      )
    }
  }
  for (const [key, retainedEffect] of retainedEffects) {
    if (!claimed.has(key)) {
      rejections.push(
        rejection(
          'missing_evidence',
          'receipt_linkage',
          retainedEffect.effectKey,
          'Retained applied effect is not linked by the proposed replacement'
        )
      )
    }
  }
  return rejections
}

function assessSettlement(
  retained: RetainedWorkflowEvidence,
  proposed: ProposedReplacementEvidence
): ReplacementCompatibilityRejection[] {
  const rejections: ReplacementCompatibilityRejection[] = []
  if (retained.settlements.length === 0) {
    rejections.push(
      rejection(
        'missing_evidence',
        'logical_settlement',
        proposed.settlementKey,
        'Retained evidence records no settlement'
      )
    )
    return rejections
  }
  const restartIds = new Set(retained.restarts.map((restart) => restart.restartId))
  for (const settlement of retained.settlements) {
    if (settlement.restartId !== undefined && !restartIds.has(settlement.restartId)) {
      rejections.push(
        rejection(
          'missing_evidence',
          'logical_settlement',
          settlement.settlementId,
          'Settlement references a restart the retained evidence does not record'
        )
      )
    }
  }
  const keys = new Set(retained.settlements.map((settlement) => settlement.settlementKey))
  if (keys.size !== 1) {
    rejections.push(
      rejection(
        'settlement_ambiguity',
        'logical_settlement',
        proposed.settlementKey,
        `Expected one logical settlement key, found ${keys.size}`
      )
    )
  }
  const ids = new Set(retained.settlements.map((settlement) => settlement.settlementId))
  if (ids.size !== 1) {
    rejections.push(
      rejection(
        'settlement_ambiguity',
        'logical_settlement',
        proposed.settlementKey,
        'Retained evidence records more than one settlement for the logical settlement (double settlement across restarts)'
      )
    )
  }
  if (!keys.has(proposed.settlementKey)) {
    rejections.push(
      rejection(
        'settlement_ambiguity',
        'logical_settlement',
        proposed.settlementKey,
        'Proposed settlement key does not match the retained logical settlement'
      )
    )
  }
  return rejections
}

function divergentReport(input: {
  readonly evidenceProvenance: 'fixture' | 'unverified'
  readonly qualification: 'fixture-evidence-only' | 'not-qualified'
  readonly workflowId?: string
  readonly retainedEvidenceDigest: string
  readonly proposedEvidenceDigest: string
  readonly rejection: ReplacementCompatibilityRejection
}): ReplacementCompatibilityReport {
  return deepFreeze({
    report: 'replacement-compatibility.v1',
    evidenceProvenance: input.evidenceProvenance,
    qualification: input.qualification,
    subject: {
      ...(input.workflowId === undefined ? {} : { workflowId: input.workflowId }),
      retainedEvidenceDigest: input.retainedEvidenceDigest,
      proposedEvidenceDigest: input.proposedEvidenceDigest,
    },
    outcome: 'evidence-divergent',
    axes: replacementCompatibilityAxes.map((axis) => ({
      axis,
      outcome: axis === input.rejection.axis ? ('divergent' as const) : ('not_assessed' as const),
      rejections: axis === input.rejection.axis ? [input.rejection] : [],
    })),
    rejections: [input.rejection],
    advisory: ADVISORY,
  })
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry)
    Object.freeze(value)
  }
  return value
}

/**
 * Assess replacement compatibility. TOTAL and PURE: never throws, performs no
 * I/O, and returns a frozen advisory report with no authorization surface.
 */
export function assessReplacementCompatibility(input: unknown): ReplacementCompatibilityReport {
  const parseResult = ReplacementCompatibilityEvidenceSchema.safeParse(input)
  if (!parseResult.success) {
    const issue = parseResult.error.issues[0]
    return divergentReport({
      evidenceProvenance: 'unverified',
      qualification: 'not-qualified',
      retainedEvidenceDigest: evidenceDigest(input),
      proposedEvidenceDigest: `sha256:${'0'.repeat(64)}`,
      rejection: rejection(
        'malformed_evidence',
        'evidence_provenance',
        'envelope',
        `Evidence envelope failed schema validation at ${issue?.path.map(String).join('.') || 'root'}`
      ),
    })
  }
  const { provenance, retained, proposed } = parseResult.data
  if (provenance.evidenceKind !== 'fixture') {
    return divergentReport({
      evidenceProvenance: 'unverified',
      qualification: 'not-qualified',
      workflowId: retained.workflowId,
      retainedEvidenceDigest: evidenceDigest(retained),
      proposedEvidenceDigest: evidenceDigest(proposed),
      rejection: rejection(
        'invalid_provenance',
        'evidence_provenance',
        provenance.evidenceKind,
        'Only fixture-labelled evidence is assessed; real-workflow qualification remains blocked (#938)'
      ),
    })
  }

  const rejections: ReplacementCompatibilityRejection[] = []
  if (retained.workflowId !== proposed.workflowId) {
    rejections.push(
      rejection(
        'version_drift',
        'implementation_pin',
        'workflow.subject',
        'Retained and proposed evidence describe different workflow subjects'
      )
    )
  }
  if (retained.lifecyclePolicyVersion !== proposed.lifecyclePolicyVersion) {
    rejections.push(
      rejection(
        'unstable_effect_key',
        'effect_keys',
        retained.lifecyclePolicyVersion,
        'Lifecycle policy version drifted between retained and proposed evidence'
      )
    )
  }
  rejections.push(
    ...pinDriftRejections(
      'implementation_pin',
      'implementationPin',
      retained.implementationPin,
      proposed.implementationPin
    ),
    ...pinDriftRejections('input_pin', 'inputPin', retained.inputPin, proposed.inputPin)
  )
  if (
    pinnedSetDiffers(
      retained.toolPins,
      proposed.toolPins,
      (pin) => `${pin.toolVersionId}:${pin.operation}`
    )
  ) {
    rejections.push(
      rejection(
        'version_drift',
        'tool_pins',
        'toolPins',
        'Proposed tool pins do not match the immutable retained tool pins'
      )
    )
  }
  if (
    pinnedSetDiffers(
      retained.artifactVersions,
      proposed.artifactVersions,
      (entry) => `${entry.pluginId}:${entry.releaseId}:${entry.canonicalContentDigest}`
    )
  ) {
    rejections.push(
      rejection(
        'version_drift',
        'artifact_versions',
        'artifactVersions',
        'Proposed canonical artifact versions do not match the retained versions'
      )
    )
  }
  const graphAuthorities = [retained.graphReference, proposed.graphReference]
  const [retainedGraph, proposedGraph] = graphAuthorities
  // Lifecycle is authority state, not pin identity: drift compares only the
  // reference triple, revocation is checked separately below.
  const referenceOf = (graph: ReplacementGraphAuthority) => ({
    graphDefinitionId: graph.graphDefinitionId,
    graphVersion: graph.graphVersion,
    contentDigest: graph.contentDigest,
  })
  if (retainedGraph === undefined && proposedGraph !== undefined) {
    rejections.push(
      rejection(
        'version_drift',
        'authority_lifecycle',
        proposedGraph.graphDefinitionId,
        'Proposed evidence pins a graph the retained evidence does not retain'
      )
    )
  }
  if (
    retainedGraph !== undefined &&
    (proposedGraph === undefined ||
      !sameJson(referenceOf(retainedGraph), referenceOf(proposedGraph)))
  ) {
    rejections.push(
      rejection(
        'version_drift',
        'authority_lifecycle',
        retainedGraph.graphDefinitionId,
        'Proposed graph reference does not match the retained graph reference'
      )
    )
  }
  for (const graph of graphAuthorities) {
    if (graph?.lifecycle === 'revoked') {
      rejections.push(
        rejection(
          'revoked_authority',
          'authority_lifecycle',
          graph.graphDefinitionId,
          'Graph authority is revoked'
        )
      )
    }
  }

  rejections.push(...assessApproval(retained).rejections)
  rejections.push(...assessRetainedEffectCoherence(retained))
  rejections.push(...assessReceiptLinkage(retained, proposed))
  rejections.push(...assessSettlement(retained, proposed))

  const byAxis = new Map<ReplacementCompatibilityAxis, ReplacementCompatibilityRejection[]>(
    replacementCompatibilityAxes.map((axis) => [axis, []])
  )
  for (const item of rejections) byAxis.get(item.axis)?.push(item)
  const axes = replacementCompatibilityAxes.map((axis) => {
    const axisRejections = byAxis.get(axis) ?? []
    return {
      axis,
      outcome: axisRejections.length === 0 ? ('equivalent' as const) : ('divergent' as const),
      rejections: axisRejections,
    }
  })
  return deepFreeze({
    report: 'replacement-compatibility.v1',
    evidenceProvenance: 'fixture',
    qualification: 'fixture-evidence-only',
    subject: {
      workflowId: retained.workflowId,
      retainedEvidenceDigest: evidenceDigest(retained),
      proposedEvidenceDigest: evidenceDigest(proposed),
    },
    outcome:
      rejections.length === 0 ? ('evidence-equivalent' as const) : ('evidence-divergent' as const),
    axes,
    rejections,
    advisory: ADVISORY,
  })
}
