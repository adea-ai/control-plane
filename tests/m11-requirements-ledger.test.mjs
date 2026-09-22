import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { URL } from 'node:url'
import {
  listGitHubIssues,
  refreshPriorMilestoneAudits,
  validateRequirementsLedger,
  renderRequirementsReport,
} from '../scripts/requirements-ledger.mjs'

const ledgerUrl = new URL(
  '../docs/requirements/control-plane-requirements.v1.json',
  import.meta.url
)
const reportUrl = new URL('../docs/requirements/control-plane-requirements.md', import.meta.url)
const ledger = JSON.parse(await readFile(ledgerUrl, 'utf8'))
const clone = (value) => JSON.parse(JSON.stringify(value))

const normativeSources = [
  'Project Index',
  'Agent HQ PRD',
  'Control Plane PRD',
  'Cortana PRD',
  'System Architecture Overview',
  'Control Plane TDD',
  'Agent & Skill Specification',
  'Data Model & API Specification',
  'RuntimeNode & Desktop Protocol Specification',
  'Execution Consistency & Event Delivery Specification',
  'Artifact Storage Specification',
  'Security & Trust Model',
  'Evaluation & Benchmarking Plan',
  'Runtime Compatibility Matrix',
  'Architecture Decision Records',
]

describe('M11.1 requirements ledger', () => {
  test('maps exactly the bounded Control Plane PRD sections 8.1-8.3', () => {
    const expectedIds = [
      'CP-PRD-PROFILE-CREATE-001',
      'CP-PRD-PROFILE-VERSION-001',
      'CP-PRD-PROFILE-VALIDATE-001',
      'CP-PRD-PROFILE-APPROVE-001',
      'CP-PRD-PROFILE-DEPRECATE-001',
      'CP-PRD-PROFILE-INSPECT-001',
      'CP-PRD-PRECEDENCE-001',
      'CP-PRD-PLAN-COMPILATION-001',
      'CP-PRD-CONFIG-PROVENANCE-001',
      'CP-PRD-COMPATIBILITY-REASONS-001',
      'CP-PRD-IDEMPOTENT-COMMANDS-001',
      'CP-PRD-LIFECYCLE-STATES-001',
      'CP-PRD-RESTART-RECOVERY-001',
      'CP-PRD-NETWORK-RECOVERY-001',
      'CP-PRD-INSPECTABLE-RECORDS-001',
      'CP-PRD-RUNTIME-DISCOVERY-001',
      'CP-PRD-RUNTIME-ELIGIBILITY-001',
      'CP-PRD-MANAGED-PI-001',
      'CP-PRD-ACP-INTEROPERABILITY-001',
      'CP-PRD-HARNESS-OWNERSHIP-001',
      'CP-PRD-SESSION-CAPABILITIES-001',
    ]
    const rows = ledger.requirements.filter(({ id }) => expectedIds.includes(id))
    expect(rows.map(({ id }) => id)).toEqual(expectedIds)
    expect(rows).toHaveLength(21)
    for (const row of rows) {
      expect(row.sourceId).toBe('control-plane-prd')
      expect(row.heading).toMatch(/\(P000(?:78|79|80|81|83|84|85|86|88|89|90|91|92)\)$/)
      expect(row.issueRefs).toContain(195)
    }
    expect(ledger.requirements.find(({ id }) => id === 'CP-PRD-PROFILE-APPROVE-001')).toMatchObject(
      {
        classification: 'tbd',
        gap: { issue: 188 },
      }
    )
    expect(ledger.requirements.find(({ id }) => id === 'CP-PRD-PROFILE-APPROVE-001')).toMatchObject(
      {
        requirement: 'Approve AgentProfiles and Skills.',
        heading: 'Profiles, Skills, and Execution Planning (P00078)',
      }
    )
    expect(ledger.requirements.find(({ id }) => id === 'CP-PRD-RETRIEVAL-001')).toMatchObject({
      gap: { issue: 195 },
    })
  })

  test('retains individually extracted native host and local-content boundaries', () => {
    const expected = [
      ['024', 'Native invocation boundary (section 11)'],
      ['025', 'Constrained process launch (section 11)'],
      ['026', 'Opaque credential access (section 11)'],
      ['027', 'Protected key-role exclusion (section 11)'],
      ['028', 'Bounded local context requests (section 12)'],
      ['029', 'Explicit local-content promotion (section 12)'],
      ['030', 'Provider revocation without data deletion (section 12.1)'],
    ]
    for (const [suffix, heading] of expected) {
      const row = ledger.requirements.find(({ id }) => id === `CP-RNODE-${suffix}`)
      expect(row).toMatchObject({
        sourceId: 'runtime-node-spec',
        normativeState: 'accepted',
        heading,
      })
      expect(row.issueRefs).toContain(186)
      expect(row.issueRefs).toContain(190)
    }
  })

  test('retains extracted Control Plane PRD capability obligations and anchors', () => {
    const expected = [
      ['CP-PRD-CONNECTOR-AUTH-001', 'P00095'],
      ['CP-PRD-CREDENTIAL-BOUNDARY-001', 'P00096'],
      ['CP-PRD-PROVIDER-SCOPE-001', 'P00097'],
      ['CP-PRD-TOOL-BRIDGE-001', 'P00098'],
      ['CP-PRD-EXTERNAL-TOOL-BRIDGE-001', 'P00098'],
      ['CP-PRD-NO-REUSABLE-SECRETS-001', 'P00099'],
      ['CP-PRD-PROVIDER-AUTH-001', 'P00100'],
      ['CP-PRD-MODEL-ROUTING-001', 'P00103'],
      ['CP-PRD-CREDENTIAL-MODES-001', 'P00104'],
      ['CP-PRD-USAGE-BUDGETS-001', 'P00105'],
      ['CP-PRD-ATTEMPT-USAGE-001', 'P00105'],
      ['CP-PRD-AUTHORITATIVE-USAGE-001', 'P00105'],
      ['CP-PRD-MODEL-PROVENANCE-001', 'P00106'],
      ['CP-PRD-SANDBOX-001', 'P00108'],
      ['CP-PRD-LOCAL-TRANSPORT-001', 'P00109'],
      ['CP-PRD-REMOTE-GATEWAY-ONLY-001', 'P00109'],
      ['CP-PRD-LOCAL-PATH-BOUNDARY-001', 'P00109'],
      ['CP-PRD-LOCAL-DATA-BOUNDARY-001', 'P00110'],
      ['CP-PRD-OUTPUT-PROMOTION-001', 'P00111'],
      ['CP-PRD-DURABLE-INTERACTIONS-001', 'P00113'],
      ['CP-PRD-NORMALIZED-INTERACTION-UX-001', 'P00114'],
      ['CP-PRD-EXPLICIT-APPROVAL-001', 'P00115'],
      ['CP-PRD-DIRECT-DEFAULT-001', 'P00117'],
      ['CP-PRD-DELEGATION-CRITERIA-001', 'P00118'],
      ['CP-PRD-GRAPH-ORCHESTRATION-001', 'P00119'],
      ['CP-PRD-GRAPH-AUTHORITY-001', 'P00120'],
      ['CP-PRD-OUTCOME-ATTRIBUTION-001', 'P00122'],
      ['CP-PRD-COMPAT-EVIDENCE-001', 'P00123'],
      ['CP-PRD-BASELINE-COMPARISON-001', 'P00124'],
      ['CP-PRD-FAILED-GATE-PROMOTION-001', 'P00125'],
      ['CP-PRD-PUBLIC-CONTRACTS-001', 'P00127'],
      ['CP-PRD-CONTRACT-INDEPENDENCE-001', 'P00128'],
      ['CP-PRD-DETERMINISTIC-STUBS-001', 'P00129'],
      ['CP-PRD-SERVICE-AUTH-001', 'P00130'],
      ['CP-PRD-API-IDEMPOTENCY-001', 'P00130'],
      ['CP-PRD-API-PAGINATION-001', 'P00130'],
      ['CP-PRD-API-COMPATIBILITY-001', 'P00130'],
      ['CP-PRD-API-TRACE-CORRELATION-001', 'P00130'],
    ]
    for (const [id, anchor] of expected) {
      const row = ledger.requirements.find((entry) => entry.id === id)
      expect(row?.sourceId).toBe('control-plane-prd')
      expect(row.heading).toContain(anchor)
      expect(row.issueRefs).toContain(195)
    }
  })

  test('distinguishes the recorded audit baseline from later scoped evidence', async () => {
    const report = await renderRequirementsReport(ledger)
    expect(report).toContain('not the current branch head')
    expect(report).toContain(
      'does not re-certify that baseline or establish whole-milestone completion'
    )
  })

  test('covers every normative source and prior milestone', async () => {
    const result = await validateRequirementsLedger(ledger, {
      repositoryRoot: new URL('..', import.meta.url),
    })

    expect(result.errors).toEqual([])
    expect(ledger.sources.map(({ title }) => title).toSorted()).toEqual(normativeSources.toSorted())
    expect(new Set(ledger.requirements.map(({ sourceId }) => sourceId))).toEqual(
      new Set(ledger.sources.map(({ id }) => id))
    )
    expect(
      [...new Set(ledger.priorMilestoneAudits.map(({ milestone }) => milestone))].toSorted()
    ).toEqual(['M1', 'M10', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9'])
    expect(ledger.priorMilestoneAudits.some(({ issue }) => issue === 73)).toBe(true)
    for (const issue of Array.from({ length: 18 }, (_, index) => 200 + index)) {
      expect(
        ledger.priorMilestoneAudits.some((entry) => entry.issue === issue),
        `issue #${issue}`
      ).toBe(true)
    }
  })

  test('fails closed when authoritative inventory or provenance disappears', async () => {
    const pendingReview = clone(ledger)
    pendingReview.reviewerSamples[0].result = 'pending independent rerun'
    expect(
      (
        await validateRequirementsLedger(pendingReview, {
          repositoryRoot: new URL('..', import.meta.url),
        })
      ).errors
    ).toContain('independent M11.1 acceptance reviewer: reviewer result cannot be pending')

    const fictionalCandidate = clone(ledger)
    fictionalCandidate.candidate.commit = 'f'.repeat(40)
    fictionalCandidate.verificationRuns.forEach((run) => {
      run.commit = fictionalCandidate.candidate.commit
    })
    fictionalCandidate.reviewerSamples.forEach((sample) => {
      sample.commit = fictionalCandidate.candidate.commit
    })
    expect(
      (
        await validateRequirementsLedger(fictionalCandidate, {
          repositoryRoot: new URL('..', import.meta.url),
          shallowRepository: false,
        })
      ).errors
    ).toContain('candidate.commit must exist in the repository')

    const emptyProfiles = clone(ledger)
    emptyProfiles.deploymentProfiles = []
    expect(
      (
        await validateRequirementsLedger(emptyProfiles, {
          repositoryRoot: new URL('..', import.meta.url),
        })
      ).errors
    ).toContain('deploymentProfiles must contain cloud, local, hosted-simple, and hosted-server')

    const missingRequirement = clone(ledger)
    missingRequirement.requirements.pop()
    expect(
      (
        await validateRequirementsLedger(missingRequirement, {
          repositoryRoot: new URL('..', import.meta.url),
        })
      ).errors
    ).toContain(
      'requirementInventory and requirements must contain the same stable IDs and sources'
    )

    const missingAudit = clone(ledger)
    missingAudit.priorMilestoneAudits.pop()
    expect(
      (
        await validateRequirementsLedger(missingAudit, {
          repositoryRoot: new URL('..', import.meta.url),
        })
      ).errors
    ).toContain('priorIssueInventory and priorMilestoneAudits must contain the same issue IDs')

    const missingSourceOwnership = clone(ledger)
    missingSourceOwnership.sources[0].retrievalStatus = 'missing'
    delete missingSourceOwnership.sources[0].gap
    expect(
      (
        await validateRequirementsLedger(missingSourceOwnership, {
          repositoryRoot: new URL('..', import.meta.url),
        })
      ).errors.some((error) => error.includes('source gap'))
    ).toBe(true)

    const unknownLane = clone(ledger)
    unknownLane.requirements[0].lane = 'miscellaneous'
    expect(
      (
        await validateRequirementsLedger(unknownLane, {
          repositoryRoot: new URL('..', import.meta.url),
        })
      ).errors
    ).toContain(`${unknownLane.requirements[0].id}: invalid validation lane miscellaneous`)
  })

  test('loads live issue state without requiring the gh CLI', async () => {
    const requests = []
    const issues = await listGitHubIssues({
      repository: 'owner/repository',
      token: 'test-token',
      fetch: async (url, init) => {
        requests.push({ url, init })
        return {
          ok: true,
          json: async () => [
            {
              number: 188,
              title: 'Gap owner',
              state: 'open',
              milestone: { title: 'M11: Feature Completion & Production Audit' },
              html_url: 'https://github.com/owner/repository/issues/188',
              closed_at: null,
            },
            { number: 584, title: 'Pull request', state: 'open', pull_request: {} },
          ],
        }
      },
    })

    expect(issues).toEqual([
      {
        number: 188,
        title: 'Gap owner',
        state: 'OPEN',
        milestone: { title: 'M11: Feature Completion & Production Audit' },
        url: 'https://github.com/owner/repository/issues/188',
        closedAt: null,
      },
    ])
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      url: 'https://api.github.com/repos/owner/repository/issues?state=all&per_page=100&page=1',
      init: { headers: { authorization: 'Bearer test-token' } },
    })
  })

  test('reports every gap whose live issue is not open in M11', () => {
    const issueStateFixture = {
      sources: [],
      deploymentProfiles: [{ gap: { issue: 188 } }, { gap: { issue: 194 } }],
      requirements: [],
      priorIssueInventory: [],
      priorMilestoneAudits: [],
    }

    expect(() =>
      refreshPriorMilestoneAudits(
        issueStateFixture,
        [
          {
            number: 188,
            state: 'CLOSED',
            milestone: { title: 'M11: Feature Completion & Production Audit' },
          },
          {
            number: 192,
            state: 'CLOSED',
            milestone: { title: 'M11: Feature Completion & Production Audit' },
          },
          {
            number: 194,
            state: 'OPEN',
            milestone: { title: 'M12: Cross-Product Integration & Release' },
          },
          {
            number: 197,
            state: 'OPEN',
            milestone: { title: 'M11: Feature Completion & Production Audit' },
          },
        ],
        [192]
      )
    ).toThrow(
      'Gap issues must be open and assigned to M11: #188 (CLOSED, M11: Feature Completion & Production Audit), #194 (OPEN, M12: Cross-Product Integration & Release), #192 (CLOSED, M11: Feature Completion & Production Audit)'
    )
  })

  test('keeps the final audit gate open while ledger gaps remain', () => {
    const ledgerWithGap = {
      sources: [],
      deploymentProfiles: [],
      requirements: [{ gap: { issue: 188 } }],
      priorIssueInventory: [],
      priorMilestoneAudits: [],
    }

    expect(() =>
      refreshPriorMilestoneAudits(ledgerWithGap, [
        {
          number: 188,
          state: 'OPEN',
          milestone: { title: 'M11: Feature Completion & Production Audit' },
        },
        {
          number: 197,
          state: 'CLOSED',
          milestone: { title: 'M11: Feature Completion & Production Audit' },
        },
      ])
    ).toThrow(
      'Gap issues must be open and assigned to M11: #197 (CLOSED, M11: Feature Completion & Production Audit)'
    )
  })

  test('reports only the explicit provenance warning when history is shallow', async () => {
    const result = await validateRequirementsLedger(ledger, {
      repositoryRoot: new URL('..', import.meta.url),
    })

    expect(result.warnings.length).toBeLessThanOrEqual(1)
    for (const warning of result.warnings) {
      expect(warning).toBe(
        `candidate commit ${ledger.candidate.commit} is unavailable in this shallow checkout; committed-artifact provenance must be reproduced from a full clone`
      )
    }
  })

  test('distinguishes shallow history from a missing full-clone candidate', async () => {
    const fictionalCandidate = clone(ledger)
    fictionalCandidate.candidate.commit = 'f'.repeat(40)
    fictionalCandidate.verificationRuns.forEach((run) => {
      run.commit = fictionalCandidate.candidate.commit
    })
    fictionalCandidate.reviewerSamples.forEach((sample) => {
      sample.commit = fictionalCandidate.candidate.commit
    })

    const result = await validateRequirementsLedger(fictionalCandidate, {
      repositoryRoot: new URL('..', import.meta.url),
      shallowRepository: true,
    })

    expect(result.errors).not.toContain('candidate.commit must exist in the repository')
    expect(result.warnings).toContain(
      `candidate commit ${fictionalCandidate.candidate.commit} is unavailable in this shallow checkout; committed-artifact provenance must be reproduced from a full clone`
    )
  })

  test('records actionable disposition for every non-verified row', () => {
    for (const row of [...ledger.requirements, ...ledger.priorMilestoneAudits]) {
      if (row.classification === 'verified') continue
      // Superseded rows carry their supersession record as the disposition and
      // are exempt from gap references (validateGap), mirroring that exemption.
      if (row.classification === 'superseded') continue
      expect(typeof row.gap.issue, row.id).toBe('number')
      expect(row.gap.severity, row.id).toMatch(/^(critical|high|medium|low)$/)
      expect(typeof row.gap.owner, row.id).toBe('string')
      expect(typeof row.gap.disposition, row.id).toBe('string')
    }
  })

  test('exempts superseded rows from gap references', () => {
    for (const row of [...ledger.requirements, ...ledger.priorMilestoneAudits]) {
      if (row.classification !== 'superseded') continue
      expect(row.gap, row.id).toBeUndefined()
    }
  })

  test('identifies all deployment profiles and verification evidence', () => {
    expect(ledger.deploymentProfiles.map(({ id }) => id).toSorted()).toEqual([
      'cloud',
      'hosted-server',
      'hosted-simple',
      'local',
    ])
    for (const row of ledger.requirements) {
      expect(row.lane, row.id).toBeString()
      expect(row.evidence.length, row.id).toBeGreaterThan(0)
    }
  })

  test('keeps the generated report in sync', async () => {
    expect(await readFile(reportUrl, 'utf8')).toBe(await renderRequirementsReport(ledger))
  })
})
