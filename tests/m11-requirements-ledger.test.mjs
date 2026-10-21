import { describe, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  collectCanonicalCrosswalk,
  collectFigureInventory,
  compareGitHubIssueSnapshot,
  listGitHubIssues,
  pinnedFormatterVersion,
  refreshGitHubIssueSnapshot,
  refreshPriorMilestoneAudits,
  renderCanonicalCrosswalk,
  renderFigureInventory,
  renderRequirementsReport,
  runningFormatterVersion,
  validateCanonicalCrosswalk,
  validateFigureInventory,
  validateFormatterVersion,
  validateReconciliationRecord,
  validateRequirementsLedger,
} from '../scripts/requirements-ledger.mjs'

const ledgerUrl = new URL(
  '../docs/requirements/control-plane-requirements.v1.json',
  import.meta.url
)
const reportUrl = new URL('../docs/requirements/control-plane-requirements.md', import.meta.url)
const crosswalkUrl = new URL(
  '../docs/requirements/control-plane-requirements-crosswalk.v1.json',
  import.meta.url
)
const figureInventoryUrl = new URL(
  '../docs/requirements/canonical-figure-inventory.v1.json',
  import.meta.url
)
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const ledger = JSON.parse(await readFile(ledgerUrl, 'utf8'))
const clone = (value) => JSON.parse(JSON.stringify(value))
const emptyIssueLedger = () => ({
  sources: [],
  deploymentProfiles: [],
  requirements: [],
  priorIssueInventory: [],
  priorMilestoneAudits: [],
})
const canonicalIssue = (number, milestone = 11, changes = {}) => ({
  number,
  state: 'OPEN',
  title: `Issue ${number}`,
  closedAt: null,
  url: `https://github.com/adea-ai/control-plane/issues/${number}`,
  milestone: { number: milestone, title: 'Roadmap display title can change' },
  ...changes,
})
const ghCliOutput = (status, body, headers = {}) =>
  [
    `HTTP/2.0 ${status} ${status === 200 ? 'OK' : 'Failure'}`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    '',
    JSON.stringify(body),
  ].join('\r\n')

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
  test('renamed or translated M11 titles preserve canonical repository milestone authority', () => {
    const input = emptyIssueLedger()
    input.requirements.push({ id: 'legacy', gap: { issue: 188 } })
    for (const title of ['09 · M11: Feature Completion & Production Audit', '审计']) {
      expect(
        refreshPriorMilestoneAudits(input, [
          canonicalIssue(188, 11, { milestone: { number: 11, title } }),
          canonicalIssue(197),
        ]).requirements
      ).toEqual(input.requirements)
    }
  })

  test('gap state and repository/milestone identity fail closed despite an M11-looking title', () => {
    const input = emptyIssueLedger()
    input.requirements.push({ gap: { issue: 188 } })
    const spoofedTitle = 'M11: Feature Completion & Production Audit'
    for (const changes of [
      { state: 'CLOSED' },
      { url: 'https://github.com/another-owner/control-plane/issues/188' },
      { url: 'https://github.com/adea-ai/another-repository/issues/188' },
      { url: undefined },
      { milestone: { number: 10, title: spoofedTitle } },
      { milestone: { number: '11', title: spoofedTitle } },
      { milestone: { number: -11, title: spoofedTitle } },
      { milestone: { title: spoofedTitle } },
      { milestone: null },
    ]) {
      expect(() =>
        refreshPriorMilestoneAudits(input, [canonicalIssue(188, 11, changes), canonicalIssue(197)])
      ).toThrow('authorized Control Plane milestone')
    }
    expect(() => refreshPriorMilestoneAudits(input, [canonicalIssue(197)])).toThrow('#188 (MISSING')
  })

  test('only the explicitly authorized R2 architecture gap can use successor milestone 20', () => {
    const input = emptyIssueLedger()
    expect(
      refreshPriorMilestoneAudits(input, [canonicalIssue(931, 20), canonicalIssue(197)], [931])
        .requirements
    ).toEqual([])
    for (const issue of [
      canonicalIssue(931, 11),
      canonicalIssue(931, 20, { state: 'CLOSED' }),
      canonicalIssue(931, 20, { milestone: { title: 'M20' } }),
    ]) {
      expect(() => refreshPriorMilestoneAudits(input, [issue, canonicalIssue(197)], [931])).toThrow(
        'authorized Control Plane milestone'
      )
    }
    expect(() =>
      refreshPriorMilestoneAudits(input, [canonicalIssue(932, 20), canonicalIssue(197)], [932])
    ).toThrow('#932')
    input.requirements.push({ gap: { issue: 931 } })
    expect(() =>
      refreshPriorMilestoneAudits(input, [canonicalIssue(931, 20), canonicalIssue(197)], [931])
    ).toThrow('#931')
  })

  test('prior M10 inventory uses repository milestone 12 and excludes repository milestone 10', () => {
    const input = emptyIssueLedger()
    input.priorMilestoneAudits.push({ issue: 100, milestone: 'M10', assessment: 'preserved' })
    const refreshed = refreshPriorMilestoneAudits(input, [
      canonicalIssue(100, 12, {
        state: 'CLOSED',
        milestone: { number: 12, title: 'Reordered historical phase' },
      }),
      canonicalIssue(101, 10, { milestone: { number: 10, title: 'M10: Spoofed display title' } }),
    ])
    expect(
      refreshed.priorIssueInventory.map(({ issue, milestone }) => ({ issue, milestone }))
    ).toEqual([{ issue: 100, milestone: 'M10' }])
    expect(refreshed.priorMilestoneAudits[0].assessment).toBe('preserved')
  })

  test('a retrieved source cannot silently lose its atomic inventory', async () => {
    const changed = clone(ledger)
    delete changed.sources[0].atomicInventory
    const { errors } = await validateRequirementsLedger(changed)
    expect(errors).toContain('project-index: atomicInventory is required')
  }, 60000)

  test('atomic clause counts are checked beyond the bounded requirement rows', async () => {
    const changed = clone(ledger)
    changed.sources[0].atomicInventory.atoms -= 1
    const { errors } = await validateRequirementsLedger(changed)
    expect(errors).toContain('project-index: atomic inventory count differs from declared atoms')
  }, 60000)

  test('atomic inventory provenance must match the captured source revision and bytes', async () => {
    const changed = clone(ledger)
    changed.sources[0].atomicInventory.sourceRevision -= 1
    changed.sources[0].atomicInventory.contentSha256 = '0'.repeat(64)
    const { errors } = await validateRequirementsLedger(changed)
    expect(errors).toContain('project-index: atomic inventory revision differs from source')
    expect(errors).toContain('project-index: atomic inventory content hash differs from source')
  }, 60000)

  test('retention evidence distinguishes fail-closed deletion from scheduler doubles', async () => {
    const row = ledger.requirements.find(({ id }) => id === 'CP-CONS-003')
    const evidence = row.evidence.map(({ scope = '' }) => scope).join('\n')
    for (const [path, code] of [
      [
        'packages/database/src/command-inbox-repository.ts',
        'COMMAND_RETENTION_ELIGIBILITY_REQUIRED',
      ],
      [
        'packages/database/src/execution-event-repository.ts',
        'EVENT_RETENTION_ELIGIBILITY_REQUIRED',
      ],
      ['packages/sqlite-persistence/src/repositories.ts', 'COMMAND_RETENTION_ELIGIBILITY_REQUIRED'],
      [
        'packages/sqlite-persistence/src/durability-repositories.ts',
        'EVENT_RETENTION_ELIGIBILITY_REQUIRED',
      ],
    ]) {
      const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8')
      if (source.includes(`throw new Error('${code}')`)) {
        expect(evidence).toContain(code)
        expect(row.gap.disposition).toContain('fail closed')
        expect(evidence).not.toContain('physically deletes')
        expect(evidence).not.toContain('removes only past-retention')
      }
    }
    expect(
      row.evidence.find(({ path }) => path === 'packages/deployment/src/retention-sweep.test.mjs')
        .scope
    ).toContain('repository doubles')
  })

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
  }, 60000)

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
  }, 60000)

  test('ties checked-in partial source-audit ranges to their ledger rows', async () => {
    const auditedSources = ledger.sources.filter(({ sourceAudit }) => sourceAudit !== undefined)
    expect(auditedSources.map(({ id }) => id).toSorted()).toEqual([
      'execution-consistency-spec',
      'runtime-node-spec',
    ])
    for (const source of auditedSources) {
      expect(source.sourceAudit.coverage, source.id).toBe('partial')
    }

    const report = await renderRequirementsReport(ledger)
    expect(report).toContain(
      '[execution-consistency-source-audit.md](./execution-consistency-source-audit.md)'
    )
    expect(report).toContain('[runtime-node-source-audit.md](./runtime-node-source-audit.md)')
    expect(report.match(/partial extraction/g)).toHaveLength(2)

    const missingRequirement = clone(ledger)
    missingRequirement.requirements = missingRequirement.requirements.filter(
      ({ id }) => id !== 'CP-CONS-032'
    )
    missingRequirement.requirementInventory = missingRequirement.requirementInventory.filter(
      ({ id }) => id !== 'CP-CONS-032'
    )
    const missingResult = await validateRequirementsLedger(missingRequirement, {
      repositoryRoot: new URL('..', import.meta.url),
    })
    expect(missingResult.errors.join('\n')).toContain(
      'execution-consistency-spec: source-audit requirement IDs do not match ledger'
    )
    expect(missingResult.errors.join('\n')).toContain('missing from ledger: CP-CONS-032')

    const falselyComplete = clone(ledger)
    falselyComplete.sources.find(({ id }) => id === 'runtime-node-spec').sourceAudit.coverage =
      'complete'
    const incompleteResult = await validateRequirementsLedger(falselyComplete, {
      repositoryRoot: new URL('..', import.meta.url),
    })
    expect(incompleteResult.errors).toContain(
      'runtime-node-spec: checked-in source audit coverage must remain partial'
    )

    const escapingPath = clone(ledger)
    escapingPath.sources.find(({ id }) => id === 'runtime-node-spec').sourceAudit.path =
      'docs/requirements/../../package.json'
    const escapingPathResult = await validateRequirementsLedger(escapingPath, {
      repositoryRoot: new URL('..', import.meta.url),
    })
    expect(escapingPathResult.errors).toContain(
      'runtime-node-spec: source-audit path must be under docs/requirements'
    )
  }, 60000)

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
  }, 60000)

  test('loads live issue state without requiring the gh CLI', async () => {
    const requests = []
    const issues = await listGitHubIssues({
      repository: 'owner/repository',
      token: 'test-token',
      spawnSync: () => {
        throw new Error('GitHub CLI must not be used when a token and fetch seam are supplied')
      },
      fetch: async (url, init) => {
        requests.push({ url, init })
        return {
          ok: true,
          json: async () => [
            {
              number: 188,
              title: 'Gap owner',
              state: 'open',
              milestone: { number: 11, title: 'M11: Feature Completion & Production Audit' },
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
        milestone: { number: 11, title: 'M11: Feature Completion & Production Audit' },
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

  test('uses the authenticated GitHub CLI when no token or fetch seam is available', async () => {
    const calls = []
    const priorHost = process.env.GH_HOST
    const priorCi = process.env.CI
    const priorGitHubActions = process.env.GITHUB_ACTIONS
    process.env.GH_HOST = 'github.enterprise.example'
    delete process.env.CI
    delete process.env.GITHUB_ACTIONS
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      number: index + 1,
      title: `Issue ${index + 1}`,
      state: 'open',
      html_url: `https://github.com/owner/repository/issues/${index + 1}`,
    }))
    const secondPage = [
      {
        number: 101,
        title: 'Cursor issue',
        state: 'closed',
        html_url: 'https://github.com/owner/repository/issues/101',
        closed_at: '2026-10-09T00:00:00Z',
      },
    ]
    let issues
    try {
      issues = await listGitHubIssues({
        repository: 'owner/repository',
        token: '',
        spawnSync: (command, args, options) => {
          calls.push({ command, args, options })
          const first = calls.length === 1
          const headers = {}
          if (first) {
            headers.Link =
              '<https://api.github.com/repositories/42/issues?state=all&per_page=100&page=2&after=opaque%3D>; rel="next"'
          }
          return {
            status: 0,
            stdout: ghCliOutput(200, firstPageOrSecond(first), headers),
          }
        },
      })
    } finally {
      if (priorHost === undefined) delete process.env.GH_HOST
      else process.env.GH_HOST = priorHost
      if (priorCi === undefined) delete process.env.CI
      else process.env.CI = priorCi
      if (priorGitHubActions === undefined) delete process.env.GITHUB_ACTIONS
      else process.env.GITHUB_ACTIONS = priorGitHubActions
    }

    function firstPageOrSecond(first) {
      return first ? firstPage : secondPage
    }

    expect(issues).toHaveLength(101)
    expect(issues.at(-1)).toMatchObject({
      number: 101,
      state: 'CLOSED',
      closedAt: '2026-10-09T00:00:00Z',
    })
    expect(calls.map(({ command, args }) => [command, args.at(-1)])).toEqual([
      ['gh', '/repos/owner/repository/issues?state=all&per_page=100&page=1'],
      ['gh', '/repos/owner/repository/issues?state=all&per_page=100&page=2&after=opaque%3D'],
    ])
    expect(calls[0]).toMatchObject({
      args: [
        'api',
        '--include',
        '--hostname',
        'github.com',
        '--header',
        'Accept: application/vnd.github+json',
        '--header',
        'User-Agent: control-plane-requirements-ledger',
        expect.any(String),
      ],
      options: { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 30_000 },
    })
  })

  test('uses public REST fetch in tokenless CI without an injected fetch seam', async () => {
    const priorToken = process.env.GH_TOKEN
    const priorLegacyToken = process.env.GITHUB_TOKEN
    const priorCi = process.env.CI
    const priorGitHubActions = process.env.GITHUB_ACTIONS
    const priorFetch = globalThis.fetch
    const requests = []
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      number: index + 1,
      title: `Issue ${index + 1}`,
      state: 'open',
      html_url: `https://github.com/owner/repository/issues/${index + 1}`,
    }))
    const secondPage = [
      {
        number: 101,
        title: 'Public CI issue',
        state: 'open',
        html_url: 'https://github.com/owner/repository/issues/101',
      },
    ]
    delete process.env.GH_TOKEN
    delete process.env.GITHUB_TOKEN
    process.env.CI = 'true'
    process.env.GITHUB_ACTIONS = 'true'
    globalThis.fetch = async (url, init) => {
      const first = requests.length === 0
      requests.push({ url, init })
      return {
        ok: true,
        headers: new Headers(
          first
            ? {
                Link: '<https://api.github.com/repos/owner/repository/issues?state=all&per_page=100&page=2&after=opaque%3D>; rel="next"',
              }
            : {}
        ),
        json: async () => (first ? firstPage : secondPage),
      }
    }

    let issues
    try {
      issues = await listGitHubIssues({
        repository: 'owner/repository',
        token: '',
        spawnSync: () => {
          throw new Error('GitHub CLI must not be used in tokenless CI')
        },
      })
    } finally {
      if (priorToken === undefined) delete process.env.GH_TOKEN
      else process.env.GH_TOKEN = priorToken
      if (priorLegacyToken === undefined) delete process.env.GITHUB_TOKEN
      else process.env.GITHUB_TOKEN = priorLegacyToken
      if (priorCi === undefined) delete process.env.CI
      else process.env.CI = priorCi
      if (priorGitHubActions === undefined) delete process.env.GITHUB_ACTIONS
      else process.env.GITHUB_ACTIONS = priorGitHubActions
      globalThis.fetch = priorFetch
    }

    expect(issues).toHaveLength(101)
    expect(issues.at(-1)).toMatchObject({ number: 101, state: 'OPEN' })
    expect(requests.map(({ url }) => url)).toEqual([
      'https://api.github.com/repos/owner/repository/issues?state=all&per_page=100&page=1',
      'https://api.github.com/repos/owner/repository/issues?state=all&per_page=100&page=2&after=opaque%3D',
    ])
    expect(requests.map(({ init }) => init.headers.authorization)).toEqual([undefined, undefined])
  })

  test('uses the explicit token ahead of environment tokens in CI', async () => {
    const priorToken = process.env.GH_TOKEN
    const priorLegacyToken = process.env.GITHUB_TOKEN
    const priorCi = process.env.CI
    const priorGitHubActions = process.env.GITHUB_ACTIONS
    const priorFetch = globalThis.fetch
    const requests = []
    process.env.GH_TOKEN = 'environment-gh-token'
    process.env.GITHUB_TOKEN = 'environment-github-token'
    process.env.CI = 'true'
    process.env.GITHUB_ACTIONS = 'true'
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init })
      return { ok: true, headers: new Headers(), json: async () => [] }
    }

    try {
      await listGitHubIssues({
        repository: 'owner/repository',
        token: 'explicit-test-token',
        spawnSync: () => {
          throw new Error('GitHub CLI must not be used when a token is available')
        },
      })
    } finally {
      if (priorToken === undefined) delete process.env.GH_TOKEN
      else process.env.GH_TOKEN = priorToken
      if (priorLegacyToken === undefined) delete process.env.GITHUB_TOKEN
      else process.env.GITHUB_TOKEN = priorLegacyToken
      if (priorCi === undefined) delete process.env.CI
      else process.env.CI = priorCi
      if (priorGitHubActions === undefined) delete process.env.GITHUB_ACTIONS
      else process.env.GITHUB_ACTIONS = priorGitHubActions
      globalThis.fetch = priorFetch
    }

    expect(requests).toHaveLength(1)
    expect(requests[0].init.headers.authorization).toBe('Bearer explicit-test-token')
  })

  test('keeps environment-token requests on the injected fetch path', async () => {
    const priorToken = process.env.GH_TOKEN
    const priorLegacyToken = process.env.GITHUB_TOKEN
    process.env.GH_TOKEN = 'environment-test-token'
    delete process.env.GITHUB_TOKEN
    const requests = []
    try {
      await listGitHubIssues({
        fetch: async (_url, init) => {
          requests.push(init)
          return { ok: true, headers: new Headers(), json: async () => [] }
        },
        spawnSync: () => {
          throw new Error('GitHub CLI must not be used when an environment token is present')
        },
      })
    } finally {
      if (priorToken === undefined) delete process.env.GH_TOKEN
      else process.env.GH_TOKEN = priorToken
      if (priorLegacyToken === undefined) delete process.env.GITHUB_TOKEN
      else process.env.GITHUB_TOKEN = priorLegacyToken
    }
    expect(requests[0].headers.authorization).toBe('Bearer environment-test-token')
  })

  test('sanitizes GitHub CLI absence and HTTP failures without falling back anonymously', async () => {
    const priorCi = process.env.CI
    const priorGitHubActions = process.env.GITHUB_ACTIONS
    delete process.env.CI
    delete process.env.GITHUB_ACTIONS
    try {
      const launchError = Object.assign(new Error('Bearer never-print-this'), { code: 'ENOENT' })
      let absenceMessage = ''
      try {
        await listGitHubIssues({
          token: '',
          spawnSync: () => ({ error: launchError, status: null, stderr: 'Bearer cli-secret' }),
        })
      } catch (error) {
        absenceMessage = error.message
      }
      expect(absenceMessage).toContain('(ENOENT)')
      expect(absenceMessage).not.toContain('never-print-this')
      expect(absenceMessage).not.toContain('cli-secret')

      let failureMessage = ''
      try {
        await listGitHubIssues({
          token: '',
          spawnSync: () => ({
            status: 1,
            stdout: ghCliOutput(403, { message: 'Bearer response-secret' }),
            stderr: 'Bearer stderr-secret',
          }),
        })
      } catch (error) {
        failureMessage = error.message
      }
      expect(failureMessage).toBe('Unable to query GitHub issues (403)')
      expect(failureMessage).not.toContain('response-secret')
      expect(failureMessage).not.toContain('stderr-secret')
    } finally {
      if (priorCi === undefined) delete process.env.CI
      else process.env.CI = priorCi
      if (priorGitHubActions === undefined) delete process.env.GITHUB_ACTIONS
      else process.env.GITHUB_ACTIONS = priorGitHubActions
    }
  })

  test('bounds GitHub CLI requests and sanitizes timeout failures', async () => {
    const priorCi = process.env.CI
    const priorGitHubActions = process.env.GITHUB_ACTIONS
    delete process.env.CI
    delete process.env.GITHUB_ACTIONS
    try {
      const timeoutError = Object.assign(new Error('Bearer timeout-secret'), {
        code: 'ETIMEDOUT',
      })
      let spawnOptions
      let failureMessage = ''
      try {
        await listGitHubIssues({
          token: '',
          spawnSync: (_command, _args, options) => {
            spawnOptions = options
            return {
              error: timeoutError,
              status: null,
              stderr: 'Bearer stderr-secret',
            }
          },
        })
      } catch (error) {
        failureMessage = error.message
      }
      expect(spawnOptions.timeout).toBe(30_000)
      expect(failureMessage).toBe(
        'Unable to query GitHub issues through authenticated GitHub CLI (ETIMEDOUT)'
      )
      expect(failureMessage).not.toContain('timeout-secret')
      expect(failureMessage).not.toContain('stderr-secret')
    } finally {
      if (priorCi === undefined) delete process.env.CI
      else process.env.CI = priorCi
      if (priorGitHubActions === undefined) delete process.env.GITHUB_ACTIONS
      else process.env.GITHUB_ACTIONS = priorGitHubActions
    }
  })

  test('follows next pages beyond 1000 mixed issues and pull requests', async () => {
    const requests = []
    const issues = await listGitHubIssues({
      fetch: async (url) => {
        const page = Number(new URL(url).searchParams.get('page'))
        requests.push(page)
        return {
          ok: true,
          headers: new Headers(
            page < 11
              ? {
                  link: `<https://api.github.com/repositories/1300192/issues?state=all&per_page=100&page=${page + 1}>; rel="next"`,
                }
              : {}
          ),
          json: async () =>
            page === 11
              ? [4, 3, 2, 1].map((number) => ({ number, title: `Issue ${number}`, state: 'open' }))
              : Array.from({ length: 100 }, (_, index) => ({
                  number: page * 100 + index,
                  title: 'Mixed inventory',
                  state: 'open',
                  ...(index % 2 === 0 ? { pull_request: {} } : {}),
                })),
        }
      },
    })
    expect(requests).toEqual(Array.from({ length: 11 }, (_, index) => index + 1))
    expect(issues).toHaveLength(504)
    expect(issues.slice(-4).map(({ number }) => number)).toEqual([4, 3, 2, 1])
  })

  test('preserves GitHub next-page cursors on the trusted repository endpoint', async () => {
    const requests = []
    await listGitHubIssues({
      fetch: async (url) => {
        requests.push(url)
        return {
          ok: true,
          headers: new Headers(
            requests.length === 1
              ? {
                  link: '<https://api.github.com/repositories/1343240225/issues?state=all&per_page=100&page=2&after=opaque%3D>; rel="next"',
                }
              : {}
          ),
          json: async () => [],
        }
      },
    })
    expect(requests).toEqual([
      'https://api.github.com/repos/adea-ai/control-plane/issues?state=all&per_page=100&page=1',
      'https://api.github.com/repos/adea-ai/control-plane/issues?state=all&per_page=100&page=2&after=opaque%3D',
    ])
  })

  test('fails rather than returning a truncated inventory at the defensive bound', async () => {
    await expect(
      listGitHubIssues({
        maxPages: 2,
        fetch: async (url) => {
          const page = Number(new URL(url).searchParams.get('page'))
          return {
            ok: true,
            headers: new Headers({
              link: `<https://api.github.com/repos/adea-ai/control-plane/issues?state=all&per_page=100&page=${page + 1}>; rel="next"`,
            }),
            json: async () => [],
          }
        },
      })
    ).rejects.toThrow('pagination exceeded')
  })

  test('fails on a later request error instead of returning earlier issues', async () => {
    await expect(
      listGitHubIssues({
        fetch: async (url) => {
          const page = Number(new URL(url).searchParams.get('page'))
          return page === 1
            ? {
                ok: true,
                headers: new Headers({
                  link: '<https://api.github.com/repos/adea-ai/control-plane/issues?state=all&per_page=100&page=2>; rel="next"',
                }),
                json: async () => [{ number: 1, title: 'Issue', state: 'open' }],
              }
            : { ok: false, status: 403 }
        },
      })
    ).rejects.toThrow('Unable to query GitHub issues (403)')
  })

  test('rejects redirected or cyclic next-page links', async () => {
    for (const next of [
      'https://other.example/issues?page=2',
      'https://api.github.com/repos/adea-ai/control-plane/issues?state=all&per_page=100&page=1',
    ]) {
      await expect(
        listGitHubIssues({
          fetch: async () => ({
            ok: true,
            headers: new Headers({ link: `<${next}>; rel="next"` }),
            json: async () => [],
          }),
        })
      ).rejects.toThrow('Invalid GitHub issues next-page link')
    }
  })

  test('propagates fetch failures and rejects malformed inventories', async () => {
    await expect(
      listGitHubIssues({
        fetch: async () => {
          throw new Error('network failed')
        },
      })
    ).rejects.toThrow('network failed')
    await expect(
      listGitHubIssues({ fetch: async () => ({ ok: true, json: async () => ({}) }) })
    ).rejects.toThrow('GitHub issues response was not an array')
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
            url: 'https://github.com/adea-ai/control-plane/issues/188',
            milestone: { number: 11, title: 'M11: Feature Completion & Production Audit' },
          },
          {
            number: 192,
            state: 'CLOSED',
            url: 'https://github.com/adea-ai/control-plane/issues/192',
            milestone: { number: 11, title: 'M11: Feature Completion & Production Audit' },
          },
          {
            number: 194,
            state: 'OPEN',
            url: 'https://github.com/adea-ai/control-plane/issues/194',
            milestone: { number: 10, title: 'M12: Cross-Product Integration & Release' },
          },
          {
            number: 197,
            state: 'OPEN',
            url: 'https://github.com/adea-ai/control-plane/issues/197',
            milestone: { number: 11, title: 'M11: Feature Completion & Production Audit' },
          },
        ],
        [192]
      )
    ).toThrow(
      'Gap issues must be open in their authorized Control Plane milestone: #188 (CLOSED, M11: Feature Completion & Production Audit), #194 (OPEN, M12: Cross-Product Integration & Release), #192 (CLOSED, M11: Feature Completion & Production Audit)'
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
          url: 'https://github.com/adea-ai/control-plane/issues/188',
          milestone: { number: 11, title: 'M11: Feature Completion & Production Audit' },
        },
        {
          number: 197,
          state: 'CLOSED',
          url: 'https://github.com/adea-ai/control-plane/issues/197',
          milestone: { number: 11, title: 'M11: Feature Completion & Production Audit' },
        },
      ])
    ).toThrow(
      'Gap issues must be open in their authorized Control Plane milestone: #197 (CLOSED, M11: Feature Completion & Production Audit)'
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
  }, 60000)

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

  test('records the owner-approved Restate-free Local default without promoting it to verified', () => {
    const local = ledger.deploymentProfiles.find(({ id }) => id === 'local')
    expect(local.composition).toContain('embedded SQLite durable queue/runtime')
    expect(local.composition).toContain('not a default dependency')
    expect(local.classification).toBe('partially_verified')
    expect(local.result).toContain('historical compatibility-mode evidence')
    expect(local.result).toContain('not certification of the default Restate-free Local profile')

    const localComposition = ledger.priorMilestoneAudits.find(({ id }) => id === 'M10-ISSUE-203')
    expect(localComposition.assessment).toContain('Restate is optional compatibility mode')
    expect(localComposition.assessment).toContain('remains an M11 gate')
  }, 60000)

  test('keeps the generated report in sync', async () => {
    expect(await readFile(reportUrl, 'utf8')).toBe(await renderRequirementsReport(ledger))
  }, 60000)

  test('does not truncate the generated report through the formatter pipe', async () => {
    // The report is larger than the runtime's child-process pipe buffer. A
    // truncated pipe reports success, so the report length is asserted directly.
    const report = await renderRequirementsReport(ledger)
    expect(Buffer.byteLength(report)).toBeGreaterThan(512 * 1024)
    expect(Buffer.byteLength(await readFile(reportUrl, 'utf8'))).toBe(Buffer.byteLength(report))
    expect(report.endsWith('\n')).toBe(true)
  }, 60000)

  test('records the repository-pinned formatter version', async () => {
    const lockfile = await readFile(new URL('../bun.lock', import.meta.url), 'utf8')
    const pinned = pinnedFormatterVersion(lockfile)
    expect(pinned).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+$/)
    expect(validateFormatterVersion(lockfile, `Version: ${pinned}`)).toBeNull()
    expect(validateFormatterVersion(lockfile, 'Version: 0.0.1')).toContain(
      'does not match the repository-pinned oxfmt'
    )
    expect(runningFormatterVersion('Version: 0.72.0')).toBe('0.72.0')
    expect(validateFormatterVersion('no lockfile entry', 'Version: 0.72.0')).toContain(
      'does not pin an oxfmt version'
    )
  })

  test('crosswalks every normative source, requirement and issue audit', async () => {
    const { errors, crosswalk } = await collectCanonicalCrosswalk(ledger, repositoryRoot)
    expect(errors).toEqual([])
    expect(crosswalk.sources.map(({ sourceId }) => sourceId)).toEqual(
      ledger.sources.map(({ id }) => id)
    )
    expect(crosswalk.requirements.map(({ id }) => id)).toEqual(
      ledger.requirements.map(({ id }) => id)
    )
    expect(crosswalk.priorIssueAudits.map(({ issue }) => issue)).toEqual(
      ledger.priorMilestoneAudits.map(({ issue }) => issue)
    )
    expect(crosswalk.deploymentProfiles.map(({ id }) => id)).toEqual(
      ledger.deploymentProfiles.map(({ id }) => id)
    )
    for (const source of crosswalk.sources) {
      expect(source.currentRevision, source.sourceId).toBeNumber()
      expect(source.currentTextSha256, source.sourceId).toMatch(/^[a-f0-9]{64}$/)
      expect(source.atomicClauses, source.sourceId).toBeNumber()
      expect(source.unlinkedClauseDisposition, source.sourceId).not.toBeNull()
    }
    // The crosswalk joins rows; it never reclassifies one.
    for (const [index, requirement] of crosswalk.requirements.entries()) {
      expect(requirement.classification).toBe(ledger.requirements[index].classification)
      expect(requirement.normativeState).toBe(ledger.requirements[index].normativeState)
    }
  }, 60000)

  test('fails closed when the generated crosswalk drifts from the ledger', async () => {
    expect(await validateCanonicalCrosswalk(ledger, repositoryRoot)).toEqual([])
    const drifted = clone(ledger)
    drifted.requirements[0].classification = 'verified'
    expect(await validateCanonicalCrosswalk(drifted, repositoryRoot)).toContain(
      'Canonical requirements crosswalk drifted; run bun run requirements:write'
    )
  }, 60000)

  test('inventories embedded objects by identity and never by caption', async () => {
    const { errors, inventory } = await collectFigureInventory(ledger, repositoryRoot)
    expect(errors).toEqual([])
    expect(inventory.sources.map(({ sourceId }) => sourceId)).toEqual(
      ledger.sources.map(({ id }) => id)
    )
    for (const source of inventory.sources) {
      // Nested tabs and current image bytes were never inventoried, so they are
      // recorded as absent instead of being inferred from caption text.
      expect(source.nestedTabsInventoried, source.sourceId).toBe(false)
      expect(source.imageBytesRefreshedAtCurrentRevision, source.sourceId).toBe(false)
      for (const object of source.currentObjects) {
        expect(object.objectId, source.sourceId).toMatch(/^kix\./)
        expect(object.sha256, source.sourceId).toBeNull()
        expect(object.recordedTextAnchor, source.sourceId).toBeUndefined()
      }
    }
    const security = inventory.sources.find(({ sourceId }) => sourceId === 'security-trust-model')
    expect(security.identityReconciliation.added.length).toBe(3)
    expect(security.identityReconciliation.absent).toEqual(['kix.a77to4b9gn0r'])
    const architecture = inventory.sources.find(
      ({ sourceId }) => sourceId === 'system-architecture'
    )
    expect(architecture.identityReconciliation.added.length).toBe(2)
    expect(architecture.identityReconciliation.absent).toEqual(['kix.ows2808gmq16'])
    expect(inventory.summary.currentRootTabObjects).toBe(12)
    expect(inventory.summary.historicalObjects).toBe(9)
  }, 60000)

  test('fails closed when the generated figure inventory drifts', async () => {
    expect(await validateFigureInventory(ledger, repositoryRoot)).toEqual([])
    const drifted = clone(ledger)
    drifted.sources[0].embeddedObjects.nestedTabsInventoried = true
    expect(await validateFigureInventory(drifted, repositoryRoot)).toContain(
      'Canonical figure inventory drifted; run bun run requirements:write'
    )
  }, 60000)

  test('requires every gap reference to resolve to a recorded open issue', async () => {
    const { errors } = await validateRequirementsLedger(ledger, {
      repositoryRoot,
    })
    expect(errors).toEqual([])
    const missing = clone(ledger)
    missing.githubIssueSnapshot.issues = missing.githubIssueSnapshot.issues.filter(
      ({ number }) => number !== 188
    )
    const missingResult = await validateRequirementsLedger(missing, { repositoryRoot })
    expect(missingResult.errors).toContain(
      'CP-ART-001: gap reference #188 is missing from githubIssueSnapshot'
    )
    const closed = clone(ledger)
    const closedIssue = closed.githubIssueSnapshot.issues.find(({ number }) => number === 195)
    closedIssue.state = 'CLOSED'
    const closedResult = await validateRequirementsLedger(closed, { repositoryRoot })
    expect(closedResult.errors).toContain(
      'CP-PRD-RETRIEVAL-001: gap reference #195 is closed and cannot carry an open gap'
    )
  }, 60000)

  test('requires an accountable disposition for every orphaned atomic clause', async () => {
    const { errors } = await validateRequirementsLedger(ledger, { repositoryRoot })
    expect(errors).toEqual([])
    const orphaned = clone(ledger)
    orphaned.atomDispositions = orphaned.atomDispositions.filter(
      ({ sourceId }) => sourceId !== 'system-architecture'
    )
    const orphanedResult = await validateRequirementsLedger(orphaned, { repositoryRoot })
    expect(orphanedResult.errors).toContain(
      'system-architecture: unmapped atomic clauses require an explicit disposition'
    )
    const miscounted = clone(ledger)
    const disposition = miscounted.atomDispositions.find(
      ({ sourceId }) => sourceId === 'system-architecture'
    )
    disposition.unmappedAtoms = 1
    const miscountedResult = await validateRequirementsLedger(miscounted, { repositoryRoot })
    expect(miscountedResult.errors).toContain(
      'system-architecture: atom disposition covers 1 unmapped clauses but the register has 546'
    )
  }, 60000)

  test('rejects a stale candidate that is presented as current proof', async () => {
    const { errors } = await validateRequirementsLedger(ledger, { repositoryRoot })
    expect(errors).toEqual([])
    const stale = clone(ledger)
    stale.reconciliation.candidateProof.coversReconciliationBase = true
    const staleResult = await validateRequirementsLedger(stale, { repositoryRoot })
    expect(staleResult.errors).toContain(
      'reconciliation.candidateProof.coversReconciliationBase is inaccurate'
    )
    const missingDisposition = clone(ledger)
    delete missingDisposition.reconciliation.candidateProof.disposition
    const missingResult = await validateRequirementsLedger(missingDisposition, {
      repositoryRoot,
    })
    expect(missingResult.errors).toContain(
      'reconciliation.candidateProof.disposition is required for a stale candidate'
    )
  }, 60000)

  test('requires an exact resolvable head for every received worker contribution', async () => {
    const { errors } = await validateRequirementsLedger(ledger, { repositoryRoot })
    expect(errors).toEqual([])
    const pendingId = ledger.workerEvidence[0].id
    const pendingWithHead = clone(ledger)
    const pendingWorker = pendingWithHead.workerEvidence.find(({ id }) => id === pendingId)
    pendingWorker.status = 'pending'
    pendingWorker.head = 'a'.repeat(40)
    const pendingResult = await validateRequirementsLedger(pendingWithHead, { repositoryRoot })
    expect(pendingResult.errors).toContain(`${pendingId}: a pending worker must not record a head`)
    const missingHead = clone(ledger)
    const missingHeadWorker = missingHead.workerEvidence.find(({ id }) => id === pendingId)
    missingHeadWorker.status = 'received'
    missingHeadWorker.head = null
    const missingResult = await validateRequirementsLedger(missingHead, { repositoryRoot })
    expect(missingResult.errors).toContain(
      `${pendingId}: a received worker must record an exact full Git head`
    )
    const unknownHead = clone(ledger)
    unknownHead.workerEvidence.find(({ id }) => id === pendingId).status = 'received'
    unknownHead.workerEvidence.find(({ id }) => id === pendingId).head = 'b'.repeat(40)
    const unknownResult = await validateRequirementsLedger(unknownHead, { repositoryRoot })
    expect(unknownResult.errors).toContain(
      `${pendingId}: worker head ${'b'.repeat(40)} is unavailable in the repository`
    )
  }, 60000)

  test('proves received worker evidence against the tree of its own head', async () => {
    const received = ledger.workerEvidence.filter(({ status }) => status === 'received')
    expect(received.length).toBeGreaterThan(0)
    for (const worker of received) {
      expect(worker.head, worker.id).toMatch(/^[0-9a-f]{40}$/)
      expect(worker.evidence.length, worker.id).toBeGreaterThan(0)
      for (const entry of worker.evidence) {
        expect(entry.commit, `${worker.id}:${entry.path}`).toBe(worker.head)
      }
    }
    const absent = clone(ledger)
    const worker = absent.workerEvidence.find(({ status }) => status === 'received')
    worker.evidence.push({ path: 'docs/requirements/does-not-exist.md', commit: worker.head })
    const absentResult = await validateRequirementsLedger(absent, { repositoryRoot })
    expect(absentResult.errors).toContain(
      `${worker.id}: worker evidence path is absent at head ${worker.head}: docs/requirements/does-not-exist.md`
    )
  }, 60000)

  test('gives every superseded row an explicit supersession disposition', async () => {
    for (const row of [...ledger.requirements, ...ledger.priorMilestoneAudits]) {
      if (row.classification !== 'superseded') continue
      expect(row.gap, row.id).toBeUndefined()
      expect(row.supersession, row.id).toBeDefined()
      expect(typeof row.supersession.issue, row.id).toBe('number')
      expect(row.supersession.severity, row.id).toMatch(/^(critical|high|medium|low)$/)
      expect(typeof row.supersession.owner, row.id).toBe('string')
      expect(typeof row.supersession.disposition, row.id).toBe('string')
    }
    const missing = clone(ledger)
    delete missing.requirements.find(({ id }) => id === 'CP-TDD-005').supersession
    const missingResult = await validateRequirementsLedger(missing, { repositoryRoot })
    expect(missingResult.errors).toContain(
      'CP-TDD-005: row.supersession is required for superseded rows'
    )
  }, 60000)

  test('records the live GitHub issue identity without promoting it', async () => {
    const snapshot = ledger.githubIssueSnapshot
    expect(snapshot.repository).toBe('adea-ai/control-plane')
    expect(snapshot.issues.map(({ number }) => number)).toEqual([
      186, 187, 188, 189, 190, 191, 192, 193, 194, 195, 196, 197,
    ])
    for (const issue of snapshot.issues) {
      expect(issue.url).toBe(`https://github.com/adea-ai/control-plane/issues/${issue.number}`)
      expect(issue.milestone).toBe(11)
      expect(issue.repositoryDocumentationLabel).toStartWith('M11.')
    }
    expect(snapshot.issues.find(({ number }) => number === 192).state).toBe('CLOSED')
    // #189 and #193 are recorded closed in the 2026-09-30 repository documentation
    // but are open on GitHub; the live state wins and nothing is promoted.
    expect(snapshot.issues.find(({ number }) => number === 189).state).toBe('OPEN')
    expect(snapshot.issues.find(({ number }) => number === 193).state).toBe('OPEN')
  })

  test('refreshes the recorded issue snapshot from live identities', () => {
    const liveIssues = ledger.githubIssueSnapshot.issues.map((issue) => ({
      number: issue.number,
      title: issue.title,
      state: issue.state,
      closedAt: issue.closedAt,
      milestone: { number: issue.milestone, title: 'M19 — Feature Completion & Production Audit' },
      url: issue.url,
    }))
    const refreshed = refreshGitHubIssueSnapshot(ledger, liveIssues, {
      retrievedAt: '2026-10-22',
    })
    expect(refreshed.githubIssueSnapshot.retrievedAt).toBe('2026-10-22')
    expect(refreshed.githubIssueSnapshot.issues).toHaveLength(
      ledger.githubIssueSnapshot.issues.length
    )
    expect(() => refreshGitHubIssueSnapshot(ledger, liveIssues.slice(1))).toThrow(
      'is missing from the current GitHub inventory'
    )
    const renamed = structuredClone(liveIssues)
    renamed[0].title = 'renamed upstream'
    renamed[0].state = 'CLOSED'
    renamed[0].closedAt = '2026-10-22T00:00:00Z'
    const divergences = compareGitHubIssueSnapshot(ledger, renamed)
    expect(divergences).toContain('#186 is CLOSED on GitHub but the snapshot records OPEN')
    expect(divergences).toContain('#186 title differs from the recorded snapshot title')
  }, 60000)

  test('keeps the generated crosswalk and figure inventory in sync', async () => {
    expect(await readFile(crosswalkUrl, 'utf8')).toBe(
      await renderCanonicalCrosswalk(ledger, repositoryRoot)
    )
    expect(await readFile(figureInventoryUrl, 'utf8')).toBe(
      await renderFigureInventory(ledger, repositoryRoot)
    )
  }, 60000)

  test('binds every worker evidence entry to the recorded worker head', async () => {
    const changed = clone(ledger)
    const worker = changed.workerEvidence.find(({ status }) => status === 'received')
    worker.evidence[0].commit = 'f'.repeat(40)
    const { errors } = await validateRequirementsLedger(changed, { repositoryRoot })
    expect(errors).toContain(
      `${worker.id}: worker evidence commit must match the worker head for ${worker.evidence[0].path}`
    )
  }, 60000)

  test('reports worker evidence whose content differs from this tree', async () => {
    const { provenance } = await validateRequirementsLedger(ledger, { repositoryRoot })
    // W2 records the head this lane last published. Its crosswalk and its
    // reconciliation record were rewritten by later commits, so the paths resolve
    // to different content here and must be reported.
    const w2 = provenance.find((finding) => finding.startsWith('W2 '))
    expect(w2).toBeDefined()
    expect(w2).toContain('docs/requirements/control-plane-requirements-crosswalk.v1.json')
    expect(w2).toContain('a matching path is not the reviewed artifact')
    // The figure inventory is byte-identical at the recorded head and at HEAD, so
    // a path that resolves to the same blob is not reported.
    expect(w2).not.toContain('docs/requirements/canonical-figure-inventory.v1.json')
    // The adversarial corpus is cited as requirement evidence while this tree
    // carries the earlier corpus, so the shadowing is reported for that lane too.
    const w5 = provenance.find((finding) => finding.startsWith('W5 '))
    expect(w5).toBeDefined()
    expect(w5).toContain('docs/adversarial-corpus-v1.md')
  }, 60000)

  test('reports the profile join that the requirement rows contradict', async () => {
    const { provenance } = await validateRequirementsLedger(ledger, { repositoryRoot })
    const cloud = provenance.find((finding) => finding.startsWith('deployment profile cloud:'))
    expect(cloud).toBeDefined()
    expect(cloud).toContain('AHQ-CP-005')
    expect(cloud).toContain('CP-TDD-004')
    expect(cloud).toContain('not a coverage claim')
    // No requirement row names the remaining profiles, so there is nothing to
    // contradict and nothing is reported.
    expect(provenance.some((finding) => finding.startsWith('deployment profile local:'))).toBe(
      false
    )
  }, 60000)

  test('fails closed when a historical figure identity leaves the canonical audit', async () => {
    const changed = clone(ledger)
    const source = changed.sources.find(({ id }) => id === 'security-trust-model')
    const object = source.embeddedObjects.historicalObservations[0].objects[0]
    expect(object.objectId).toBe('kix.vlyjrmx8itur')
    object.sha256 = 'a'.repeat(64)
    const { errors } = await validateRequirementsLedger(changed, { repositoryRoot })
    expect(errors).toContain(
      'security-trust-model: historical figure object kix.vlyjrmx8itur records a digest that differs from the canonical figure audit'
    )
    const renamed = clone(ledger)
    renamed.sources.find(
      ({ id }) => id === 'control-plane-tdd'
    ).embeddedObjects.historicalObservations[0].objects[0].objectId = 'kix.notrecorded00'
    const renamedResult = await validateRequirementsLedger(renamed, { repositoryRoot })
    expect(renamedResult.errors).toContain(
      'control-plane-tdd: historical figure object kix.notrecorded00 is absent from the canonical figure audit'
    )
  }, 60000)

  test('accepts a worker ID beyond the ninth lane', async () => {
    const changed = clone(ledger)
    const worker = changed.workerEvidence.find(({ status }) => status === 'received')
    worker.id = 'W10'
    const { errors } = await validateRequirementsLedger(changed, { repositoryRoot })
    expect(errors).not.toContain('W10: worker ID is invalid')
  }, 60000)

  test('reads the generated artifacts from the requested repository root', async () => {
    // The generated artifacts are compared against the root the caller names, not
    // against the checkout the script happens to live in.
    const directory = mkdtempSync(join(tmpdir(), 'requirements-root-'))
    try {
      mkdirSync(resolve(directory, 'docs/requirements'), { recursive: true })
      copyFileSync(
        resolve(repositoryRoot, 'docs/requirements/canonical-source-freshness-2026-10-03.v1.json'),
        resolve(directory, 'docs/requirements/canonical-source-freshness-2026-10-03.v1.json')
      )
      expect(await validateFigureInventory(ledger, directory)).toContain(
        'canonical figure inventory is missing or malformed'
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 60000)
})

describe('CP #195 reconciliation record provenance (#186/#195)', () => {
  const recordUrl = new URL(
    '../docs/requirements/cp186-195-reconciliation-2026-10-21.md',
    import.meta.url
  )
  const loadRecord = async () => readFile(recordUrl, 'utf8')
  const loadCrosswalk = async () => {
    const { errors, crosswalk } = await collectCanonicalCrosswalk(ledger, repositoryRoot)
    expect(errors).toEqual([])
    return crosswalk
  }

  test('the reconciliation record matches the artifacts it cites', async () => {
    const record = await loadRecord()
    const crosswalk = await loadCrosswalk()
    expect(validateReconciliationRecord(record, ledger, crosswalk)).toEqual([])
  }, 60000)

  test('fails closed when the record drifts from the crosswalk coverage', async () => {
    const record = await loadRecord()
    const crosswalk = await loadCrosswalk()
    const drifted = record.replace(/(\| Captured atomic clauses\s*\|\s*)6093/, '$16094')
    expect(drifted).not.toBe(record)
    expect(validateReconciliationRecord(drifted, ledger, crosswalk)).toContain(
      'reconciliation record "Captured atomic clauses" says 6094, the crosswalk says 6093'
    )
  }, 60000)

  test('fails closed when the record drops a coverage row', async () => {
    const record = await loadRecord()
    const crosswalk = await loadCrosswalk()
    const drifted = record
      .split('\n')
      .filter((line) => !line.startsWith('| External acceptance gates recorded '))
      .join('\n')
    expect(validateReconciliationRecord(drifted, ledger, crosswalk)).toContain(
      'reconciliation record is missing the "External acceptance gates recorded" row'
    )
  }, 60000)

  test('fails closed when the record drifts from a recorded worker head', async () => {
    const record = await loadRecord()
    const crosswalk = await loadCrosswalk()
    const worker = ledger.workerEvidence[0]
    const drifted = record.replace(worker.head, '0'.repeat(40))
    expect(drifted).not.toBe(record)
    expect(validateReconciliationRecord(drifted, ledger, crosswalk)).toContain(
      `reconciliation record ${worker.id} does not carry the recorded head ${worker.head}`
    )
  }, 60000)

  test('fails closed when the record drifts from an open acceptance gate', async () => {
    const record = await loadRecord()
    const crosswalk = await loadCrosswalk()
    const gate = ledger.reconciliation.externalGates[0]
    const drifted = record.replace(
      new RegExp(`(\\| ${gate.id}[^\\n]*?\\| )blocked( \\|)`),
      '$1satisfied$2'
    )
    expect(drifted).not.toBe(record)
    expect(validateReconciliationRecord(drifted, ledger, crosswalk)).toContain(
      `reconciliation record ${gate.id} says satisfied, the ledger says ${gate.status}`
    )
  }, 60000)
})
