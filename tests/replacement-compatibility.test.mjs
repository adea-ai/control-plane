import { describe, expect, test } from 'bun:test'
import {
  assessReplacementCompatibility,
  deriveTaskEffectKey,
  replacementCompatibilityAxes,
} from '../packages/domain/src/replacement-compatibility.ts'

/**
 * M16.02 (#939) report-only replacement compatibility validator.
 *
 * The reviewed retirement inventory (#938) is NOT merged to main, so every
 * input here is FIXTURE evidence carrying the mandatory fixture provenance
 * label; a passing report is fixture evidence and never real-workflow
 * qualification. The validator itself is report-only: its output must expose
 * no authorization affordance, which the final describe block asserts.
 */

const WORKFLOW_ID = `wfl_${'A'.repeat(26)}`
const POLICY_VERSION = 'execution-lifecycle-v1'
const COMMAND_ID = `cmd_${'B'.repeat(26)}`
const APPROVAL_SUBJECT_ID = `pfv_${'C'.repeat(26)}`
const EXECUTION_PLAN_ID = `pln_${'D'.repeat(26)}`
const TOOL_DEFINITION_ID = `tld_${'E'.repeat(26)}`
const TOOL_VERSION_ID = `tlv_${'F'.repeat(26)}`
const EVENT_ID = `evt_${'0'.repeat(26)}`
const hex = (digit) => `sha256:${String(digit).repeat(64)}`
const EFFECT_KEY_PREFIX = `${WORKFLOW_ID}:${POLICY_VERSION}:`
const APPROVED_AT = '2026-02-01T09:00:00.000Z'

const implementationPin = () => ({
  executionPlanId: EXECUTION_PLAN_ID,
  contentDigest: hex(1),
  schemaVersion: 2,
})

const inputPin = () => ({ inputDigest: hex(2), inputSchemaRef: 'graph-input-v1' })

const toolPins = () => [
  {
    toolDefinitionId: TOOL_DEFINITION_ID,
    toolVersionId: TOOL_VERSION_ID,
    contentDigest: hex(3),
    operation: 'files.write',
  },
]

const artifactVersions = () => [
  {
    pluginId: 'plugin:demo-graph:abcdef01',
    releaseId: `release:${'a'.repeat(64)}`,
    canonicalContentDigest: hex(4),
  },
]

const graphReference = (lifecycle = 'published') => ({
  graphDefinitionId: 'demo-graph',
  graphVersion: '1.4.2',
  contentDigest: hex(5),
  lifecycle,
})

const approvalSubject = () => ({
  versionKind: 'agent_profile',
  versionId: APPROVAL_SUBJECT_ID,
  revision: 7,
  contentDigest: hex(1),
})

const approvals = (decision = 'approved', decidedAt = APPROVED_AT) => [
  {
    versionKind: 'agent_profile',
    versionId: APPROVAL_SUBJECT_ID,
    revision: 7,
    contentDigest: hex(1),
    decision,
    actorPrincipalRef: 'svc_retirement-operator',
    decidedAt,
  },
]

const retainedEffects = () => [
  {
    effectKey: deriveTaskEffectKey({
      workflowId: WORKFLOW_ID,
      lifecyclePolicyVersion: POLICY_VERSION,
      operation: 'progress:1',
    }),
    kind: 'progress',
    frameHash: hex(6),
    occurredAt: '2026-02-01T10:00:00.000Z',
    receipt: { commandId: COMMAND_ID, messageKind: 'progress', messageSequence: 1 },
  },
  {
    effectKey: deriveTaskEffectKey({
      workflowId: WORKFLOW_ID,
      lifecyclePolicyVersion: POLICY_VERSION,
      operation: 'authorized-write:primary',
    }),
    kind: 'authorized_write',
    frameHash: hex(7),
    occurredAt: '2026-02-01T10:05:00.000Z',
    receipt: { commandId: COMMAND_ID, messageKind: 'progress', messageSequence: 2 },
  },
  {
    effectKey: deriveTaskEffectKey({
      workflowId: WORKFLOW_ID,
      lifecyclePolicyVersion: POLICY_VERSION,
      operation: 'terminal',
    }),
    kind: 'terminal',
    frameHash: hex(8),
    occurredAt: '2026-02-01T10:09:00.000Z',
    receipt: { commandId: COMMAND_ID, messageKind: 'terminal', messageSequence: 3 },
  },
]

