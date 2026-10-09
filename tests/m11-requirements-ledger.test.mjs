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
  })

  test('atomic clause counts are checked beyond the bounded requirement rows', async () => {
    const changed = clone(ledger)
    changed.sources[0].atomicInventory.atoms -= 1
    const { errors } = await validateRequirementsLedger(changed)
    expect(errors).toContain('project-index: atomic inventory count differs from declared atoms')
  })

  test('atomic inventory provenance must match the captured source revision and bytes', async () => {
    const changed = clone(ledger)
    changed.sources[0].atomicInventory.sourceRevision -= 1
    changed.sources[0].atomicInventory.contentSha256 = '0'.repeat(64)
    const { errors } = await validateRequirementsLedger(changed)
    expect(errors).toContain('project-index: atomic inventory revision differs from source')
    expect(errors).toContain('project-index: atomic inventory content hash differs from source')
  })

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
  })

  test('bounds GitHub CLI requests and sanitizes timeout failures', async () => {
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
  })

  test('keeps the generated report in sync', async () => {
    expect(await readFile(reportUrl, 'utf8')).toBe(await renderRequirementsReport(ledger))
  })
})
