import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { URL } from 'node:url'
import {
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
  test('covers every normative source and prior milestone', async () => {
    const result = await validateRequirementsLedger(ledger, {
      repositoryRoot: new URL('..', import.meta.url),
    })

    expect(result.errors).toEqual([])
    expect(ledger.sources.map(({ title }) => title).sort()).toEqual(normativeSources.sort())
    expect(new Set(ledger.requirements.map(({ sourceId }) => sourceId))).toEqual(
      new Set(ledger.sources.map(({ id }) => id))
    )
    expect(
      [...new Set(ledger.priorMilestoneAudits.map(({ milestone }) => milestone))].sort()
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
    delete missingSourceOwnership.sources.find(
      ({ retrievalStatus }) => retrievalStatus === 'missing'
    ).gap
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
      expect(typeof row.gap.issue, row.id).toBe('number')
      expect(row.gap.severity, row.id).toMatch(/^(critical|high|medium|low)$/)
      expect(typeof row.gap.owner, row.id).toBe('string')
      expect(typeof row.gap.disposition, row.id).toBe('string')
    }
  })

  test('identifies all deployment profiles and verification evidence', () => {
    expect(ledger.deploymentProfiles.map(({ id }) => id).sort()).toEqual([
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