const retainedReceipts = (outcomes = { 1: 'applied', 2: 'applied', 3: 'applied' }) => [
  {
    commandId: COMMAND_ID,
    messageKind: 'progress',
    messageSequence: 1,
    frameHash: hex(6),
    outcome: outcomes[1],
    eventId: EVENT_ID,
  },
  {
    commandId: COMMAND_ID,
    messageKind: 'progress',
    messageSequence: 2,
    frameHash: hex(7),
    outcome: outcomes[2],
  },
  {
    commandId: COMMAND_ID,
    messageKind: 'terminal',
    messageSequence: 3,
    frameHash: hex(8),
    outcome: outcomes[3],
  },
]

const settlements = (settlementId = 'settlement-0001') => [
  {
    settlementKey: `${WORKFLOW_ID}:logical-settlement`,
    settlementId,
    recordedAt: '2026-02-01T10:10:00.000Z',
  },
]

const restarts = () => [{ restartId: 'restart-1', observedAt: '2026-02-01T10:07:00.000Z' }]

const retainedEvidence = (overrides = {}) => ({
  workflowId: WORKFLOW_ID,
  lifecyclePolicyVersion: POLICY_VERSION,
  implementationPin: implementationPin(),
  inputPin: inputPin(),
  toolPins: toolPins(),
  artifactVersions: artifactVersions(),
  graphReference: graphReference(),
  approvalSubject: approvalSubject(),
  approvals: approvals(),
  effects: retainedEffects(),
  receipts: retainedReceipts(),
  settlements: settlements(),
  restarts: restarts(),
  ...overrides,
})

const proposedEffects = () =>
  retainedEffects().map((effect) => ({
    operation: effect.effectKey.slice(EFFECT_KEY_PREFIX.length),
    effectKey: effect.effectKey,
    kind: effect.kind,
    receipt: effect.receipt,
  }))

const proposedEvidence = (overrides = {}) => ({
  workflowId: WORKFLOW_ID,
  lifecyclePolicyVersion: POLICY_VERSION,
  implementationPin: implementationPin(),
  inputPin: inputPin(),
  toolPins: toolPins(),
  artifactVersions: artifactVersions(),
  graphReference: graphReference(),
  approvalSubject: approvalSubject(),
  taskKind: 'typed-durable-task',
  effects: proposedEffects(),
  settlementKey: `${WORKFLOW_ID}:logical-settlement`,
  ...overrides,
})

const fixtureEnvelope = (retained = retainedEvidence(), proposed = proposedEvidence()) => ({
  provenance: {
    evidenceKind: 'fixture',
    fixtureId: 'retained-replacement-compat-fixture-v1',
    generatedAt: '2026-02-01T12:00:00.000Z',
    note: 'Inventory-shaped fixture evidence; the reviewed inventory tool (#938) is not merged.',
  },
  retained,
  proposed,
})

const familiesOf = (report) => report.rejections.map((rejection) => rejection.family)
const findingFor = (report, axis) => report.axes.find((finding) => finding.axis === axis)

describe('replacement compatibility (report-only, M16.02 #939)', () => {
  test('an identical pinned replacement is evidence-equivalent with advisory fixture labelling', () => {
    const report = assessReplacementCompatibility(fixtureEnvelope())

    expect(report.report).toBe('replacement-compatibility.v1')
    expect(report.outcome).toBe('evidence-equivalent')
    expect(report.rejections).toEqual([])
    expect(report.evidenceProvenance).toBe('fixture')
    expect(report.qualification).toBe('fixture-evidence-only')
    expect(report.subject.workflowId).toBe(WORKFLOW_ID)
    expect(report.subject.retainedEvidenceDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(report.subject.proposedEvidenceDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(report.axes.map((finding) => finding.axis)).toEqual([...replacementCompatibilityAxes])
    expect(report.axes.every((finding) => finding.outcome === 'equivalent')).toBe(true)
  })

  test('assessment is pure and deterministic', () => {
    const envelope = fixtureEnvelope()
    const first = assessReplacementCompatibility(envelope)
    const second = assessReplacementCompatibility(envelope)
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
    expect(Object.getPrototypeOf(first)).toBe(Object.prototype)
  })

  test('implementation, input, tool, and artifact version drift are each rejected', () => {
    const cases = [
      {
        axis: 'implementation_pin',
        proposed: proposedEvidence({
          implementationPin: { ...implementationPin(), contentDigest: hex(9) },
        }),
      },
      {
        axis: 'input_pin',
        proposed: proposedEvidence({ inputPin: { ...inputPin(), inputDigest: hex(9) } }),
      },
      {
        axis: 'tool_pins',
        proposed: proposedEvidence({
          toolPins: [{ ...toolPins()[0], toolVersionId: `tlv_${'G'.repeat(26)}` }],
        }),
      },
      {
        axis: 'artifact_versions',
        proposed: proposedEvidence({
          artifactVersions: [{ ...artifactVersions()[0], releaseId: `release:${'b'.repeat(64)}` }],
        }),
      },
    ]
    for (const { axis, proposed } of cases) {
      const report = assessReplacementCompatibility(fixtureEnvelope(retainedEvidence(), proposed))
      expect(report.outcome).toBe('evidence-divergent')
      expect(familiesOf(report)).toContain('version_drift')
      expect(findingFor(report, axis)?.outcome).toBe('divergent')
      expect(findingFor(report, axis)?.rejections[0]?.family).toBe('version_drift')
    }
  })

  test('tool pin drift is compared on the complete pin, including definition id and digest', () => {
    const cases = [
      {
        mutated: [{ ...toolPins()[0], toolDefinitionId: `tld_${'Z'.repeat(26)}` }],
      },
      {
        mutated: [{ ...toolPins()[0], contentDigest: hex('b') }],
      },
    ]
    for (const { mutated } of cases) {
      const report = assessReplacementCompatibility(
        fixtureEnvelope(retainedEvidence(), proposedEvidence({ toolPins: mutated }))
      )
      expect(report.outcome).toBe('evidence-divergent')
      const finding = findingFor(report, 'tool_pins')
      expect(finding?.outcome).toBe('divergent')
      expect(finding?.rejections[0]?.family).toBe('version_drift')
      expect(finding?.rejections[0]?.detail).toContain('tool pins')
    }
  })

  test('revoked graph authority and rejected approvals are rejected', () => {
    const revokedGraph = assessReplacementCompatibility(
      fixtureEnvelope(retainedEvidence({ graphReference: graphReference('revoked') }))
    )
    expect(familiesOf(revokedGraph)).toContain('revoked_authority')
    expect(
      findingFor(revokedGraph, 'authority_lifecycle')?.rejections.map((entry) => entry.family)
    ).toContain('revoked_authority')

    const rejectedApproval = assessReplacementCompatibility(
      fixtureEnvelope(retainedEvidence({ approvals: approvals('rejected') }))
    )
    expect(familiesOf(rejectedApproval)).toContain('revoked_authority')
    expect(findingFor(rejectedApproval, 'approval_before_effect')?.rejections[0]?.family).toBe(
      'revoked_authority'
    )
  })

  test('conflicting receipts are rejected', () => {
    const duplicatedIdentity = assessReplacementCompatibility(
      fixtureEnvelope(
        retainedEvidence({
          receipts: [
            ...retainedReceipts(),
            {
              commandId: COMMAND_ID,
              messageKind: 'terminal',
              messageSequence: 3,
              frameHash: hex('f'),
              outcome: 'applied',
            },
          ],
        })
      )
    )
    expect(familiesOf(duplicatedIdentity)).toContain('conflicting_receipt')

    const terminalConflict = assessReplacementCompatibility(
      fixtureEnvelope(
        retainedEvidence({
          receipts: retainedReceipts({ 1: 'applied', 2: 'applied', 3: 'terminal_conflict' }),
        })
      )
    )
    expect(familiesOf(terminalConflict)).toContain('conflicting_receipt')
    expect(findingFor(terminalConflict, 'receipt_linkage')?.rejections[0]?.family).toBe(
      'conflicting_receipt'
    )
  })

  test('conflicting duplicate receipt outcomes are detected before maps are built; agreeing duplicates stay benign', () => {
    // The conflicting duplicate is ordered LAST-WRITTEN-FIRST: the applied
    // entry is last, so a receipt map built before conflict detection would
    // silently keep the applied outcome (last-write-wins) and hide the
    // disagreement.
    const conflictingOutcomes = assessReplacementCompatibility(
      fixtureEnvelope(
        retainedEvidence({
          receipts: [
            ...retainedReceipts(),
            {
              commandId: COMMAND_ID,
              messageKind: 'terminal',
              messageSequence: 3,
              frameHash: hex(8),
              outcome: 'out_of_order',
            },
            {
              commandId: COMMAND_ID,
              messageKind: 'terminal',
              messageSequence: 3,
              frameHash: hex(8),
              outcome: 'applied',
            },
          ],
        })
      )
    )
    expect(conflictingOutcomes.outcome).toBe('evidence-divergent')
    expect(
      (findingFor(conflictingOutcomes, 'receipt_linkage')?.rejections ?? []).some(
        (rejection) =>
          rejection.family === 'conflicting_receipt' &&
          rejection.detail.includes('disagree on the frame hash or outcome')
      )
    ).toBe(true)

    // Duplicate receipts that agree on the frame hash and outcome keep the
    // existing benign semantics: no conflicting receipt is reported.
    const agreeingDuplicate = assessReplacementCompatibility(
      fixtureEnvelope(
        retainedEvidence({
          receipts: [
            ...retainedReceipts(),
            {
              commandId: COMMAND_ID,
              messageKind: 'terminal',
              messageSequence: 3,
              frameHash: hex(8),
              outcome: 'applied',
            },
          ],
        })
      )
    )
    expect(familiesOf(agreeingDuplicate)).not.toContain('conflicting_receipt')
    expect(agreeingDuplicate.outcome).toBe('evidence-equivalent')
  })

  test('one logical settlement survives restart evidence; double settlement is ambiguous', () => {
    const acrossRestart = assessReplacementCompatibility(
      fixtureEnvelope(
        retainedEvidence({
          settlements: [
            {
              settlementKey: `${WORKFLOW_ID}:logical-settlement`,
              settlementId: 'settlement-0001',
              recordedAt: '2026-02-01T10:06:00.000Z',
            },
            {
              settlementKey: `${WORKFLOW_ID}:logical-settlement`,
              settlementId: 'settlement-0001',
              recordedAt: '2026-02-01T10:11:00.000Z',
              restartId: 'restart-1',
            },
          ],
        })
      )
    )
    expect(acrossRestart.outcome).toBe('evidence-equivalent')

    const doubleSettlement = assessReplacementCompatibility(
      fixtureEnvelope(
        retainedEvidence({
          settlements: [
            ...settlements(),
            {
              settlementKey: `${WORKFLOW_ID}:logical-settlement`,
              settlementId: 'settlement-0002',
              recordedAt: '2026-02-01T10:12:00.000Z',
              restartId: 'restart-1',
            },
          ],
        })
      )
    )
    expect(doubleSettlement.outcome).toBe('evidence-divergent')
    expect(findingFor(doubleSettlement, 'logical_settlement')?.rejections[0]?.family).toBe(
      'settlement_ambiguity'
    )
  })

  test('uncertain or ambiguous effects are rejected', () => {
    const duplicatedKey = retainedEvidence()
    duplicatedKey.effects = [
      ...duplicatedKey.effects,
      { ...duplicatedKey.effects[0], frameHash: hex('e') },
    ]
    duplicatedKey.receipts = [
      ...duplicatedKey.receipts,
      { ...duplicatedKey.receipts[0], messageSequence: 4, frameHash: hex('e') },
    ]
    const duplicated = assessReplacementCompatibility(fixtureEnvelope(duplicatedKey))
    expect(familiesOf(duplicated)).toContain('ambiguous_effect')

    const uncertain = assessReplacementCompatibility(
      fixtureEnvelope(
        retainedEvidence({
          receipts: retainedReceipts({ 1: 'out_of_order', 2: 'applied', 3: 'applied' }),
        })
      )
    )
    expect(familiesOf(uncertain)).toContain('ambiguous_effect')

    const retyped = proposedEvidence({
      effects: proposedEffects().map((effect) =>
        effect.kind === 'terminal' ? { ...effect, kind: 'progress' } : effect
      ),
    })
    const remapped = assessReplacementCompatibility(fixtureEnvelope(retainedEvidence(), retyped))
    expect(familiesOf(remapped)).toContain('ambiguous_effect')
  })

  test('retained effects and receipts stay one-to-one: aliasing and cardinality mismatches are rejected', () => {
    const toProposed = (effects) =>
      effects.map((effect) => ({
        operation: effect.effectKey.slice(EFFECT_KEY_PREFIX.length),
        effectKey: effect.effectKey,
        kind: effect.kind,
        receipt: effect.receipt,
      }))

    // Two retained effects share ONE receipt identity with frame hashes made
    // consistent, and the proposed side links only the deduped view: before
    // the one-to-one rule, the aliased effect silently disappeared from the
    // comparison and the report stayed evidence-equivalent.
    const aliasedEffects = retainedEffects()
    aliasedEffects[1] = {
      ...aliasedEffects[1],
      frameHash: hex(6),
      receipt: { commandId: COMMAND_ID, messageKind: 'progress', messageSequence: 1 },
    }
    const aliasedRetained = retainedEvidence({
      effects: aliasedEffects,
      receipts: [retainedReceipts()[0], retainedReceipts()[2]],
    })
    const aliased = assessReplacementCompatibility(
      fixtureEnvelope(
        aliasedRetained,
        proposedEvidence({ effects: toProposed([aliasedEffects[1], aliasedEffects[2]]) })
      )
    )
    expect(aliased.outcome).toBe('evidence-divergent')
    expect(
      (findingFor(aliased, 'receipt_linkage')?.rejections ?? []).some(
        (rejection) =>
          rejection.family === 'ambiguous_effect' &&
          rejection.detail.includes('share one retained receipt identity')
      )
    ).toBe(true)

    // One retained effect claimed by TWO receipt identities: two receipts
    // assert the same effect frame hash, so no receipt can be ruled out as
    // the effect's source. The unclaimed twin is also a cardinality mismatch.
    const twinEffects = [retainedEffects()[0], retainedEffects()[2]]
    const twinReceipts = [
      retainedReceipts()[0],
      {
        commandId: COMMAND_ID,
        messageKind: 'progress',
        messageSequence: 4,
        frameHash: hex(6),
        outcome: 'applied',
      },
      retainedReceipts()[2],
    ]
    const twin = assessReplacementCompatibility(
      fixtureEnvelope(
        retainedEvidence({ effects: twinEffects, receipts: twinReceipts }),
        proposedEvidence({ effects: toProposed(twinEffects) })
      )
    )
    expect(twin.outcome).toBe('evidence-divergent')
    expect(
      (findingFor(twin, 'receipt_linkage')?.rejections ?? []).some(
        (rejection) =>
          rejection.family === 'ambiguous_effect' &&
          rejection.detail.includes('claim the same effect frame hash')
      )
    ).toBe(true)
    expect(familiesOf(twin)).toContain('missing_evidence')

    // Cardinality mismatch: a retained receipt no effect references cannot be
    // accounted for; effects cannot disappear through aliasing in either
    // direction.
    const mismatch = assessReplacementCompatibility(
      fixtureEnvelope(
        retainedEvidence({
          receipts: [
            ...retainedReceipts(),
            {
              commandId: COMMAND_ID,
              messageKind: 'progress',
              messageSequence: 5,
              frameHash: hex('9'),
              outcome: 'applied',
            },
          ],
        })
      )
    )
    expect(mismatch.outcome).toBe('evidence-divergent')
    expect(
      (findingFor(mismatch, 'receipt_linkage')?.rejections ?? []).some(
        (rejection) =>
          rejection.family === 'missing_evidence' &&
          rejection.detail.includes('not referenced by any retained effect')
      )
    ).toBe(true)
  })

  test('missing evidence is rejected with typed reasons instead of throwing', () => {
    const noApproval = assessReplacementCompatibility(
      fixtureEnvelope(retainedEvidence({ approvals: [] }))
    )
    expect(familiesOf(noApproval)).toContain('missing_evidence')

    const noSettlement = assessReplacementCompatibility(
      fixtureEnvelope(retainedEvidence({ settlements: [], restarts: [] }))
    )
    expect(familiesOf(noSettlement)).toContain('missing_evidence')

    const orphanLink = proposedEvidence({
      effects: [
        ...proposedEffects(),
        {
          operation: 'authorized-write:unknown',
          effectKey: deriveTaskEffectKey({
            workflowId: WORKFLOW_ID,
            lifecyclePolicyVersion: POLICY_VERSION,
            operation: 'authorized-write:unknown',
          }),
          kind: 'authorized_write',
          receipt: { commandId: COMMAND_ID, messageKind: 'progress', messageSequence: 99 },
        },
      ],
    })
    const missingReceipt = assessReplacementCompatibility(
      fixtureEnvelope(retainedEvidence(), orphanLink)
    )
    expect(familiesOf(missingReceipt)).toContain('missing_evidence')

    const malformed = assessReplacementCompatibility({ provenance: {}, retained: {} })
    expect(malformed.outcome).toBe('evidence-divergent')
    expect(malformed.rejections).toHaveLength(1)
    expect(malformed.rejections[0]?.family).toBe('malformed_evidence')
    expect(malformed.evidenceProvenance).toBe('unverified')
    expect(malformed.qualification).toBe('not-qualified')
    expect(findingFor(malformed, 'evidence_provenance')?.outcome).toBe('divergent')
    expect(
      malformed.axes
        .filter((finding) => finding.axis !== 'evidence_provenance')
        .every((finding) => finding.outcome === 'not_assessed')
    ).toBe(true)
  })

  test('unhashable evidence inputs return a typed rejection, never a throw or an echo', () => {
    const cases = [
      ['date', () => new Date('2026-02-01T00:00:00.000Z')],
      ['bigint', () => ({ provenance: { evidenceKind: 1n } })],
      [
        'cyclic',
        () => {
          const cyclic = {}
          cyclic.self = cyclic
          return cyclic
        },
      ],
    ]
    const digests = new Set()
    for (const [, build] of cases) {
      const report = assessReplacementCompatibility(build())
      expect(report.outcome).toBe('evidence-divergent')
      expect(report.rejections).toHaveLength(1)
      expect(report.rejections[0]?.family).toBe('malformed_evidence')
      expect(report.evidenceProvenance).toBe('unverified')
      expect(report.qualification).toBe('not-qualified')
      expect(report.subject.retainedEvidenceDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
      digests.add(report.subject.retainedEvidenceDigest)
      const serialized = JSON.stringify(report)
      // The typed rejection never echoes the offending value: no input Date
      // string, no BigInt digit run, no cyclic structure marker.
      expect(serialized).not.toContain('2026-02-01T00:00:00.000Z')
      expect(serialized).not.toContain('[object Object]')
    }
    // Unhashable inputs hash a fixed, value-free marker: the digest carries no
    // echo of the rejected input and stays deterministic across shapes.
    expect(digests.size).toBe(1)
  })

  test('stale approval bindings are rejected', () => {
    const staleRevision = assessReplacementCompatibility(
      fixtureEnvelope(
        retainedEvidence({
          approvalSubject: { ...approvalSubject(), revision: 8 },
        })
      )
    )
    expect(familiesOf(staleRevision)).toContain('stale_evidence')

    const unboundDigest = assessReplacementCompatibility(
      fixtureEnvelope(
        retainedEvidence({
          approvalSubject: { ...approvalSubject(), contentDigest: hex('c') },
        })
      )
    )
    expect(familiesOf(unboundDigest)).toContain('stale_evidence')
    expect(findingFor(unboundDigest, 'approval_before_effect')?.rejections[0]?.detail).toContain(
      'pinned implementation digest'
    )
  })

  test('the proposed approval subject must match the subject the accepted decision covers', () => {
    for (const mutated of [
      { ...approvalSubject(), revision: 8 },
      { ...approvalSubject(), versionId: `pfv_${'D'.repeat(26)}` },
      { ...approvalSubject(), contentDigest: hex('c') },
    ]) {
      const report = assessReplacementCompatibility(
        fixtureEnvelope(retainedEvidence(), proposedEvidence({ approvalSubject: mutated }))
      )
      expect(report.outcome).toBe('evidence-divergent')
      const finding = findingFor(report, 'approval_before_effect')
      expect(finding?.outcome).toBe('divergent')
      expect(finding?.rejections.map((rejection) => rejection.family)).toContain('version_drift')
      expect(
        finding?.rejections.some((rejection) =>
          rejection.detail.includes('the subject the accepted decision covers')
        )
      ).toBe(true)
    }
  })

  test('approval-before-effect ordering is enforced', () => {
    const lateApproval = assessReplacementCompatibility(
      fixtureEnvelope(
        retainedEvidence({ approvals: approvals('approved', '2026-02-01T11:00:00.000Z') })
      )
    )
    expect(lateApproval.outcome).toBe('evidence-divergent')
    expect(findingFor(lateApproval, 'approval_before_effect')?.rejections[0]?.family).toBe(
      'ordering_violation'
    )
  })

  test('effect keys must be stable and derived', () => {
    const undecivedRetained = retainedEvidence()
    undecivedRetained.effects = [
      { ...undecivedRetained.effects[0], effectKey: `${WORKFLOW_ID}:other-policy:progress:1` },
      ...undecivedRetained.effects.slice(1),
    ]
    const undecived = assessReplacementCompatibility(fixtureEnvelope(undecivedRetained))
    expect(familiesOf(undecived)).toContain('unstable_effect_key')

    const keyMismatch = proposedEvidence({
      effects: proposedEffects().map((effect) =>
        effect.operation === 'authorized-write:primary'
          ? { ...effect, effectKey: `${EFFECT_KEY_PREFIX}authorized-write:renamed` }
          : effect
      ),
    })
    const driftedKeys = assessReplacementCompatibility(
      fixtureEnvelope(retainedEvidence(), keyMismatch)
    )
    expect(familiesOf(driftedKeys)).toContain('unstable_effect_key')

    const policyDrift = assessReplacementCompatibility(
      fixtureEnvelope(
        retainedEvidence(),
        proposedEvidence({ lifecyclePolicyVersion: 'execution-lifecycle-v2' })
      )
    )
    expect(familiesOf(policyDrift)).toContain('unstable_effect_key')
  })

  test('non-fixture provenance is rejected and nothing else is assessed', () => {
    const envelope = fixtureEnvelope()
    envelope.provenance = { ...envelope.provenance, evidenceKind: 'reviewed-inventory' }
    const report = assessReplacementCompatibility(envelope)
    expect(report.outcome).toBe('evidence-divergent')
    expect(familiesOf(report)).toEqual(['invalid_provenance'])
    expect(findingFor(report, 'evidence_provenance')?.outcome).toBe('divergent')
    expect(
      report.axes
        .filter((finding) => finding.axis !== 'evidence_provenance')
        .every((finding) => finding.outcome === 'not_assessed')
    ).toBe(true)
    expect(report.evidenceProvenance).toBe('unverified')
    expect(report.qualification).toBe('not-qualified')
  })

  test('a fixture-derived equivalent verdict stays labelled as fixture evidence only', () => {
    const report = assessReplacementCompatibility(fixtureEnvelope())
    expect(report.outcome).toBe('evidence-equivalent')
    expect(report.evidenceProvenance).toBe('fixture')
    expect(report.qualification).toBe('fixture-evidence-only')
    expect(report.qualification).not.toContain('qualified')
    expect(report.qualification).toContain('fixture')
    expect(JSON.stringify(report)).toContain('fixture-evidence-only')
  })
})

describe('the compatibility report exposes no authorization affordance', () => {
  const reports = [
    assessReplacementCompatibility(fixtureEnvelope()),
    assessReplacementCompatibility({ provenance: {}, retained: {} }),
    assessReplacementCompatibility({
      ...fixtureEnvelope(),
      provenance: { evidenceKind: 'live', fixtureId: 'x', generatedAt: '2026-02-01T12:00:00.000Z' },
    }),
    assessReplacementCompatibility(
      fixtureEnvelope(retainedEvidence({ graphReference: graphReference('revoked') }))
    ),
  ]

  const ALLOWED_KEYS = new Set([
    'report',
    'evidenceProvenance',
    'qualification',
    'subject',
    'workflowId',
    'retainedEvidenceDigest',
    'proposedEvidenceDigest',
    'outcome',
    'axes',
    'rejections',
    'advisory',
    'reportOnly',
    'authorizesExecution',
    'authorizesAdoption',
    'authorizesDraining',
    'authorizesRetirement',
    'authorizesCheckpointConversion',
    'axis',
    'family',
    'reference',
    'detail',
  ])

  const walk = (value, visit) => {
    visit(value)
    if (value !== null && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) {
        visit(key)
        walk(entry, visit)
      }
    }
  }

  test('reports are deeply frozen plain data', () => {
    for (const report of reports) {
      expect(Object.isFrozen(report)).toBe(true)
      expect(Object.isFrozen(report.advisory)).toBe(true)
      expect(Object.isFrozen(report.subject)).toBe(true)
      for (const finding of report.axes) expect(Object.isFrozen(finding)).toBe(true)
      expect(() => {
        'use strict'
        report.outcome = 'evidence-equivalent'
      }).toThrow()
    }
  })

  test('reports carry no functions, handles, or keys outside the closed report schema', () => {
    const collectKeys = (value, into) => {
      if (value === null || typeof value !== 'object') return into
      if (Array.isArray(value)) {
        for (const entry of value) collectKeys(entry, into)
        return into
      }
      for (const [key, entry] of Object.entries(value)) {
        into.add(key)
        collectKeys(entry, into)
      }
      return into
    }
    for (const report of reports) {
      walk(report, (value) => {
        expect(typeof value).not.toBe('function')
      })
      const keys = collectKeys(report, new Set())
      for (const key of keys) expect(ALLOWED_KEYS.has(key)).toBe(true)
    }
  })

  test('the advisory block types every authorization affordance as literal false', () => {
    for (const report of reports) {
      expect(report.advisory).toEqual({
        reportOnly: true,
        authorizesExecution: false,
        authorizesAdoption: false,
        authorizesDraining: false,
        authorizesRetirement: false,
        authorizesCheckpointConversion: false,
      })
      expect(JSON.stringify(report)).not.toContain('authorize: true')
      expect(JSON.stringify(report)).not.toContain('"authorizes":true')
    }
  })

  test('outcomes and rejection families stay within the advisory vocabulary', () => {
    const outcomes = new Set(['evidence-equivalent', 'evidence-divergent'])
    const families = new Set([
      'malformed_evidence',
      'invalid_provenance',
      'missing_evidence',
      'stale_evidence',
      'version_drift',
      'revoked_authority',
      'ordering_violation',
      'unstable_effect_key',
      'ambiguous_effect',
      'conflicting_receipt',
      'settlement_ambiguity',
    ])
    for (const report of reports) {
      expect(outcomes.has(report.outcome)).toBe(true)
      for (const rejection of report.rejections) {
        expect(families.has(rejection.family)).toBe(true)
      }
    }
  })

  test('the module surface is schemas plus pure reporters, never an authorizer', () => {
    expect(typeof assessReplacementCompatibility).toBe('function')
    expect(typeof deriveTaskEffectKey).toBe('function')
    expect(typeof replacementCompatibilityAxes).toBe('object')
    // The report is synchronous plain data: no promise, no callable payload.
    const report = assessReplacementCompatibility(fixtureEnvelope())
    expect(report instanceof Promise).toBe(false)
    expect(typeof report.then).toBe('undefined')
  })
})
