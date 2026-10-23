import { spawnSync } from 'node:child_process'
import { accessSync, closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { access, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { compareCodePointOrder } from '../packages/contracts/src/canonical-json.ts'
import { collectAtomicCrosswalk, validateAtomicClauseRegister } from './atomic-clause-ledger.mjs'
import { validateCanonicalSourceLineage } from './canonical-source-lineage.mjs'

// The report must be formatted by the repository-pinned formatter. Running an
// unpinned formatter produces a different byte sequence for the same content and
// would make the drift check report a phantom difference.
export function pinnedFormatterVersion(lockfileText) {
  const match = /"oxfmt":\s*\["oxfmt@([0-9]+\.[0-9]+\.[0-9]+)"/.exec(lockfileText)
  return match ? match[1] : null
}

export function runningFormatterVersion(versionOutput) {
  const match = /([0-9]+\.[0-9]+\.[0-9]+)/.exec(versionOutput ?? '')
  return match ? match[1] : null
}

export function validateFormatterVersion(lockfileText, versionOutput) {
  const pinned = pinnedFormatterVersion(lockfileText)
  if (!pinned) return 'bun.lock does not pin an oxfmt version'
  const running = runningFormatterVersion(versionOutput)
  if (!running) return 'oxfmt did not report a version'
  if (running !== pinned)
    return `oxfmt ${running} does not match the repository-pinned oxfmt ${pinned}`
  return null
}

let formatterVersionChecked = false

function assertPinnedFormatter() {
  if (formatterVersionChecked) return
  const version = spawnSync('bun', ['x', 'oxfmt', '--version'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
  if (version.status !== 0)
    throw new Error(
      `oxfmt markdown formatting failed: ${version.stderr || 'formatter unavailable'}`
    )
  let lockfile = ''
  try {
    lockfile = readFileSync(resolve(repositoryRoot, 'bun.lock'), 'utf8')
  } catch (error) {
    throw new Error(`oxfmt markdown formatting failed: ${error.message}`, { cause: error })
  }
  const mismatch = validateFormatterVersion(lockfile, version.stdout)
  if (mismatch) throw new Error(`oxfmt markdown formatting failed: ${mismatch}`)
  formatterVersionChecked = true
}

// The generated artifacts are larger than the runtime's default child-process
// pipe buffer, and a truncated pipe is reported as a successful run. The
// formatter therefore writes to a temporary file descriptor instead of a pipe so
// a partial artifact can never be published or compared as if it were complete.
function runFormatter(text, filename) {
  assertPinnedFormatter()
  const directory = mkdtempSync(join(tmpdir(), 'requirements-ledger-'))
  const outputPath = join(directory, filename)
  const handle = openSync(outputPath, 'w')
  try {
    const result = spawnSync(
      'bun',
      [
        'x',
        'oxfmt',
        '--stdin-filepath',
        filename,
        '--config',
        resolve(repositoryRoot, '.oxfmtrc.json'),
      ],
      {
        cwd: repositoryRoot,
        input: text,
        encoding: 'utf8',
        stdio: ['pipe', handle, 'pipe'],
      }
    )
    if (result.error) throw new Error(`oxfmt formatting failed: ${result.error.code}`)
    if (result.status !== 0) throw new Error(`oxfmt formatting failed: ${result.stderr}`)
    const formatted = readFileSync(outputPath, 'utf8')
    if (formatted.length === 0) throw new Error('oxfmt formatting produced no output')
    return formatted
  } finally {
    closeSync(handle)
    rmSync(directory, { recursive: true, force: true })
  }
}

function formatMarkdown(text) {
  return runFormatter(text, 'report.md')
}

// Generated JSON artifacts are written through the same pinned formatter so the
// committed files stay format-clean without a separate formatting pass.
function formatJson(value, filename) {
  return runFormatter(`${JSON.stringify(value, null, 2)}\n`, filename)
}

const classifications = new Set([
  'verified',
  'partially_verified',
  'planned',
  'tbd',
  'deprecated',
  'superseded',
  'not_implemented',
])
const normativeStates = new Set(['accepted', 'planned', 'tbd', 'deprecated', 'superseded'])
const validationLanes = new Set([
  'unit',
  'contract/schema',
  'integration',
  'end-to-end',
  'smoke/configuration',
  'security/adversarial',
  'eval',
  'performance/capacity',
  'recovery/chaos',
  'infrastructure/live-provider certification',
])
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const ledgerPath = resolve(repositoryRoot, 'docs/requirements/control-plane-requirements.v1.json')
const architecturePath = resolve(
  repositoryRoot,
  'docs/architecture/control-plane-architecture.v1.json'
)
const reportPath = resolve(repositoryRoot, 'docs/requirements/control-plane-requirements.md')
const crosswalkPath = resolve(
  repositoryRoot,
  'docs/requirements/control-plane-requirements-crosswalk.v1.json'
)
const figureInventoryPath = resolve(
  repositoryRoot,
  'docs/requirements/canonical-figure-inventory.v1.json'
)
// The receipts are read by validators that accept a caller-supplied root, so
// they are recorded repository-relative and resolved against that root. An
// absolute path here would make resolve(root, path) ignore the root and read the
// receipts of the checkout that holds this script.
const freshnessPath = 'docs/requirements/canonical-source-freshness-2026-10-03.v1.json'
const lineagePath = 'docs/requirements/canonical-source-lineage-2026-10-03.v1.json'
const reconciliationRecordPath = resolve(
  repositoryRoot,
  'docs/requirements/cp186-195-reconciliation-2026-10-21.md'
)

// A shallow checkout does not carry the history that ancestry and worker-head
// provenance are proven against. The caller may state the layout explicitly;
// otherwise it is read from Git.
function isShallowRepository(root, declared) {
  if (typeof declared === 'boolean') return declared
  const shallow = spawnSync('git', ['rev-parse', '--is-shallow-repository'], {
    cwd: root,
    encoding: 'utf8',
  })
  return shallow.status === 0 && shallow.stdout.trim() === 'true'
}

export async function validateRequirementsLedger(ledger, options = {}) {
  const errors = []
  const warnings = []
  const provenance = []
  const rootOption = options.repositoryRoot ?? new URL('..', import.meta.url)
  const root = typeof rootOption === 'string' ? rootOption : fileURLToPath(rootOption)
  let candidateAvailable = false
  let committedArtifacts = new Set()
  const shallowRepository = isShallowRepository(root, options.shallowRepository)
  let workerInventory = { entries: [], complete: false }
  if (ledger.schemaVersion !== 1) errors.push('schemaVersion must equal 1')
  if (!/^[0-9a-f]{40}$/.test(ledger.candidate?.commit ?? '')) {
    errors.push('candidate.commit must be a full Git commit')
  } else {
    const queries = [
      `${ledger.candidate.commit}^{commit}`,
      ...(ledger.candidate.artifacts ?? []).map(
        (artifact) => `${ledger.candidate.commit}:${artifact}`
      ),
    ]
    const candidate = spawnSync('git', ['cat-file', '--batch-check'], {
      cwd: root,
      encoding: 'utf8',
      input: `${queries.join('\n')}\n`,
    })
    const results = candidate.stdout.trim().split('\n')
    candidateAvailable = candidate.status === 0 && !results[0]?.endsWith(' missing')
    committedArtifacts = new Set(
      (ledger.candidate.artifacts ?? []).filter(
        (_artifact, index) => !results[index + 1]?.endsWith(' missing')
      )
    )
    if (!candidateAvailable) {
      if (shallowRepository) {
        warnings.push(
          `candidate commit ${ledger.candidate.commit} is unavailable in this shallow checkout; committed-artifact provenance must be reproduced from a full clone`
        )
      } else {
        errors.push('candidate.commit must exist in the repository')
      }
    }
  }
  for (const key of ['node', 'bun', 'restate']) {
    if (!ledger.candidate?.toolchain?.[key]) errors.push(`candidate.toolchain.${key} is required`)
  }
  if (!Array.isArray(ledger.candidate?.artifacts) || ledger.candidate.artifacts.length === 0) {
    errors.push('candidate.artifacts must identify committed M11.1 evidence')
  }
  for (const artifact of ledger.candidate?.artifacts ?? []) {
    try {
      await access(resolve(root, artifact))
    } catch {
      errors.push(`candidate artifact does not exist: ${artifact}`)
    }
    if (candidateAvailable) {
      if (!committedArtifacts.has(artifact)) {
        errors.push(`candidate commit does not contain artifact: ${artifact}`)
      }
    }
  }

  const sourceIds = new Set()
  for (const source of ledger.sources ?? []) {
    requireFields(errors, source, [
      'id',
      'title',
      'provider',
      'sourceId',
      'uri',
      'updatedAt',
      'retrievalStatus',
    ])
    if (!['retrieved', 'missing'].includes(source.retrievalStatus)) {
      errors.push(`${source.id}: invalid retrievalStatus`)
    }
    if (source.retrievalStatus === 'missing') validateGap(errors, source, 'source gap')
    if (source.sourceAudit !== undefined) {
      const audit = source.sourceAudit
      requireFields(errors, audit, ['path', 'requirementIdPrefix', 'coverage'])
      if (audit.coverage !== 'partial') {
        errors.push(`${source.id}: checked-in source audit coverage must remain partial`)
      }
      if (!/^CP-[A-Z0-9-]+$/.test(audit.requirementIdPrefix ?? '')) {
        errors.push(`${source.id}: source-audit requirementIdPrefix is invalid`)
      } else if (typeof audit.path === 'string') {
        const sourceAuditPath = resolve(root, audit.path)
        const sourceAuditRelativePath = relative(
          resolve(root, 'docs/requirements'),
          sourceAuditPath
        )
        let sourceAuditDocument
        if (
          !audit.path.startsWith('docs/requirements/') ||
          sourceAuditRelativePath === '..' ||
          sourceAuditRelativePath.startsWith(`..${sep}`)
        ) {
          errors.push(`${source.id}: source-audit path must be under docs/requirements`)
        } else {
          try {
            sourceAuditDocument = await readFile(sourceAuditPath, 'utf8')
          } catch {
            errors.push(`${source.id}: source-audit document does not exist: ${audit.path}`)
          }
        }
        if (sourceAuditDocument !== undefined) {
          if (!/coverage remains partial/i.test(sourceAuditDocument)) {
            errors.push(
              `${source.id}: source-audit document must state that coverage remains partial`
            )
          }
          const prefix = audit.requirementIdPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          const rangePattern = new RegExp(
            '\\b`?' + prefix + '-(\\d{3})`?\\s+through\\s+`?' + prefix + '-(\\d{3})`?\\b',
            'g'
          )
          const documentedIds = new Set()
          for (const match of sourceAuditDocument.matchAll(rangePattern)) {
            const start = Number(match[1])
            const end = Number(match[2])
            if (end < start) {
              errors.push(`${source.id}: source-audit requirement range is reversed`)
              continue
            }
            for (let sequence = start; sequence <= end; sequence += 1) {
              documentedIds.add(`${audit.requirementIdPrefix}-${String(sequence).padStart(3, '0')}`)
            }
          }
          const actualIds = new Set(
            (ledger.requirements ?? [])
              .filter(
                (requirement) =>
                  requirement.sourceId === source.id &&
                  new RegExp(`^${audit.requirementIdPrefix}-\\d{3}$`).test(requirement.id)
              )
              .map(({ id }) => id)
          )
          if (documentedIds.size === 0) {
            errors.push(`${source.id}: source-audit document has no documented requirement ranges`)
          }
          const missingFromLedger = [...documentedIds].filter((id) => !actualIds.has(id)).toSorted()
          const missingFromAudit = [...actualIds].filter((id) => !documentedIds.has(id)).toSorted()
          if (missingFromLedger.length > 0 || missingFromAudit.length > 0) {
            errors.push(
              `${source.id}: source-audit requirement IDs do not match ledger (missing from ledger: ${missingFromLedger.join(', ') || 'none'}; missing from audit: ${missingFromAudit.join(', ') || 'none'})`
            )
          }
        }
      }
    }
    if (sourceIds.has(source.id)) errors.push(`duplicate source ID: ${source.id}`)
    sourceIds.add(source.id)
  }

  errors.push(...(await validateAtomicClauseRegisterCached(ledger.sources ?? [], root)))
  const atomicCrosswalk = await collectAtomicCrosswalkCached(ledger, root)
  errors.push(...atomicCrosswalk.errors)
  errors.push(...validateAtomDispositions(ledger, atomicCrosswalk.register))
  errors.push(...(await validateAtomicCrosswalkCached(ledger, root)))
  errors.push(...validateGapReferences(ledger))
  const candidateProof = validateCandidateProof(ledger, root, shallowRepository)
  errors.push(...candidateProof.errors)
  warnings.push(...candidateProof.warnings)
  const workerEvidence = validateWorkerEvidence(ledger, root, shallowRepository)
  errors.push(...workerEvidence.errors)
  warnings.push(...workerEvidence.warnings)
  provenance.push(...workerEvidence.provenance)
  workerInventory = workerEvidence.inventory
  errors.push(...(await validateFigureLineage(ledger, root)))
  provenance.push(...profileJoinProvenance(ledger))

  const expectedProfiles = ['cloud', 'hosted-server', 'hosted-simple', 'local']
  const actualProfiles = (ledger.deploymentProfiles ?? []).map(({ id }) => id).toSorted()
  if (JSON.stringify(actualProfiles) !== JSON.stringify(expectedProfiles)) {
    errors.push('deploymentProfiles must contain cloud, local, hosted-simple, and hosted-server')
  }
  for (const profile of ledger.deploymentProfiles ?? []) {
    requireFields(errors, profile, [
      'id',
      'composition',
      'classification',
      'owner',
      'observedAt',
      'commit',
      'result',
      'evidence',
    ])
    if (!classifications.has(profile.classification)) {
      errors.push(`${profile.id}: invalid classification ${profile.classification}`)
    }
    if (profile.classification !== 'verified') validateGap(errors, profile, 'profile gap')
    if (!Array.isArray(profile.evidence) || profile.evidence.length === 0) {
      errors.push(`${profile.id}: evidence is required`)
    }
  }

  const rowIds = new Set()
  for (const row of [...(ledger.requirements ?? []), ...(ledger.priorMilestoneAudits ?? [])]) {
    requireFields(errors, row, ['id', 'classification', 'owner', 'lane', 'evidence'])
    if (rowIds.has(row.id)) errors.push(`duplicate row ID: ${row.id}`)
    rowIds.add(row.id)
    if (!classifications.has(row.classification)) {
      errors.push(`${row.id}: invalid classification ${row.classification}`)
    }
    if (!validationLanes.has(row.lane)) {
      errors.push(`${row.id}: invalid validation lane ${String(row.lane)}`)
    }
    if (!Array.isArray(row.evidence) || row.evidence.length === 0) {
      errors.push(`${row.id}: evidence is required`)
    }
    if (row.classification !== 'verified') validateRowDisposition(errors, row)
    for (const evidence of row.evidence ?? []) {
      if (!evidence.kind) errors.push(`${row.id}: evidence.kind is required`)
      if (!evidence.path && !evidence.command && !evidence.artifact && !evidence.environment) {
        errors.push(`${row.id}: evidence must identify a path, command, artifact, or environment`)
      }
      if (evidence.path) {
        try {
          await access(resolve(root, evidence.path))
        } catch {
          errors.push(`${row.id}: evidence path does not exist: ${evidence.path}`)
        }
      }
    }
  }

  for (const requirement of ledger.requirements ?? []) {
    requireFields(errors, requirement, ['sourceId', 'heading', 'requirement', 'normativeState'])
    if (!sourceIds.has(requirement.sourceId)) {
      errors.push(`${requirement.id}: unknown source ${requirement.sourceId}`)
    }
    if (!normativeStates.has(requirement.normativeState)) {
      errors.push(`${requirement.id}: invalid normative state ${requirement.normativeState}`)
    }
    if (
      !Array.isArray(requirement.issueRefs) ||
      requirement.issueRefs.length === 0 ||
      requirement.issueRefs.some((issue) => !Number.isInteger(issue))
    ) {
      errors.push(`${requirement.id}: numeric issueRefs are required`)
    }
  }

  const inventoryRequirements = (ledger.requirementInventory ?? [])
    .map(({ id, sourceId }) => `${id}:${sourceId}`)
    .toSorted()
  const requirementRows = (ledger.requirements ?? [])
    .map(({ id, sourceId }) => `${id}:${sourceId}`)
    .toSorted()
  if (JSON.stringify(inventoryRequirements) !== JSON.stringify(requirementRows)) {
    errors.push(
      'requirementInventory and requirements must contain the same stable IDs and sources'
    )
  }

  for (const audit of ledger.priorMilestoneAudits ?? []) {
    requireFields(errors, audit, ['issue', 'title', 'milestone', 'assessment'])
    if (!/^M(?:10|[1-9])$/.test(audit.milestone)) {
      errors.push(`${audit.id}: invalid milestone ${audit.milestone}`)
    }
  }
  const inventoryIssues = (ledger.priorIssueInventory ?? [])
    .map(({ issue }) => issue)
    .toSorted(numeric)
  const auditIssues = (ledger.priorMilestoneAudits ?? [])
    .map(({ issue }) => issue)
    .toSorted(numeric)
  if (JSON.stringify(inventoryIssues) !== JSON.stringify(auditIssues)) {
    errors.push('priorIssueInventory and priorMilestoneAudits must contain the same issue IDs')
  }

  for (const contradiction of ledger.contradictions ?? []) {
    requireFields(errors, contradiction, ['id', 'topic', 'sources', 'resolution', 'issue'])
  }
  if (!Array.isArray(ledger.reviewerSamples) || ledger.reviewerSamples.length === 0) {
    errors.push('reviewerSamples must include independent reproduction evidence')
  }
  for (const sample of ledger.reviewerSamples ?? []) {
    requireFields(errors, sample, [
      'reviewer',
      'scope',
      'command',
      'observedAt',
      'commit',
      'result',
    ])
    if (sample.commit !== ledger.candidate?.commit) {
      errors.push(`${sample.reviewer}: reviewer commit must match candidate.commit`)
    }
    if (/pending/i.test(sample.result) || /pending/i.test(sample.observedAt)) {
      errors.push(`${sample.reviewer}: reviewer result cannot be pending`)
    }
  }
  for (const run of ledger.verificationRuns ?? []) {
    requireFields(errors, run, ['id', 'command', 'observedAt', 'environment', 'result', 'commit'])
    if (run.commit !== ledger.candidate?.commit) {
      errors.push(`${run.id}: verification commit must match candidate.commit`)
    }
  }
  if (!Array.isArray(ledger.verificationRuns) || ledger.verificationRuns.length === 0) {
    errors.push('verificationRuns must identify exact commands and results')
  }
  return { errors, warnings, provenance, workerInventory }
}

export async function listGitHubIssues(options = {}) {
  const fetchImplementation = options.fetch ?? globalThis.fetch
  const repository = options.repository ?? 'adea-ai/control-plane'
  const token = options.token ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
  const isCi = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true'
  const useAuthenticatedGhCli = options.fetch === undefined && !token && !isCi
  const spawn = options.spawnSync ?? spawnSync
  const issues = []
  const maxPages = options.maxPages ?? 1000
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
    throw new Error('GitHub issues pagination bound must be a positive integer')
  }
  const endpoint = `https://api.github.com/repos/${repository}/issues`
  let requestUrl = `${endpoint}?state=all&per_page=100&page=1`
  for (let page = 1; page <= maxPages; page += 1) {
    const response = useAuthenticatedGhCli
      ? requestGitHubIssuesWithGh(requestUrl, spawn)
      : await fetchImplementation(requestUrl, {
          headers: {
            accept: 'application/vnd.github+json',
            'user-agent': 'control-plane-requirements-ledger',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
        })
    if (!response.ok) {
      throw new Error(`Unable to query GitHub issues (${response.status})`)
    }
    const pageItems = await response.json()
    if (!Array.isArray(pageItems)) throw new Error('GitHub issues response was not an array')
    issues.push(
      ...pageItems
        .filter((issue) => issue.pull_request === undefined)
        .map((issue) => ({
          number: issue.number,
          title: issue.title,
          milestone: issue.milestone && {
            number: issue.milestone.number,
            title: issue.milestone.title,
          },
          url: issue.html_url,
          state: String(issue.state).toUpperCase(),
          closedAt: issue.closed_at,
        }))
    )
    // GitHub may canonicalize links to /repositories/<numeric-id>/issues.
    // Requests still use the trusted repository above, never the supplied link target.
    const link = response.headers?.get('link')
    const nextLinks = link?.split(',').filter((entry) => /;\s*rel="next"/.test(entry)) ?? []
    if (nextLinks.length > 1) throw new Error('Invalid GitHub issues next-page link')
    let hasNext
    if (response.headers) {
      hasNext = nextLinks.length === 1
      if (hasNext) {
        const target = nextLinks[0].match(/^\s*<([^>]+)>/)
        if (!target) throw new Error('Invalid GitHub issues next-page link')
        const next = new URL(target[1])
        if (
          next.origin !== 'https://api.github.com' ||
          (next.pathname !== `/repos/${repository}/issues` &&
            !/^\/repositories\/[1-9][0-9]*\/issues$/.test(next.pathname)) ||
          next.username ||
          next.password ||
          next.hash ||
          next.searchParams.get('state') !== 'all' ||
          next.searchParams.get('per_page') !== '100' ||
          next.searchParams.get('page') !== String(page + 1) ||
          [...next.searchParams.keys()].some(
            (key) =>
              !['state', 'per_page', 'page', 'after'].includes(key) ||
              next.searchParams.getAll(key).length !== 1
          )
        )
          throw new Error('Invalid GitHub issues next-page link')
        requestUrl = `${endpoint}${next.search}`
      }
    } else {
      // Fetch seams without HTTP headers retain the REST page-size convention.
      hasNext = pageItems.length === 100
      requestUrl = `${endpoint}?state=all&per_page=100&page=${page + 1}`
    }
    if (!hasNext) return issues
    if (page === maxPages) throw new Error('GitHub issues pagination exceeded defensive bound')
  }
  throw new Error('GitHub issues pagination exceeded defensive bound')
}

function gitHubCliHttpStatus(output) {
  const match = /^HTTP\/\S+\s+(\d{3})(?:\s|$)/m.exec(output)
  return match ? Number(match[1]) : undefined
}

function parseGitHubCliResponse(output) {
  const separator = /\r?\n\r?\n/.exec(output)
  if (!separator) throw new Error('Invalid response from authenticated GitHub CLI')
  const headerBlock = output.slice(0, separator.index)
  const body = output.slice(separator.index + separator[0].length)
  const lines = headerBlock.split(/\r?\n/)
  const status = gitHubCliHttpStatus(lines[0] ?? '')
  if (!status) throw new Error('Invalid response from authenticated GitHub CLI')
  const headers = new Headers()
  try {
    for (const line of lines.slice(1)) {
      const separatorIndex = line.indexOf(':')
      if (separatorIndex <= 0) throw new Error('malformed header')
      headers.append(line.slice(0, separatorIndex), line.slice(separatorIndex + 1).trim())
    }
  } catch {
    throw new Error('Invalid response from authenticated GitHub CLI')
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    json: async () => {
      try {
        return JSON.parse(body)
      } catch {
        throw new Error('GitHub issues response was not valid JSON')
      }
    },
  }
}

function requestGitHubIssuesWithGh(requestUrl, spawn) {
  const url = new URL(requestUrl)
  if (url.origin !== 'https://api.github.com') {
    throw new Error('Invalid trusted GitHub issues endpoint')
  }
  const endpoint = `${url.pathname}${url.search}`
  let result
  try {
    result = spawn(
      'gh',
      [
        'api',
        '--include',
        '--hostname',
        'github.com',
        '--header',
        'Accept: application/vnd.github+json',
        '--header',
        'User-Agent: control-plane-requirements-ledger',
        endpoint,
      ],
      {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        timeout: 30_000,
        windowsHide: true,
      }
    )
  } catch {
    throw new Error('Unable to query GitHub issues through authenticated GitHub CLI')
  }
  if (result.error) {
    const code =
      typeof result.error.code === 'string' && /^[A-Z0-9_]+$/.test(result.error.code)
        ? result.error.code
        : 'UNKNOWN'
    throw new Error(`Unable to query GitHub issues through authenticated GitHub CLI (${code})`)
  }
  const output = typeof result.stdout === 'string' ? result.stdout : ''
  if (result.status !== 0) {
    const status = gitHubCliHttpStatus(output)
    if (status) throw new Error(`Unable to query GitHub issues (${status})`)
    const exit = Number.isSafeInteger(result.status) ? result.status : 'unknown'
    throw new Error(`Unable to query GitHub issues through authenticated GitHub CLI (exit ${exit})`)
  }
  return parseGitHubCliResponse(output)
}

export function refreshPriorMilestoneAudits(ledger, issues, additionalGapIssues = []) {
  const issueByNumber = new Map(issues.map((issue) => [issue.number, issue]))
  const legacyGapIssues = [
    ...ledger.sources,
    ...ledger.deploymentProfiles,
    ...ledger.requirements,
    ...ledger.priorMilestoneAudits,
  ]
    .map(({ gap }) => gap?.issue)
    .filter((issue) => issue !== undefined)
  const gapIssues = [...legacyGapIssues, ...additionalGapIssues]
  if (gapIssues.length > 0) gapIssues.push(197)
  const invalidGapIssues = [...new Set(gapIssues)].flatMap((issueNumber) => {
    const issue = issueByNumber.get(issueNumber)
    // Authorized R2 architecture successor: https://github.com/adea-ai/control-plane/issues/931.
    // This never moves a legacy requirement/source/audit gap out of original M11 (#11).
    const expectedMilestone =
      issueNumber === 931 && additionalGapIssues.includes(931) && !legacyGapIssues.includes(931)
        ? 20
        : 11
    if (
      issue?.state === 'OPEN' &&
      isCanonicalControlPlaneIssue(issue) &&
      issue.milestone?.number === expectedMilestone
    )
      return []
    return [
      `#${issueNumber} (${issue?.state ?? 'MISSING'}, ${issue?.milestone?.title ?? 'no milestone'})`,
    ]
  })
  if (invalidGapIssues.length > 0) {
    throw new Error(
      `Gap issues must be open in their authorized Control Plane milestone: ${invalidGapIssues.join(', ')}`
    )
  }
  // Repository numbers are stable through roadmap ordering/title changes. #10 is M12;
  // historical M10 is repository milestone #12, not #10.
  const priorMilestones = new Map([
    [1, 'M1'],
    [2, 'M2'],
    [3, 'M3'],
    [4, 'M4'],
    [5, 'M5'],
    [6, 'M6'],
    [7, 'M7'],
    [8, 'M8'],
    [9, 'M9'],
    [12, 'M10'],
  ])
  const audits = new Map(ledger.priorMilestoneAudits.map((row) => [row.issue, row]))
  // Reviewed display titles keep repository presentation current; issue identity,
  // milestone, closure and inventory membership still come from live GitHub metadata.
  for (const audit of audits.values()) {
    if (
      audit.displayTitle !== undefined &&
      (typeof audit.displayTitle !== 'string' ||
        !audit.displayTitle.trim() ||
        audit.displayTitle.length > 300 ||
        /[\r\n\0]/.test(audit.displayTitle))
    )
      throw new Error('Invalid audited issue display title')
  }
  const inventory = issues
    .filter(
      (issue) => isCanonicalControlPlaneIssue(issue) && priorMilestones.has(issue.milestone?.number)
    )
    .map((issue) => ({
      issue: issue.number,
      title: audits.get(issue.number)?.displayTitle ?? issue.title,
      milestone: priorMilestones.get(issue.milestone.number),
      closedAt: issue.closedAt,
      url: issue.url,
    }))
    .toSorted((left, right) => left.issue - right.issue)
  const missing = inventory.filter(({ issue }) => !audits.has(issue))
  const removed = [...audits.keys()].filter(
    (issue) => !inventory.some((entry) => entry.issue === issue)
  )
  if (missing.length > 0 || removed.length > 0) {
    throw new Error(
      `Issue inventory drift requires explicit audit: missing [${missing.map(({ issue }) => issue).join(', ')}], removed [${removed.join(', ')}]`
    )
  }
  return {
    ...ledger,
    requirementInventory: ledger.requirements.map(({ id, sourceId }) => ({ id, sourceId })),
    priorIssueInventory: inventory,
    priorMilestoneAudits: inventory.map((issue) => ({
      ...audits.get(issue.issue),
      title: issue.title,
      milestone: issue.milestone,
    })),
  }
}

function isCanonicalControlPlaneIssue(issue) {
  return (
    Number.isSafeInteger(issue.number) &&
    issue.number > 0 &&
    issue.url === `https://github.com/adea-ai/control-plane/issues/${issue.number}`
  )
}

export async function renderRequirementsReport(ledger, root = repositoryRoot) {
  const canonical = await collectCanonicalCrosswalk(ledger, root)
  if (canonical.errors.length > 0) throw new Error(canonical.errors.join('\n'))
  const crosswalk = canonical.crosswalk
  const linked = crosswalk.atomicSummary
  const counts = countBy(ledger.requirements, 'classification')
  const auditCounts = countBy(ledger.priorMilestoneAudits, 'classification')
  const lines = [
    '# Control Plane requirements and prior-milestone evidence ledger',
    '',
    `Generated from [control-plane-requirements.v1.json](./control-plane-requirements.v1.json) for candidate \`${ledger.candidate.commit}\`. Do not edit this report directly; run \`bun run requirements:write\`.`,
    '',
    'The candidate metadata and independent review below describe the recorded audit baseline, not the current branch head. Later requirement-level evidence is scoped to its own cited commit and does not re-certify that baseline or establish whole-milestone completion.',
    '',
    '## Candidate',
    '',
    `- Audited commit: \`${ledger.candidate.commit}\` (\`${ledger.candidate.ref}\`)`,
    `- Recorded at: ${ledger.candidate.recordedAt}`,
    `- Toolchain: Node ${ledger.candidate.toolchain.node}; Bun ${ledger.candidate.toolchain.bun}; Restate ${ledger.candidate.toolchain.restate}`,
    `- Contract/schema versions: ${formatObject(ledger.candidate.versions)}`,
    `- Committed ledger artifacts: ${ledger.candidate.artifacts.map((artifact) => `\`${artifact}\``).join(', ')}`,
    `- Reconciled against \`${ledger.reconciliation?.reconciliationBase ?? '—'}\` on ${ledger.reconciliation?.reconciledAt ?? '—'}; the recorded candidate covers that base: ${ledger.reconciliation?.candidateProof?.coversReconciliationBase === false ? 'no — the candidate evidence is a historical baseline only' : 'not recorded'}.`,
    '',
    '## Summary',
    '',
    `- ${ledger.requirements.length} bounded normative requirement rows: ${formatCounts(counts)}.`,
    `- ${ledger.sources.reduce((count, source) => count + (source.atomicInventory?.atoms ?? 0), 0)} captured source clauses in the [machine-readable atomic clause register](./control-plane-atomic-clauses.v1.json). These include obligations, definitions, fields, and explicit source dispositions; full atom-to-requirement mapping and candidate acceptance remain incomplete.`,
    `- ${linked.linkCount} explicit existing requirement-to-atom links in the [machine-readable crosswalk](./control-plane-atomic-crosswalk.v1.json), covering ${linked.mappedRequirementCount} bounded requirement rows and ${linked.mappedAtomCount} distinct atoms. ${linked.unmappedAtomCount} atoms and ${linked.unlinkedRequirementCount} bounded rows have no explicit link. Links preserve recorded crosswalk qualifications and do not establish implementation, profile coverage, passing evidence or acceptance.`,
    `- ${crosswalk.summary.sourcesWithCurrentRevision} of ${crosswalk.summary.normativeSources} normative sources have a recorded current revision and ${crosswalk.summary.sourcesWithChangedText} of them changed text after the captured revision. ${crosswalk.summary.clausesWithChangedSourceText} captured clauses are affected by that change and ${crosswalk.summary.currentClauses} current clauses are recorded in the [source lineage register](./canonical-source-lineage-2026-10-03.v1.json).`,
    `- ${ledger.priorMilestoneAudits.length} M1–M10 issue audits: ${formatCounts(auditCounts)}.`,
    `- ${ledger.contradictions.length} explicit contradictions or supersessions.`,
    `- ${crosswalk.summary.externalGates} external acceptance gates remain recorded and ${crosswalk.summary.workersIntegrated} of ${crosswalk.summary.workers} worker contributions are integrated.`,
    '',
    '## Normative sources',
    '',
    '| Source | Provider | Revision / modified time | Checked-in source audit | Requirements |',
    '| --- | --- | --- | --- | ---: |',
    ...ledger.sources.map((source) => {
      const sourceAudit = source.sourceAudit
        ? `partial extraction — [${basename(source.sourceAudit.path)}](./${basename(source.sourceAudit.path)})`
        : '—'
      return `| [${escapeCell(source.title)}](${source.uri}) | ${source.provider} | ${source.updatedAt} | ${sourceAudit} | ${ledger.requirements.filter(({ sourceId }) => sourceId === source.id).length} |`
    }),
    '',
    '## Current source revision and atomic clause reconciliation',
    '',
    'Captured revisions are the pinned text captures behind the atomic inventories. Current revisions and text hashes come from the recorded freshness observation; clause text status comes from the source lineage register. No current clause, figure or profile result is promoted by this table.',
    '',
    '| Source | Captured revision | Current revision | Current text SHA-256 | Clauses | Changed clauses | Current clauses | Linked clauses | Unlinked clauses | Embedded objects |',
    '| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |',
    ...crosswalk.sources.map(
      (source) =>
        `| ${escapeCell(source.title)} | ${source.capturedRevision} | ${source.currentRevision ?? '—'} | ${source.currentTextSha256 ? `\`${source.currentTextSha256}\`` : '—'} | ${source.atomicClauses} | ${source.clausesWithChangedSourceText} | ${source.currentClauses} | ${source.linkedClauses} | ${source.unlinkedClauses} | ${source.embeddedObjects ? `${source.embeddedObjects.currentObjects} current; ${source.embeddedObjects.identitiesAdded} new; ${source.embeddedObjects.identitiesAbsent} absent; nested tabs inventoried: ${source.embeddedObjects.nestedTabsInventoried ? 'yes' : 'no'}` : '—'} |`
    ),
    '',
    '## Deployment profiles',
    '',
    '| Profile | Composition | Classification | Evidence identity | Result | Gap / disposition |',
    '| --- | --- | --- | --- | --- | --- |',
    ...ledger.deploymentProfiles.map(
      (profile) =>
        `| ${profile.id} | ${escapeCell(profile.composition)} | ${profile.classification} | ${profile.observedAt}; \`${profile.commit}\`<br>${profile.evidence.map(formatEvidence).join('<br>')} | ${escapeCell(profile.result)} | ${formatGap(profile.gap)} |`
    ),
    '',
    '## Requirements',
    '',
    '| ID | Source heading | Requirement | State | Classification | Owner | Lane | Evidence | Gap / disposition |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...ledger.requirements.map(
      (row) =>
        `| ${row.id} | ${escapeCell(sourceTitle(ledger, row.sourceId))}: ${escapeCell(row.heading)} | ${escapeCell(row.requirement)} | ${row.normativeState} | ${row.classification} | ${escapeCell(row.owner)} | ${escapeCell(row.lane)} | ${row.evidence.map(formatEvidence).join('<br>')} | ${formatGap(row.gap)} |`
    ),
    '',
    '## Canonical crosswalk',
    '',
    'The machine-readable form of this table is [control-plane-requirements-crosswalk.v1.json](./control-plane-requirements-crosswalk.v1.json). It joins the current source revision, the captured atomic clause, the bounded requirement row, the reachable code/test/profile targets, and the issue and evidence records. Target columns are derived from recorded evidence paths and never assert that a deployment profile was exercised.',
    '',
    '| ID | Source | Atomic clauses | Source text status | Code targets | Test targets | Profile targets | Issues | Classification | Disposition |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...crosswalk.requirements.map(
      (row) =>
        `| ${row.id} | ${escapeCell(row.sourceId)} | ${row.atomicClauses.length === 0 ? '—' : row.atomicClauses.map((id) => `\`${id}\``).join('<br>')} | ${row.sourceTextStatus} | ${row.targets.code.length === 0 ? '—' : row.targets.code.map((path) => `\`${path}\``).join('<br>')} | ${row.targets.test.length === 0 ? '—' : row.targets.test.map((path) => `\`${path}\``).join('<br>')} | ${row.profileTargets.length === 0 ? '—' : row.profileTargets.join('<br>')} | ${row.issueRefs.map((issue) => `#${issue}`).join('<br>')} | ${row.classification} | ${row.gap ? formatGap(row.gap) : formatSupersession(row.supersession)} |`
    ),
    '',
    '## Prior milestone audit',
    '',
    '| Issue | Milestone | Current classification | Owner | Lane | Current reachable evidence | Assessment | Gap / disposition |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...ledger.priorMilestoneAudits.map(
      (row) =>
        `| [#${row.issue}](https://github.com/adea-ai/control-plane/issues/${row.issue}) ${escapeCell(row.title)} | ${row.milestone} | ${row.classification} | ${escapeCell(row.owner)} | ${escapeCell(row.lane)} | ${row.evidence.map(formatEvidence).join('<br>')} | ${escapeCell(row.assessment)} | ${formatGap(row.gap)} |`
    ),
    '',
    '## Contradictions and supersessions',
    '',
    '| ID | Topic | Sources | Resolution | Owner issue |',
    '| --- | --- | --- | --- | --- |',
    ...ledger.contradictions.map(
      (row) =>
        `| ${row.id} | ${escapeCell(row.topic)} | ${row.sources.map(escapeCell).join('<br>')} | ${escapeCell(row.resolution)} | [#${row.issue}](https://github.com/adea-ai/control-plane/issues/${row.issue}) |`
    ),
    '',
    '## GitHub issue reconciliation',
    '',
    `Recorded from ${ledger.githubIssueSnapshot?.repository} on ${ledger.githubIssueSnapshot?.retrievedAt} (${ledger.githubIssueSnapshot?.method}). The repository documentation labels this milestone ${ledger.githubIssueSnapshot?.repositoryMilestoneLabel}; GitHub currently renders the same milestone as “${ledger.githubIssueSnapshot?.githubMilestoneTitle}”. Issue numbers are the stable identity and display titles are informational. A recorded open state is not evidence that the acceptance criteria hold.`,
    '',
    '| Issue | GitHub title | State | Milestone | Repository documentation label |',
    '| --- | --- | --- | ---: | --- |',
    ...(ledger.githubIssueSnapshot?.issues ?? []).map(
      (issue) =>
        `| [#${issue.number}](${issue.url}) | ${escapeCell(issue.title)} | ${issue.state} | ${issue.milestone} | ${escapeCell(issue.repositoryDocumentationLabel ?? '—')} |`
    ),
    '',
    '## Worker evidence',
    '',
    'Contributions are integrated by stable worker ID and exact head. A pending lane is not evidence; it records the next executable action only.',
    '',
    '| Worker | Lane | Status | Exact head | Issues | Evidence | Next action |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...(ledger.workerEvidence ?? []).map(
      (worker) =>
        `| ${worker.id} | ${escapeCell(worker.lane)} | ${worker.status} | ${worker.head ? `\`${worker.head}\`` : '—'} | ${(worker.issueRefs ?? []).map((issue) => `#${issue}`).join('<br>')} | ${(worker.evidence ?? []).map((entry) => `\`${entry.path}\``).join('<br>') || '—'} | ${escapeCell(worker.nextAction ?? '—')} |`
    ),
    '',
    '## Open acceptance gates',
    '',
    'These gates are external to the repository. They stay open until their named owner closes them with evidence; this ledger never records them as satisfied.',
    '',
    '| Gate | Status | Severity | Owner | Issue | Disposition | Next executable action |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...(ledger.reconciliation?.externalGates ?? []).map(
      (gate) =>
        `| ${escapeCell(gate.id)}: ${escapeCell(gate.gate)} | ${gate.status} | ${gate.severity} | ${escapeCell(gate.owner)} | [#${gate.issue}](https://github.com/adea-ai/control-plane/issues/${gate.issue}) | ${escapeCell(gate.disposition)} | ${escapeCell(gate.nextAction)} |`
    ),
    '',
    '## Verification runs',
    '',
    '| Command | Commit | Observed at | Environment | Result |',
    '| --- | --- | --- | --- | --- |',
    ...ledger.verificationRuns.map(
      (run) =>
        `| \`${run.command}\` | \`${run.commit}\` | ${run.observedAt} | ${escapeCell(run.environment)} | ${escapeCell(run.result)} |`
    ),
    '',
    '## Independent review samples',
    '',
    '| Reviewer | Scope | Candidate / observed at | Command | Result |',
    '| --- | --- | --- | --- | --- |',
    ...ledger.reviewerSamples.map(
      (sample) =>
        `| ${escapeCell(sample.reviewer)} | ${escapeCell(sample.scope)} | \`${sample.commit}\`<br>${sample.observedAt} | \`${escapeCell(sample.command)}\` | ${escapeCell(sample.result)} |`
    ),
    '',
    '## Maintenance',
    '',
    'Run `bun run requirements:check` after changing this ledger or any referenced evidence. The check validates row shape, stable IDs, source coverage, gap ownership, reachable repository paths, the recorded GitHub issue snapshot, orphaned atomic clauses, stale candidate proof, worker contribution heads, and byte-for-byte report, crosswalk and figure-inventory drift.',
    '',
  ]
  return formatMarkdown(lines.join('\n'))
}

const evidenceTargetKinds = new Set([
  'code',
  'test',
  'document',
  'artifact',
  'environment',
  'evidence',
  'other',
])

// Evidence kinds are recorded by the ledger; this projection keeps the
// crosswalk's code/test/profile join deterministic and reviewable.
function evidenceTarget(evidence) {
  const path = typeof evidence.path === 'string' ? evidence.path : ''
  const kind = typeof evidence.kind === 'string' ? evidence.kind : 'other'
  if (kind === 'test') return 'test'
  if (kind === 'implementation') return 'code'
  if (kind === 'artifact') return 'artifact'
  if (kind === 'source') return 'artifact'
  if (kind === 'environment') return 'environment'
  if (kind === 'evidence') return 'evidence'
  if (kind === 'document')
    return /^(packages|apps|scripts)\//.test(path) && /\.(ts|mts|tsx|mjs|js|cjs)$/.test(path)
      ? 'code'
      : 'document'
  return 'other'
}

function uniqueSorted(values) {
  return [...new Set(values)].toSorted()
}

function severityValues() {
  return ['critical', 'high', 'medium', 'low']
}

// Every non-verified ledger row carries an owner, a severity and a disposition.
// Superseded rows keep that disposition in their supersession record instead of
// a gap reference, so no row is left without an accountable next step.
function validateRowDisposition(errors, row, label = 'row') {
  if (row.classification === 'verified') return
  if (row.classification === 'superseded') {
    const supersession = row.supersession
    if (!supersession) {
      errors.push(`${row.id}: ${label}.supersession is required for superseded rows`)
      return
    }
    for (const field of ['issue', 'severity', 'owner', 'disposition']) {
      if (supersession[field] === undefined || supersession[field] === '')
        errors.push(`${row.id}: ${label}.supersession.${field} is required for superseded rows`)
    }
    if (!Number.isInteger(supersession.issue))
      errors.push(`${row.id}: ${label}.supersession.issue must be numeric`)
    if (!severityValues().includes(supersession.severity))
      errors.push(`${row.id}: ${label}.supersession.severity is invalid`)
    return
  }
  validateGap(errors, row)
}

// Gap references must resolve to a recorded open issue. The recorded snapshot is
// the offline authority; the live refresh additionally fails closed when a gap
// issue is no longer open in its authorized milestone.
function validateGapReferences(ledger) {
  const errors = []
  const snapshot = ledger.githubIssueSnapshot
  if (!snapshot) {
    errors.push('githubIssueSnapshot is required to resolve gap references')
    return errors
  }
  if (snapshot.repository !== 'adea-ai/control-plane')
    errors.push('githubIssueSnapshot.repository must be adea-ai/control-plane')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshot.retrievedAt ?? ''))
    errors.push('githubIssueSnapshot.retrievedAt must be an ISO date')
  const recorded = new Map((snapshot.issues ?? []).map((issue) => [issue.number, issue]))
  if (recorded.size === 0) errors.push('githubIssueSnapshot.issues must not be empty')
  for (const [number, issue] of recorded) {
    if (!Number.isInteger(number) || number <= 0)
      errors.push('githubIssueSnapshot.issues must use positive numeric identities')
    if (issue.state !== 'OPEN' && issue.state !== 'CLOSED')
      errors.push(`#${number}: githubIssueSnapshot state must be OPEN or CLOSED`)
    if (issue.url !== `https://github.com/adea-ai/control-plane/issues/${number}`)
      errors.push(`#${number}: githubIssueSnapshot url must match the canonical issue identity`)
    if (!Number.isInteger(issue.milestone))
      errors.push(`#${number}: githubIssueSnapshot milestone must be numeric`)
  }
  const referenced = new Set()
  const rows = [
    ...(ledger.sources ?? []),
    ...(ledger.deploymentProfiles ?? []),
    ...(ledger.requirements ?? []),
    ...(ledger.priorMilestoneAudits ?? []),
  ]
  for (const row of rows) {
    const gap = row.gap
    if (!gap) continue
    if (!Number.isInteger(gap.issue)) {
      errors.push(`${row.id}: gap.issue must be numeric`)
      continue
    }
    referenced.add(gap.issue)
    const issue = recorded.get(gap.issue)
    if (!issue) {
      errors.push(`${row.id}: gap reference #${gap.issue} is missing from githubIssueSnapshot`)
      continue
    }
    if (issue.state !== 'OPEN')
      errors.push(`${row.id}: gap reference #${gap.issue} is closed and cannot carry an open gap`)
    if (issue.milestone !== 11 && !(gap.issue === 931 && issue.milestone === 20))
      errors.push(
        `${row.id}: gap reference #${gap.issue} must be open in Control Plane milestone 11`
      )
  }
  for (const row of rows) {
    const supersession = row.supersession
    if (!supersession || !Number.isInteger(supersession.issue)) continue
    referenced.add(supersession.issue)
    const issue = recorded.get(supersession.issue)
    if (!issue)
      errors.push(
        `${row.id}: supersession reference #${supersession.issue} is missing from githubIssueSnapshot`
      )
  }
  if (!recorded.has(186))
    errors.push('githubIssueSnapshot must record the #186 requirements-ledger acceptance issue')
  if (!recorded.has(195))
    errors.push('githubIssueSnapshot must record the #195 documentation-reconciliation issue')
  return errors
}

const clauseCollectionCache = new Map()
const atomicCrosswalkCache = new Map()

// The atomic inventories are large checked-in documents. Collecting them once
// per distinct ledger keeps the drift controls deterministic without repeating
// the same parse for every validator that needs the register. The key covers
// exactly the fields the collection reads, so unrelated ledger edits do not
// force a re-parse and real drift still invalidates the cache.
function atomicCollectionInputs(sources) {
  return (sources ?? []).map((source) =>
    Object.fromEntries(Object.entries(source).filter(([key]) => key !== 'embeddedObjects'))
  )
}

function atomicCacheKey(ledger, root) {
  const requirements = (ledger.requirements ?? []).map((row) => `${row.id}:${row.sourceId}`)
  return `${root}:${JSON.stringify(atomicCollectionInputs(ledger.sources))}:${JSON.stringify(requirements)}`
}

async function collectAtomicCrosswalkCached(ledger, root) {
  const key = atomicCacheKey(ledger, root)
  const cached = atomicCrosswalkCache.get(key)
  if (cached) return cached
  const collected = await collectAtomicCrosswalk(ledger, root)
  atomicCrosswalkCache.set(key, collected)
  return collected
}

async function validateAtomicClauseRegisterCached(sources, root) {
  const key = `${root}:${JSON.stringify(atomicCollectionInputs(sources))}`
  const cached = clauseCollectionCache.get(key)
  if (cached) return cached
  const errors = await validateAtomicClauseRegister(sources ?? [], root)
  clauseCollectionCache.set(key, errors)
  return errors
}

async function validateAtomicCrosswalkCached(ledger, root) {
  const collected = await collectAtomicCrosswalkCached(ledger, root)
  if (collected.errors.length > 0) return collected.errors
  let current
  try {
    current = JSON.parse(
      await readFile(
        resolve(root, 'docs/requirements/control-plane-atomic-crosswalk.v1.json'),
        'utf8'
      )
    )
  } catch {
    return ['Atomic crosswalk is missing or malformed']
  }
  return JSON.stringify(current) === JSON.stringify(collected.register)
    ? []
    : ['Atomic crosswalk drifted; run bun run requirements:crosswalk:write']
}

// Atoms without a requirement link are not silently dropped: each source records
// an accountable disposition for its unmapped atoms, and the count is exact so
// drift in either direction fails closed.
function validateAtomDispositions(ledger, register) {
  const errors = []
  const dispositions = new Map(
    (ledger.atomDispositions ?? []).map((entry) => [entry.sourceId, entry])
  )
  const sourceIds = new Set((ledger.sources ?? []).map(({ id }) => id))
  for (const source of register?.sources ?? []) {
    const unmapped = source.unmappedAtomIds?.length ?? 0
    const disposition = dispositions.get(source.sourceId)
    if (unmapped === 0) {
      if (disposition) errors.push(`${source.sourceId}: atom disposition is not required`)
      continue
    }
    if (!disposition) {
      errors.push(`${source.sourceId}: unmapped atomic clauses require an explicit disposition`)
      continue
    }
    for (const field of ['owner', 'severity', 'disposition', 'issue']) {
      if (disposition[field] === undefined || disposition[field] === '')
        errors.push(`${source.sourceId}: atom disposition ${field} is required`)
    }
    if (!Number.isInteger(disposition.issue))
      errors.push(`${source.sourceId}: atom disposition issue must be numeric`)
    if (!severityValues().includes(disposition.severity))
      errors.push(`${source.sourceId}: atom disposition severity is invalid`)
    if (disposition.unmappedAtoms !== unmapped)
      errors.push(
        `${source.sourceId}: atom disposition covers ${disposition.unmappedAtoms} unmapped clauses but the register has ${unmapped}`
      )
  }
  for (const entry of ledger.atomDispositions ?? []) {
    if (!sourceIds.has(entry.sourceId))
      errors.push(`${entry.sourceId}: atom disposition references an unknown normative source`)
  }
  const ids = (ledger.atomDispositions ?? []).map(({ sourceId }) => sourceId)
  if (new Set(ids).size !== ids.length) errors.push('atom dispositions must use unique source IDs')
  return errors
}

// The recorded candidate is a historical baseline. The reconciliation base is the
// commit the current reconciliation was performed against; a candidate that does
// not cover it may not be presented as current-candidate proof.
function validateCandidateProof(ledger, root, shallowRepository) {
  const errors = []
  const warnings = []
  const reconciliation = ledger.reconciliation
  if (!reconciliation) {
    errors.push('reconciliation is required to record the current crosswalk baseline')
    return { errors, warnings }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reconciliation.reconciledAt ?? ''))
    errors.push('reconciliation.reconciledAt must be an ISO date')
  if (!/^[0-9a-f]{40}$/.test(reconciliation.reconciliationBase ?? ''))
    errors.push('reconciliation.reconciliationBase must be a full Git commit')
  else {
    const ancestor = spawnSync(
      'git',
      ['merge-base', '--is-ancestor', reconciliation.reconciliationBase, 'HEAD'],
      {
        cwd: root,
        encoding: 'utf8',
      }
    )
    if (ancestor.status !== 0) {
      // A shallow checkout cannot answer the ancestry question, so the base is
      // reported as unverified. It is never counted as proven, and a full clone
      // still fails closed.
      if (shallowRepository)
        warnings.push(
          `reconciliation base ${reconciliation.reconciliationBase} ancestry is unverified in this shallow checkout; reproduce the ancestry check from a full clone`
        )
      else errors.push('reconciliation.reconciliationBase must be an ancestor of the current head')
    }
  }
  const proof = reconciliation.candidateProof
  if (!proof) {
    errors.push('reconciliation.candidateProof is required')
  } else {
    if (proof.candidateCommit !== ledger.candidate?.commit)
      errors.push('reconciliation.candidateProof.candidateCommit must match candidate.commit')
    const covers = proof.candidateCommit === reconciliation.reconciliationBase
    if (proof.coversReconciliationBase !== covers)
      errors.push('reconciliation.candidateProof.coversReconciliationBase is inaccurate')
    if (!covers) {
      for (const field of ['severity', 'owner', 'disposition']) {
        if (proof[field] === undefined || proof[field] === '')
          errors.push(`reconciliation.candidateProof.${field} is required for a stale candidate`)
      }
      if (!severityValues().includes(proof.severity))
        errors.push('reconciliation.candidateProof.severity is invalid')
    }
  }
  const gates = reconciliation.externalGates ?? []
  if (!Array.isArray(gates) || gates.length === 0)
    errors.push('reconciliation.externalGates must record the remaining external gates')
  for (const gate of gates) {
    for (const field of ['id', 'gate', 'status', 'owner', 'severity', 'issue', 'disposition']) {
      if (gate[field] === undefined || gate[field] === '')
        errors.push(`${gate.id ?? 'gate'}: ${field} is required`)
    }
    if (!['blocked', 'pending', 'satisfied'].includes(gate.status))
      errors.push(`${gate.id}: external gate status is invalid`)
    if (!severityValues().includes(gate.severity))
      errors.push(`${gate.id}: external gate severity is invalid`)
    if (!Number.isInteger(gate.issue))
      errors.push(`${gate.id}: external gate issue must be numeric`)
  }
  const gateIds = gates.map(({ id }) => id)
  if (new Set(gateIds).size !== gateIds.length)
    errors.push('reconciliation.externalGates must use unique stable IDs')
  return { errors, warnings }
}

// Resolve many revision:path pairs in one Git call. Each pair resolves to the
// committed blob id, or to null when that revision does not carry the path. A
// path that exists is not the same artifact as the path with the same name at
// another revision, so identity is compared by blob.
function resolveBlobs(root, pairs) {
  const resolved = new Map()
  if (pairs.length === 0) return resolved
  const result = spawnSync('git', ['cat-file', '--batch-check'], {
    cwd: root,
    encoding: 'utf8',
    input: `${pairs.map(([revision, path]) => `${revision}:${path}`).join('\n')}\n`,
  })
  const lines = (result.stdout ?? '').trim().split('\n')
  if (result.status !== 0 || lines.length !== pairs.length) {
    // The batch call did not answer every query, so nothing is resolved by
    // position. Each pair is resolved on its own rather than letting a short
    // answer shift a blob onto the wrong path.
    for (const [revision, path] of pairs) {
      const single = spawnSync('git', ['rev-parse', '--verify', '-q', `${revision}:${path}`], {
        cwd: root,
        encoding: 'utf8',
      })
      const value = (single.stdout ?? '').trim()
      if (single.status === 0 && value.length > 0) resolved.set(`${revision}:${path}`, value)
    }
    return resolved
  }
  pairs.forEach(([revision, path], index) => {
    const match = /^([0-9a-f]{40})\s/.exec(lines[index] ?? '')
    if (match) resolved.set(`${revision}:${path}`, match[1])
  })
  return resolved
}

// Worker contributions are integrated by stable ID and exact head. A contribution
// that has not arrived stays pending instead of being reported as evidence. The
// evidence of a received contribution is proven against the tree of its own head,
// because the lane's files are not in this branch until it is merged.
//
// A path that resolves at the recorded head is not the reviewed artifact when the
// same path in this tree carries different content: a lane may rewrite a file
// that already existed here. The blob identity of every recorded evidence path is
// therefore compared between the recorded head and this tree, and a difference is
// reported as provenance so it can never be read as coverage.
//
// A shallow checkout does not fetch the lanes' own branches. A head that cannot
// be resolved there is reported as unverified, with its evidence paths, and is
// skipped by the per-path checks so that nothing is read as verified or as
// absent. A full clone still fails closed on an unresolvable head.
export function validateWorkerEvidence(ledger, root, shallowRepository) {
  const errors = []
  const warnings = []
  const provenance = []
  const workers = ledger.workerEvidence ?? []
  if (!Array.isArray(workers) || workers.length === 0)
    errors.push('workerEvidence must record the contributing lanes')
  const headAvailable = (head) =>
    spawnSync('git', ['cat-file', '-e', `${head}^{commit}`], { cwd: root, encoding: 'utf8' })
      .status === 0
  const unverifiedHeads = new Set()
  const unavailableHeads = new Set()
  const inventory = []
  const blobPairs = []
  for (const worker of workers) {
    if (worker.status === 'pending') continue
    if (!/^[0-9a-f]{40}$/.test(worker.head ?? '')) continue
    if (!headAvailable(worker.head)) {
      unavailableHeads.add(worker.id)
      if (shallowRepository) unverifiedHeads.add(worker.id)
      continue
    }
    for (const entry of worker.evidence ?? []) {
      if (!entry.path) continue
      blobPairs.push([worker.head, entry.path], ['HEAD', entry.path])
    }
  }
  const blobs = resolveBlobs(root, blobPairs)
  const ids = new Set()
  for (const worker of workers) {
    if (!/^W\d+$/.test(worker.id ?? '')) errors.push(`${worker.id}: worker ID is invalid`)
    if (ids.has(worker.id)) errors.push(`duplicate worker ID: ${worker.id}`)
    ids.add(worker.id)
    if (!['pending', 'received', 'integrated'].includes(worker.status))
      errors.push(`${worker.id}: worker status is invalid`)
    if (!worker.lane) errors.push(`${worker.id}: worker lane is required`)
    if (!Array.isArray(worker.issueRefs) || worker.issueRefs.length === 0)
      errors.push(`${worker.id}: worker issueRefs are required`)
    if (worker.issueRefs.some((issue) => !Number.isInteger(issue)))
      errors.push(`${worker.id}: worker issueRefs must be numeric`)
    if (worker.status === 'pending') {
      if (worker.head !== null && worker.head !== undefined)
        errors.push(`${worker.id}: a pending worker must not record a head`)
      continue
    }
    if (!/^[0-9a-f]{40}$/.test(worker.head ?? '')) {
      errors.push(`${worker.id}: a received worker must record an exact full Git head`)
      continue
    }
    const unverified = unverifiedHeads.has(worker.id)
    if (unverified) {
      warnings.push(
        `${worker.id} (${worker.lane}): worker head ${worker.head} is unavailable in this shallow checkout; ${(worker.evidence ?? []).length} recorded evidence paths are unverified and must be reproduced from a full clone`
      )
    } else if (!headAvailable(worker.head)) {
      errors.push(`${worker.id}: worker head ${worker.head} is unavailable in the repository`)
    }
    const diverged = []
    for (const entry of worker.evidence ?? []) {
      if (!entry.path) {
        errors.push(`${worker.id}: worker evidence must identify a path`)
        continue
      }
      if (entry.commit !== worker.head) {
        errors.push(
          `${worker.id}: worker evidence commit must match the worker head for ${entry.path}`
        )
      }
      if (unverified) continue
      const headBlob = blobs.get(`${worker.head}:${entry.path}`)
      if (!headBlob) {
        errors.push(
          `${worker.id}: worker evidence path is absent at head ${worker.head}: ${entry.path}`
        )
        continue
      }
      const treeBlob = blobs.get(`HEAD:${entry.path}`)
      inventory.push({
        worker: worker.id,
        path: entry.path,
        headBlob,
        treeBlob: treeBlob ?? null,
        state: !treeBlob ? 'absent-in-tree' : headBlob === treeBlob ? 'identical' : 'differs',
      })
      if (treeBlob && headBlob !== treeBlob)
        diverged.push(`${entry.path} (${headBlob} at ${worker.head}, ${treeBlob} at HEAD)`)
    }
    if (diverged.length > 0) {
      provenance.push(
        `${worker.id} (${worker.lane}): ${diverged.length} of ${(worker.evidence ?? []).length} evidence paths resolve to different content in this tree: ${diverged.join('; ')}; a matching path is not the reviewed artifact`
      )
    }
    if (worker.status === 'integrated') {
      for (const entry of worker.evidence ?? []) {
        if (!entry.path) continue
        try {
          accessSync(resolve(root, entry.path))
        } catch {
          errors.push(
            `${worker.id}: integrated worker evidence is absent from this tree: ${entry.path}`
          )
        }
      }
    }
  }
  // The inventory is complete only when every received lane's head resolved, so a
  // record bound to it is never checked against a partial answer.
  return {
    errors,
    warnings,
    provenance,
    inventory: { entries: inventory, complete: unavailableHeads.size === 0 },
  }
}

// The reconciliation record lists every worker evidence path whose content in the
// tree differs from the content at the lane's recorded head, with both blob
// identities. The lane-side identity is immutable, so it is an error when it is
// wrong. A path or lane that is missing from, or invented by, the table is an
// error too. The tree-side identity follows later commits, so a stale one is
// returned as provenance instead. The record cannot name its own tree identity, so
// the row for the record itself is exempt from the blob comparison.
//
// The structure of the section fails closed whatever the history: a missing
// record, a missing section, a missing lane statement, a duplicated (worker, path)
// row and a lane statement that contradicts its own table or the ledger are errors
// even when the inventory is incomplete. Only the comparison against the recorded
// heads needs their blobs, so only that comparison is skipped, and `compared` says
// so.
export function validateWorkerContentBinding(record, inventory, options = {}) {
  const errors = []
  const provenance = []
  if (record === undefined) {
    errors.push('reconciliation record is missing, so its worker content binding cannot be checked')
    return { errors, provenance, compared: false }
  }
  const recordPath =
    options.recordPath ?? 'docs/requirements/cp186-195-reconciliation-2026-10-21.md'
  const heading = '### Worker evidence content binding'
  const start = record.indexOf(heading)
  if (start === -1) {
    errors.push(`reconciliation record is missing the "${heading.slice(4)}" section`)
    return { errors, provenance, compared: false }
  }
  const rest = record.slice(start + heading.length)
  const next = rest.search(/\n#{2,3} /)
  const section = next === -1 ? rest : rest.slice(0, next)
  const cell = (line, index) => line.split('|')[index]?.trim().replaceAll('`', '') ?? ''
  const rows = section
    .split('\n')
    .filter((line) => line.startsWith('| ') && /^W\d+$/.test(cell(line, 1)))
    .map((line) => ({
      worker: cell(line, 1),
      path: cell(line, 2),
      headBlob: cell(line, 3),
      treeBlob: cell(line, 4),
    }))
  const key = (worker, path) => `${worker} ${path}`
  const recorded = new Map()
  for (const row of rows) {
    const id = key(row.worker, row.path)
    if (recorded.has(id)) {
      errors.push(
        `reconciliation record lists ${row.worker} ${row.path} more than once; a duplicated row can hide a wrong blob`
      )
      continue
    }
    recorded.set(id, row)
  }
  const lanes = /Lanes with such a path: (\d+) of (\d+)/.exec(section)
  if (!lanes) {
    errors.push('reconciliation record must state "Lanes with such a path: N of M"')
  } else {
    const tabulated = new Set(rows.map(({ worker }) => worker)).size
    if (Number(lanes[1]) !== tabulated)
      errors.push(
        `reconciliation record says ${lanes[1]} lanes have a differing path, its table lists ${tabulated}`
      )
    if (options.workerCount !== undefined && Number(lanes[2]) !== options.workerCount)
      errors.push(
        `reconciliation record says ${lanes[2]} lanes in total, the ledger records ${options.workerCount}`
      )
  }
  if (!inventory.complete) return { errors, provenance, compared: false }
  const expected = inventory.entries.filter(({ state }) => state === 'differs')
  const actual = new Map(expected.map((entry) => [key(entry.worker, entry.path), entry]))
  for (const [id, entry] of actual) {
    const row = recorded.get(id)
    if (!row) {
      errors.push(
        `reconciliation record omits the differing worker evidence path ${entry.worker} ${entry.path}`
      )
      continue
    }
    if (row.headBlob !== entry.headBlob)
      errors.push(
        `reconciliation record ${entry.worker} ${entry.path} lists lane blob ${row.headBlob}, the recorded head carries ${entry.headBlob}`
      )
    if (entry.path !== recordPath && row.treeBlob !== entry.treeBlob)
      provenance.push(
        `reconciliation record ${entry.worker} ${entry.path} lists tree blob ${row.treeBlob}, this tree carries ${entry.treeBlob}`
      )
  }
  for (const [id, row] of recorded) {
    if (!actual.has(id))
      errors.push(
        `reconciliation record lists ${row.worker} ${row.path} as differing, but its content is not different from the recorded head`
      )
  }
  const expectedLanes = new Set(expected.map(({ worker }) => worker)).size
  if (lanes && Number(lanes[1]) !== expectedLanes)
    errors.push(
      `reconciliation record says ${lanes[1]} lanes have a differing path, the recorded heads show ${expectedLanes}`
    )
  return { errors, provenance, compared: true }
}

// The profile and requirement rows are joined in two directions: a requirement row
// names the profiles its recorded evidence came from, and a profile row links the
// requirements it covers. The two directions are derived from different evidence
// kinds, so they can disagree. A disagreement means the profile column cannot be
// read as a coverage claim, and it is reported instead of being inferred from an
// empty array.
function profileJoinProvenance(ledger) {
  const findings = []
  const profileEvidencePaths = new Map()
  for (const profile of ledger.deploymentProfiles ?? []) {
    profileEvidencePaths.set(
      profile.id,
      new Set((profile.evidence ?? []).map((entry) => entry.path).filter(Boolean))
    )
  }
  const namedByProfile = new Map()
  for (const requirement of ledger.requirements ?? []) {
    const named = new Set()
    for (const entry of requirement.evidence ?? []) {
      if (entry.profile) named.add(entry.profile)
      for (const [profileId, paths] of profileEvidencePaths)
        if (entry.path && paths.has(entry.path)) named.add(profileId)
    }
    for (const profileId of named) {
      if (!namedByProfile.has(profileId)) namedByProfile.set(profileId, [])
      namedByProfile.get(profileId).push(requirement.id)
    }
  }
  for (const profile of ledger.deploymentProfiles ?? []) {
    const paths = profileEvidencePaths.get(profile.id) ?? new Set()
    const named = (namedByProfile.get(profile.id) ?? []).toSorted()
    const linked = (ledger.requirements ?? [])
      .filter((requirement) =>
        (requirement.evidence ?? []).some(
          (entry) =>
            entry.path &&
            paths.has(entry.path) &&
            ['code', 'test', 'document'].includes(evidenceTarget(entry))
        )
      )
      .map((requirement) => requirement.id)
      .toSorted()
    if (named.length === linked.length && named.every((id, index) => id === linked[index])) continue
    findings.push(
      `deployment profile ${profile.id}: ${named.length} requirement row(s) name this profile in their recorded evidence (${named.join(', ') || 'none'}) while the profile row links ${linked.length} (${linked.join(', ') || 'none'}); the profile evidence kinds do not intersect the requirement join, so the profile column is a reference and not a coverage claim`
    )
  }
  return findings
}

// The historical figure identities and digests are carried from the 2026-09-30
// audit document. Every recorded object must appear in that document with the
// same revision, byte length and digest, so the figure inventory cannot drift
// away from the evidence it claims to carry.
async function validateFigureLineage(ledger, root) {
  const errors = []
  let audit
  try {
    audit = await readFile(
      resolve(root, 'docs/requirements/canonical-figure-audit-2026-09-30.md'),
      'utf8'
    )
  } catch (error) {
    return [`canonical figure audit document is unavailable: ${error.message}`]
  }
  const recorded = new Map()
  for (const match of audit.matchAll(
    /^\|[^|]*\|\s*(\d+)\s*\|\s*`(kix\.[a-z0-9]+)`\s*\|\s*(\d+)\s*\|\s*`([0-9a-f]{64})`\s*\|/gm
  )) {
    recorded.set(match[2], {
      revision: match[1],
      byteLength: match[3],
      sha256: match[4],
    })
  }
  if (recorded.size === 0)
    return ['canonical figure audit document records no inline object identities']
  for (const source of ledger.sources ?? []) {
    for (const observation of source.embeddedObjects?.historicalObservations ?? []) {
      for (const object of observation.objects ?? []) {
        const row = recorded.get(object.objectId)
        if (!row) {
          errors.push(
            `${source.id}: historical figure object ${object.objectId} is absent from the canonical figure audit`
          )
          continue
        }
        if (row.revision !== String(observation.observedRevision))
          errors.push(
            `${source.id}: historical figure object ${object.objectId} was observed at revision ${observation.observedRevision} but the canonical figure audit records revision ${row.revision}`
          )
        if (row.byteLength !== String(object.byteLength))
          errors.push(
            `${source.id}: historical figure object ${object.objectId} records ${object.byteLength} bytes but the canonical figure audit records ${row.byteLength}`
          )
        if (row.sha256 !== object.sha256)
          errors.push(
            `${source.id}: historical figure object ${object.objectId} records a digest that differs from the canonical figure audit`
          )
      }
    }
  }
  return errors
}

export async function collectFigureInventory(ledger, root) {
  const errors = []
  let freshness
  try {
    freshness = JSON.parse(await readFile(resolve(root, freshnessPath), 'utf8'))
  } catch (error) {
    return { errors: [`canonical source freshness receipt is unavailable: ${error.message}`] }
  }
  const receiptBySource = new Map(
    (freshness.sources ?? []).map((source) => [source.sourceId, source])
  )
  const sources = []
  const summary = {
    sources: 0,
    sourcesWithCurrentObjects: 0,
    currentRootTabObjects: 0,
    historicalObjects: 0,
    identitiesRetained: 0,
    identitiesNew: 0,
    identitiesAbsent: 0,
    sourcesWithCurrentImageBytes: 0,
    sourcesWithNestedTabsInventoried: 0,
  }
  for (const source of ledger.sources ?? []) {
    const receipt = receiptBySource.get(source.id)
    if (!receipt) {
      errors.push(`${source.id}: freshness receipt entry is missing`)
      continue
    }
    const historical = source.embeddedObjects?.historicalObservations ?? []
    const historicalIds = new Set()
    const historicalObjects = []
    for (const observation of historical) {
      for (const object of observation.objects ?? []) {
        historicalIds.add(object.objectId)
        historicalObjects.push({
          objectId: object.objectId,
          observedAt: observation.observedAt,
          observedRevision: observation.observedRevision,
          sha256: object.sha256 ?? null,
          byteLength: object.byteLength ?? null,
          recordedTextAnchor: object.recordedTextAnchor ?? null,
        })
      }
    }
    const currentObjects = []
    const currentIds = new Set()
    for (const tab of receipt.selectedRootTabs ?? []) {
      for (const objectId of tab.inlineObjectIds ?? []) {
        currentIds.add(objectId)
        currentObjects.push({ objectId, tabId: tab.tabId, sha256: null, byteLength: null })
      }
      for (const objectId of tab.positionedObjectIds ?? []) {
        currentIds.add(objectId)
        currentObjects.push({ objectId, tabId: tab.tabId, sha256: null, byteLength: null })
      }
    }
    const retained = [...currentIds].filter((id) => historicalIds.has(id)).toSorted()
    const added = [...currentIds].filter((id) => !historicalIds.has(id)).toSorted()
    const absent = [...historicalIds].filter((id) => !currentIds.has(id)).toSorted()
    summary.sources += 1
    summary.currentRootTabObjects += currentObjects.length
    summary.historicalObjects += historicalObjects.length
    summary.identitiesRetained += retained.length
    summary.identitiesNew += added.length
    summary.identitiesAbsent += absent.length
    if (currentObjects.length > 0) summary.sourcesWithCurrentObjects += 1
    if (receipt.figureBytesRefreshed) summary.sourcesWithCurrentImageBytes += 1
    const nestedInventoried = Boolean(source.embeddedObjects?.nestedTabsInventoried)
    if (nestedInventoried) summary.sourcesWithNestedTabsInventoried += 1
    sources.push({
      sourceId: source.id,
      title: source.title,
      currentRevision: receipt.observedCurrentRevision,
      currentRevisionModifiedAt: receipt.observedRevisionModifiedAt,
      currentFileModifiedAt: receipt.observedFileModifiedAt,
      currentTextSha256: receipt.observedTextSha256,
      currentTextLogicalLines: receipt.observedTextLogicalLines,
      inventoriedTabs: (receipt.selectedRootTabs ?? []).map(({ tabId }) => tabId),
      nestedTabsInventoried: nestedInventoried,
      imageBytesRefreshedAtCurrentRevision: Boolean(receipt.figureBytesRefreshed),
      currentObjects: currentObjects.toSorted((left, right) =>
        compareCodePointOrder(left.objectId, right.objectId)
      ),
      historicalObjects,
      identityReconciliation: {
        retained,
        added,
        absent,
        basis: 'native inline-object identity read from the selected root tabs',
      },
      disposition: source.embeddedObjects?.disposition ?? null,
    })
  }
  return {
    errors,
    inventory: {
      schemaVersion: 1,
      scope:
        'actual embedded-object identities observed in selected root tabs; nested tabs and current image bytes are not inventoried',
      observedFrom: {
        freshnessReceipt: 'docs/requirements/canonical-source-freshness-2026-10-03.v1.json',
        figureAudit: 'docs/requirements/canonical-figure-audit-2026-09-30.md',
      },
      summary,
      sources,
    },
  }
}

export async function renderFigureInventory(ledger, root) {
  const { errors, inventory } = await collectFigureInventory(ledger, root)
  if (errors.length > 0) throw new Error(errors.join('\n'))
  return formatJson(inventory, 'canonical-figure-inventory.v1.json')
}

export async function validateFigureInventory(ledger, root) {
  const { errors, inventory } = await collectFigureInventory(ledger, root)
  if (errors.length > 0) return errors
  let current
  try {
    current = JSON.parse(
      await readFile(resolve(root, 'docs/requirements/canonical-figure-inventory.v1.json'), 'utf8')
    )
  } catch {
    return ['canonical figure inventory is missing or malformed']
  }
  return JSON.stringify(current) === JSON.stringify(inventory)
    ? []
    : ['Canonical figure inventory drifted; run bun run requirements:write']
}

// The reconciliation record publishes the provenance of the artifacts generated
// beside it: the coverage table, the worker table and the open-gate table. The
// record is hand-authored, so those tables can drift from the crosswalk and the
// ledger that produced them without anything noticing. This check compares each
// claim with the artifact it cites and fails closed on a difference, so the
// record cannot publish a number, a head or a gate state that the evidence does
// not carry.
export function validateReconciliationRecord(record, ledger, crosswalk) {
  const errors = []
  if (record === undefined) return errors
  const rows = record.split('\n').filter((line) => line.startsWith('| '))
  const cell = (line, index) => line.split('|')[index]?.trim() ?? ''
  const leadingNumber = (value) => {
    const match = /^\d+/.exec(value.trim())
    return match ? Number(match[0]) : undefined
  }
  const coverage = [
    ['Normative sources joined', crosswalk.summary.normativeSources],
    ['Sources with a recorded current revision', crosswalk.summary.sourcesWithCurrentRevision],
    [
      'Sources whose text changed after the captured revision',
      crosswalk.summary.sourcesWithChangedText,
    ],
    ['Captured atomic clauses', crosswalk.summary.atomicClauses],
    ['Captured clauses whose source text changed', crosswalk.summary.clausesWithChangedSourceText],
    ['Current clauses extracted into the lineage register', crosswalk.summary.currentClauses],
    ['Explicit clause-to-requirement links', crosswalk.atomicSummary.linkCount],
    ['Linked clauses', crosswalk.summary.linkedClauses],
    [
      'Unlinked clauses carrying an explicit per-source disposition',
      crosswalk.summary.unlinkedClauses,
    ],
    ['Bounded requirement rows', crosswalk.summary.requirements],
    [
      'Requirement rows with at least one clause link',
      crosswalk.summary.requirementsWithAtomicClauseLinks,
    ],
    ['Requirement rows with a recorded code target', crosswalk.summary.requirementsWithCodeTargets],
    ['Requirement rows with a recorded test target', crosswalk.summary.requirementsWithTestTargets],
    [
      'Requirement rows with a recorded profile target',
      crosswalk.summary.requirementsWithProfileTargets,
    ],
    ['M1–M10 issue audits', crosswalk.summary.priorIssueAudits],
    ['Deployment profiles', crosswalk.deploymentProfiles?.length ?? 0],
    ['External acceptance gates recorded', crosswalk.summary.externalGates],
  ]
  for (const [label, expected] of coverage) {
    const row = rows.find((line) => cell(line, 1) === label)
    if (row === undefined) {
      errors.push(`reconciliation record is missing the "${label}" row`)
      continue
    }
    const actual = leadingNumber(cell(row, 2))
    if (actual !== expected) {
      errors.push(
        `reconciliation record "${label}" says ${String(actual)}, the crosswalk says ${String(expected)}`
      )
    }
  }
  const profileRows = crosswalk.deploymentProfiles ?? []
  const profileClassifications = countBy(profileRows, 'classification')
  const profileClassificationSummary = Object.entries(profileClassifications)
    .toSorted(([left], [right]) => compareCodePointOrder(left, right))
    .map(([classification, count]) =>
      Object.keys(profileClassifications).length === 1
        ? `all \`${classification}\``
        : `${count} \`${classification}\``
    )
    .join(', ')
  const profileRow = rows.find((line) => cell(line, 1) === 'Deployment profiles')
  if (profileRow !== undefined) {
    const expected = `${profileRows.length} (${profileClassificationSummary || 'none'})`
    if (cell(profileRow, 2) !== expected) {
      errors.push(
        `reconciliation record "Deployment profiles" says ${cell(profileRow, 2)}, the crosswalk inventory says ${expected}`
      )
    }
  }
  const workerRows = crosswalk.workers ?? []
  const integratedWorkers = workerRows.filter((worker) => worker.status === 'integrated').length
  const workerStatusCounts = countBy(
    workerRows.filter((worker) => worker.status !== 'integrated'),
    'status'
  )
  const workerStatusSummary = Object.entries(workerStatusCounts)
    .toSorted(([left], [right]) => compareCodePointOrder(left, right))
    .map(([status, count]) => `${count} ${status}`)
    .join(', ')
  const workerSummaryRow = rows.find((line) => cell(line, 1) === 'Worker lanes recorded')
  if (workerSummaryRow === undefined) {
    errors.push('reconciliation record is missing the "Worker lanes recorded" row')
  } else {
    const expected = `${workerRows.length} (${integratedWorkers} integrated; ${workerStatusSummary || 'none'})`
    if (cell(workerSummaryRow, 2) !== expected) {
      errors.push(
        `reconciliation record "Worker lanes recorded" says ${cell(workerSummaryRow, 2)}, the crosswalk inventory says ${expected}`
      )
    }
  }
  if (crosswalk.summary.deploymentProfiles !== profileRows.length) {
    errors.push(
      `crosswalk summary reports ${crosswalk.summary.deploymentProfiles} deployment profiles, but its inventory has ${profileRows.length}`
    )
  }
  if (crosswalk.summary.workers !== workerRows.length) {
    errors.push(
      `crosswalk summary reports ${crosswalk.summary.workers} workers, but its inventory has ${workerRows.length}`
    )
  }
  if (crosswalk.summary.workersIntegrated !== integratedWorkers) {
    errors.push(
      `crosswalk summary reports ${crosswalk.summary.workersIntegrated} integrated workers, but its inventory has ${integratedWorkers}`
    )
  }
  for (const worker of ledger.workerEvidence ?? []) {
    const row = rows.find((line) => cell(line, 1) === worker.id)
    if (row === undefined) {
      errors.push(`reconciliation record is missing the ${worker.id} worker row`)
      continue
    }
    if (cell(row, 3) !== worker.status) {
      errors.push(
        `reconciliation record ${worker.id} says ${cell(row, 3)}, the ledger says ${worker.status}`
      )
    }
    if (!row.includes(worker.head)) {
      errors.push(
        `reconciliation record ${worker.id} does not carry the recorded head ${worker.head}`
      )
    }
  }
  for (const gate of ledger.reconciliation?.externalGates ?? []) {
    const row = rows.find((line) => cell(line, 1).startsWith(gate.id))
    if (row === undefined) {
      errors.push(`reconciliation record is missing the ${gate.id} gate row`)
      continue
    }
    if (cell(row, 2) !== gate.status) {
      errors.push(
        `reconciliation record ${gate.id} says ${cell(row, 2)}, the ledger says ${gate.status}`
      )
    }
    if (cell(row, 3) !== gate.severity) {
      errors.push(
        `reconciliation record ${gate.id} says severity ${cell(row, 3)}, the ledger says ${gate.severity}`
      )
    }
  }
  return errors
}

// The canonical crosswalk joins the current source revision, the captured atomic
// clause, the bounded requirement row, the reachable code/test/profile targets,
// and the issue and evidence records. It never upgrades a classification.
export async function collectCanonicalCrosswalk(ledger, root) {
  const errors = []
  const atomic = await collectAtomicCrosswalkCached(ledger, root)
  errors.push(...atomic.errors)
  let lineage
  let freshness
  try {
    lineage = JSON.parse(await readFile(resolve(root, lineagePath), 'utf8'))
  } catch (error) {
    errors.push(`canonical source lineage is unavailable: ${error.message}`)
  }
  try {
    freshness = JSON.parse(await readFile(resolve(root, freshnessPath), 'utf8'))
  } catch (error) {
    errors.push(`canonical source freshness receipt is unavailable: ${error.message}`)
  }
  const lineageBySource = new Map(
    (lineage?.sources ?? []).map((source) => [source.sourceId, source])
  )
  const freshnessBySource = new Map(
    (freshness?.sources ?? []).map((source) => [source.sourceId, source])
  )
  const atomicBySource = new Map(
    (atomic.register?.sources ?? []).map((source) => [source.sourceId, source])
  )
  const figure = await collectFigureInventory(ledger, root)
  errors.push(...figure.errors)
  const figureBySource = new Map(
    (figure.inventory?.sources ?? []).map((source) => [source.sourceId, source])
  )

  const profileEvidencePaths = new Map()
  for (const profile of ledger.deploymentProfiles ?? []) {
    for (const entry of profile.evidence ?? []) {
      if (entry.path) {
        if (!profileEvidencePaths.has(entry.path)) profileEvidencePaths.set(entry.path, [])
        profileEvidencePaths.get(entry.path).push(profile.id)
      }
    }
  }

  const atomStatusBySource = new Map()
  for (const source of lineage?.sources ?? []) {
    const statuses = new Map()
    for (const atom of source.atoms ?? []) statuses.set(atom.atomId, atom.status)
    atomStatusBySource.set(source.sourceId, statuses)
  }

  const requirementIdsBySource = new Map()
  for (const requirement of ledger.requirements ?? []) {
    if (!requirementIdsBySource.has(requirement.sourceId))
      requirementIdsBySource.set(requirement.sourceId, [])
    requirementIdsBySource.get(requirement.sourceId).push(requirement.id)
  }

  const atomIdsByRequirement = new Map()
  for (const source of atomic.register?.sources ?? []) {
    for (const mapping of source.mappings ?? [])
      atomIdsByRequirement.set(mapping.requirementId, mapping.atomIds)
  }

  const sources = []
  for (const source of ledger.sources ?? []) {
    const atomicSource = atomicBySource.get(source.id)
    const lineageSource = lineageBySource.get(source.id)
    const receipt = freshnessBySource.get(source.id)
    const dispositions = lineageSource?.atoms ?? []
    const changed = dispositions.filter((atom) => atom.status === 'source-text-changed').length
    const unchanged = dispositions.length - changed
    const linkedAtoms = new Set(
      (atomicSource?.mappings ?? []).flatMap((mapping) => mapping.atomIds)
    )
    const requirementIds = (requirementIdsBySource.get(source.id) ?? []).toSorted()
    const linkedRequirements = (atomicSource?.mappings ?? []).map(
      ({ requirementId }) => requirementId
    )
    sources.push({
      sourceId: source.id,
      title: source.title,
      provider: source.provider,
      uri: source.uri,
      capturedRevision: source.currentRevision,
      capturedTextSha256: source.contentSha256,
      currentRevision: receipt?.observedCurrentRevision ?? null,
      currentRevisionModifiedAt: receipt?.observedRevisionModifiedAt ?? null,
      currentTextSha256: receipt?.observedTextSha256 ?? null,
      currentTextLogicalLines: receipt?.observedTextLogicalLines ?? null,
      textChanged: receipt?.textChanged ?? null,
      atomicClauses: source.atomicInventory?.atoms ?? 0,
      clausesWithChangedSourceText: changed,
      clausesWithUnchangedSourceText: unchanged,
      changedBlocks: lineageSource?.blocks?.length ?? 0,
      currentClauses: (lineageSource?.blocks ?? []).reduce(
        (total, block) => total + (block.currentClauses?.length ?? 0),
        0
      ),
      blockDispositions: countBy(
        (lineageSource?.blocks ?? []).map((block) => ({ disposition: block.disposition })),
        'disposition'
      ),
      linkedClauses: linkedAtoms.size,
      unlinkedClauses: (atomicSource?.unmappedAtomIds ?? []).length,
      linkedRequirements: uniqueSorted(linkedRequirements),
      unlinkedRequirements: requirementIds.filter((id) => !linkedRequirements.includes(id)),
      embeddedObjects: figureBySource.get(source.id)
        ? {
            currentRevision: figureBySource.get(source.id).currentRevision,
            inventoriedTabs: figureBySource.get(source.id).inventoriedTabs,
            nestedTabsInventoried: figureBySource.get(source.id).nestedTabsInventoried,
            imageBytesRefreshedAtCurrentRevision: figureBySource.get(source.id)
              .imageBytesRefreshedAtCurrentRevision,
            currentObjects: figureBySource.get(source.id).currentObjects.length,
            identitiesRetained: figureBySource.get(source.id).identityReconciliation.retained
              .length,
            identitiesAdded: figureBySource.get(source.id).identityReconciliation.added.length,
            identitiesAbsent: figureBySource.get(source.id).identityReconciliation.absent.length,
          }
        : null,
      unlinkedClauseDisposition:
        (ledger.atomDispositions ?? []).find((entry) => entry.sourceId === source.id) ?? null,
    })
  }

  const requirements = (ledger.requirements ?? []).map((requirement) => {
    const atomIds = atomIdsByRequirement.get(requirement.id) ?? []
    const statuses = atomStatusBySource.get(requirement.sourceId)
    const sourceTextStatus = atomIds.length
      ? atomIds.some((id) => statuses?.get(id) === 'source-text-changed')
        ? 'source-text-changed'
        : 'source-text-unchanged'
      : 'no-atomic-clause-link'
    const evidence = requirement.evidence ?? []
    const targets = Object.fromEntries(
      [...evidenceTargetKinds].map((kind) => [
        kind,
        uniqueSorted(
          evidence
            .filter((entry) => evidenceTarget(entry) === kind)
            .map((entry) => entry.path)
            .filter(Boolean)
        ),
      ])
    )
    const profileTargets = uniqueSorted([
      ...evidence.map((entry) => entry.profile).filter(Boolean),
      ...evidence.flatMap((entry) =>
        entry.path ? (profileEvidencePaths.get(entry.path) ?? []) : []
      ),
    ])
    return {
      id: requirement.id,
      sourceId: requirement.sourceId,
      heading: requirement.heading,
      normativeState: requirement.normativeState,
      classification: requirement.classification,
      owner: requirement.owner,
      lane: requirement.lane,
      issueRefs: requirement.issueRefs ?? [],
      atomicClauses: atomIds,
      sourceTextStatus,
      targets,
      profileTargets,
      evidenceCount: evidence.length,
      gap: requirement.gap ?? null,
      supersession: requirement.supersession ?? null,
    }
  })

  const snapshotByIssue = new Map(
    (ledger.githubIssueSnapshot?.issues ?? []).map((issue) => [issue.number, issue])
  )
  const priorIssueAudits = (ledger.priorMilestoneAudits ?? []).map((audit) => {
    const evidence = audit.evidence ?? []
    const recorded = snapshotByIssue.get(audit.issue)
    return {
      id: audit.id,
      issue: audit.issue,
      title: audit.title,
      milestone: audit.milestone,
      classification: audit.classification,
      owner: audit.owner,
      lane: audit.lane,
      githubState: recorded?.state ?? null,
      githubTitle: recorded?.title ?? null,
      targets: Object.fromEntries(
        [...evidenceTargetKinds].map((kind) => [
          kind,
          uniqueSorted(
            evidence
              .filter((entry) => evidenceTarget(entry) === kind)
              .map((entry) => entry.path)
              .filter(Boolean)
          ),
        ])
      ),
      evidenceCount: evidence.length,
      gap: audit.gap ?? null,
      supersession: audit.supersession ?? null,
    }
  })

  const deploymentProfiles = (ledger.deploymentProfiles ?? []).map((profile) => {
    const evidencePaths = new Set(
      (profile.evidence ?? []).map((entry) => entry.path).filter(Boolean)
    )
    const covered = requirements
      .filter(
        (requirement) =>
          requirement.targets.code.some((path) => evidencePaths.has(path)) ||
          requirement.targets.test.some((path) => evidencePaths.has(path)) ||
          requirement.targets.document.some((path) => evidencePaths.has(path))
      )
      .map((requirement) => requirement.id)
    return {
      id: profile.id,
      composition: profile.composition,
      classification: profile.classification,
      owner: profile.owner,
      observedAt: profile.observedAt,
      commit: profile.commit,
      result: profile.result,
      evidence: (profile.evidence ?? []).map((entry) => entry.path ?? entry.command ?? null),
      requirementIds: covered,
      gap: profile.gap ?? null,
    }
  })

  const summary = {
    normativeSources: sources.length,
    sourcesWithCurrentRevision: sources.filter((source) => source.currentRevision !== null).length,
    sourcesWithChangedText: sources.filter((source) => source.textChanged === true).length,
    atomicClauses: sources.reduce((total, source) => total + source.atomicClauses, 0),
    clausesWithChangedSourceText: sources.reduce(
      (total, source) => total + source.clausesWithChangedSourceText,
      0
    ),
    currentClauses: sources.reduce((total, source) => total + source.currentClauses, 0),
    linkedClauses: sources.reduce((total, source) => total + source.linkedClauses, 0),
    unlinkedClauses: sources.reduce((total, source) => total + source.unlinkedClauses, 0),
    requirements: requirements.length,
    requirementsWithAtomicClauseLinks: requirements.filter(
      (requirement) => requirement.atomicClauses.length > 0
    ).length,
    requirementsWithoutAtomicClauseLinks: requirements.filter(
      (requirement) => requirement.atomicClauses.length === 0
    ).length,
    requirementsWithCodeTargets: requirements.filter(
      (requirement) => requirement.targets.code.length > 0
    ).length,
    requirementsWithTestTargets: requirements.filter(
      (requirement) => requirement.targets.test.length > 0
    ).length,
    requirementsWithProfileTargets: requirements.filter(
      (requirement) => requirement.profileTargets.length > 0
    ).length,
    classifications: countBy(requirements, 'classification'),
    priorIssueAudits: priorIssueAudits.length,
    priorIssueClassifications: countBy(priorIssueAudits, 'classification'),
    deploymentProfiles: deploymentProfiles.length,
    workers: (ledger.workerEvidence ?? []).length,
    workersIntegrated: (ledger.workerEvidence ?? []).filter(
      (worker) => worker.status === 'integrated'
    ).length,
    externalGates: (ledger.reconciliation?.externalGates ?? []).length,
  }

  return {
    errors,
    crosswalk: {
      schemaVersion: 1,
      scope:
        'canonical current-source → atomic clause → requirement → code/test/profile → issue/evidence crosswalk; classifications are never promoted by this artifact',
      generatedFrom: {
        ledger: 'docs/requirements/control-plane-requirements.v1.json',
        atomicRegister: 'docs/requirements/control-plane-atomic-clauses.v1.json',
        atomicCrosswalk: 'docs/requirements/control-plane-atomic-crosswalk.v1.json',
        sourceLineage: 'docs/requirements/canonical-source-lineage-2026-10-03.v1.json',
        sourceFreshness: 'docs/requirements/canonical-source-freshness-2026-10-03.v1.json',
        figureInventory: 'docs/requirements/canonical-figure-inventory.v1.json',
      },
      reconciledAt: ledger.reconciliation?.reconciledAt ?? null,
      reconciliationBase: ledger.reconciliation?.reconciliationBase ?? null,
      candidateProof: ledger.reconciliation?.candidateProof ?? null,
      atomicSummary: atomic.register?.summary ?? null,
      summary,
      sources,
      requirements,
      priorIssueAudits,
      deploymentProfiles,
      workers: ledger.workerEvidence ?? [],
      externalGates: ledger.reconciliation?.externalGates ?? [],
    },
  }
}

export async function renderCanonicalCrosswalk(ledger, root) {
  const { errors, crosswalk } = await collectCanonicalCrosswalk(ledger, root)
  if (errors.length > 0) throw new Error(errors.join('\n'))
  return formatJson(crosswalk, 'control-plane-requirements-crosswalk.v1.json')
}

export async function validateCanonicalCrosswalk(ledger, root) {
  const { errors, crosswalk } = await collectCanonicalCrosswalk(ledger, root)
  if (errors.length > 0) return errors
  let current
  try {
    current = JSON.parse(
      await readFile(
        resolve(root, 'docs/requirements/control-plane-requirements-crosswalk.v1.json'),
        'utf8'
      )
    )
  } catch {
    return ['Canonical requirements crosswalk is missing or malformed']
  }
  return JSON.stringify(current) === JSON.stringify(crosswalk)
    ? []
    : ['Canonical requirements crosswalk drifted; run bun run requirements:write']
}

function requireFields(errors, value, fields) {
  for (const field of fields) {
    if (value?.[field] === undefined || value[field] === '') {
      errors.push(`${value?.id ?? 'row'}: ${field} is required`)
    }
  }
}

function validateGap(errors, row, label = 'gap') {
  // A superseded row's disposition is its supersession record; it carries no open
  // gap, so requiring a gap reference would be dead weight (#612).
  if (row.classification === 'superseded') return
  for (const field of ['issue', 'severity', 'owner', 'disposition']) {
    if (row.gap?.[field] === undefined || row.gap[field] === '') {
      errors.push(
        `${row.id}: ${label}.${field} is required for ${row.classification ?? row.retrievalStatus}`
      )
    }
  }
  if (!Number.isInteger(row.gap?.issue)) errors.push(`${row.id}: ${label}.issue must be numeric`)
  if (!['critical', 'high', 'medium', 'low'].includes(row.gap?.severity)) {
    errors.push(`${row.id}: ${label}.severity is invalid`)
  }
}

function collectGapIssues(value, issues = []) {
  if (Array.isArray(value)) {
    for (const entry of value) collectGapIssues(entry, issues)
    return issues
  }
  if (!value || typeof value !== 'object') return issues
  if (Number.isInteger(value.gap?.issue)) issues.push(value.gap.issue)
  for (const entry of Object.values(value)) collectGapIssues(entry, issues)
  return issues
}

function numeric(left, right) {
  return left - right
}

function countBy(rows, key) {
  return rows.reduce((counts, row) => ({ ...counts, [row[key]]: (counts[row[key]] ?? 0) + 1 }), {})
}

function formatCounts(counts) {
  return Object.entries(counts)
    .toSorted(([left], [right]) => compareCodePointOrder(left, right))
    .map(([key, value]) => `${value} ${key}`)
    .join(', ')
}

function formatObject(value) {
  return Object.entries(value)
    .map(([key, entry]) => `${key} ${entry}`)
    .join('; ')
}

function sourceTitle(ledger, sourceId) {
  return ledger.sources.find(({ id }) => id === sourceId)?.title ?? sourceId
}

function formatEvidence(evidence) {
  const label = evidence.path ?? evidence.command ?? evidence.artifact ?? evidence.environment
  const detail = evidence.profile ? ` (${evidence.profile})` : ''
  return evidence.path ? `\`${label}\`${detail}` : `${escapeCell(label)}${detail}`
}

function formatGap(gap) {
  if (!gap) return '—'
  return `[#${gap.issue}](https://github.com/adea-ai/control-plane/issues/${gap.issue}) ${gap.severity}; ${escapeCell(gap.owner)}; ${escapeCell(gap.disposition)}`
}

function formatSupersession(supersession) {
  if (!supersession) return '—'
  return `[#${supersession.issue}](https://github.com/adea-ai/control-plane/issues/${supersession.issue}) ${supersession.severity}; ${escapeCell(supersession.owner)}; ${escapeCell(supersession.disposition)}`
}

function escapeCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')
}

// The recorded snapshot is the offline authority for gap references. It is
// refreshed from live issue identities and never promotes a historical result.
export function refreshGitHubIssueSnapshot(ledger, issues, options = {}) {
  const snapshot = ledger.githubIssueSnapshot
  if (!snapshot) throw new Error('githubIssueSnapshot is required before it can be refreshed')
  const issueByNumber = new Map(issues.map((issue) => [issue.number, issue]))
  const refreshed = snapshot.issues.map((recorded) => {
    const live = issueByNumber.get(recorded.number)
    if (!live)
      throw new Error(
        `Recorded issue #${recorded.number} is missing from the current GitHub inventory`
      )
    return {
      ...recorded,
      title: live.title,
      state: String(live.state).toUpperCase(),
      closedAt: live.closedAt ?? null,
      milestone: live.milestone?.number ?? null,
      url: live.url,
    }
  })
  return {
    ...ledger,
    githubIssueSnapshot: {
      ...snapshot,
      retrievedAt: options.retrievedAt ?? snapshot.retrievedAt,
      method: options.method ?? snapshot.method,
      issues: refreshed,
    },
  }
}

export function compareGitHubIssueSnapshot(ledger, issues) {
  const snapshot = ledger.githubIssueSnapshot
  if (!snapshot) return ['githubIssueSnapshot is missing; run bun run requirements:refresh']
  const issueByNumber = new Map(issues.map((issue) => [issue.number, issue]))
  const divergences = []
  for (const recorded of snapshot.issues ?? []) {
    const live = issueByNumber.get(recorded.number)
    if (!live) {
      divergences.push(`#${recorded.number} is missing from the current GitHub inventory`)
      continue
    }
    const liveState = String(live.state).toUpperCase()
    if (liveState !== recorded.state)
      divergences.push(
        `#${recorded.number} is ${liveState} on GitHub but the snapshot records ${recorded.state}`
      )
    if (live.title !== recorded.title)
      divergences.push(`#${recorded.number} title differs from the recorded snapshot title`)
    if ((live.milestone?.number ?? null) !== recorded.milestone)
      divergences.push(`#${recorded.number} milestone differs from the recorded snapshot`)
  }
  return divergences
}

async function main() {
  let ledger = JSON.parse(await readFile(ledgerPath, 'utf8'))
  const architecture = JSON.parse(await readFile(architecturePath, 'utf8'))
  const architectureGapIssues = collectGapIssues(architecture)
  const refreshIssues = process.argv.includes('--refresh-issues')
  const checkIssues = process.argv.includes('--check-issues')
  const write = process.argv.includes('--write')
  const divergences = []
  if (refreshIssues || checkIssues) {
    const issues = await listGitHubIssues()
    ledger = refreshPriorMilestoneAudits(ledger, issues, architectureGapIssues)
    if (refreshIssues) {
      ledger = refreshGitHubIssueSnapshot(ledger, issues, {
        retrievedAt: new Date().toISOString().slice(0, 10),
      })
      await writeFile(ledgerPath, formatJson(ledger, 'control-plane-requirements.v1.json'))
    } else {
      divergences.push(...compareGitHubIssueSnapshot(ledger, issues))
    }
  }
  const { errors, warnings, provenance, workerInventory } = await validateRequirementsLedger(
    ledger,
    { repositoryRoot: new URL('..', import.meta.url) }
  )
  errors.push(...(await validateCanonicalSourceLineage(repositoryRoot)))
  if (!write && !refreshIssues) {
    errors.push(...(await validateCanonicalCrosswalk(ledger, repositoryRoot)))
    errors.push(...(await validateFigureInventory(ledger, repositoryRoot)))
    // The reconciliation record publishes the provenance of the artifacts above.
    // It is hand-authored, so its tables are checked against the artifacts they
    // cite rather than trusted.
    let record
    try {
      record = await readFile(reconciliationRecordPath, 'utf8')
    } catch {
      record = undefined
    }
    if (record !== undefined) {
      const { errors: crosswalkErrors, crosswalk } = await collectCanonicalCrosswalk(
        ledger,
        repositoryRoot
      )
      if (crosswalkErrors.length === 0) {
        errors.push(...validateReconciliationRecord(record, ledger, crosswalk))
      }
    }
    // The record and its binding section are required whatever the history is;
    // only the blob comparison needs the recorded heads and degrades to a warning.
    const binding = validateWorkerContentBinding(record, workerInventory, {
      workerCount: (ledger.workerEvidence ?? []).length,
    })
    errors.push(...binding.errors)
    provenance.push(...binding.provenance)
    if (record !== undefined && !binding.compared) {
      warnings.push(
        'the reconciliation record worker content blobs were not compared because not every recorded worker head is resolvable'
      )
    }
  }
  for (const warning of warnings) console.warn(`Requirements ledger warning: ${warning}`)
  for (const finding of provenance) console.warn(`Requirements ledger provenance: ${finding}`)
  for (const divergence of divergences)
    console.warn(`Requirements ledger warning: GitHub snapshot divergence: ${divergence}`)
  if (errors.length > 0)
    throw new Error(`Requirements ledger is invalid:\n- ${errors.join('\n- ')}`)
  const report = await renderRequirementsReport(ledger)
  if (write || refreshIssues) {
    await writeFile(reportPath, report)
    await writeFile(crosswalkPath, await renderCanonicalCrosswalk(ledger, repositoryRoot))
    await writeFile(figureInventoryPath, await renderFigureInventory(ledger, repositoryRoot))
    console.log(
      `Wrote ${relative(repositoryRoot, reportPath)}, ${relative(repositoryRoot, crosswalkPath)} and ${relative(repositoryRoot, figureInventoryPath)}`
    )
    return
  }
  const current = await readFile(reportPath, 'utf8')
  if (current !== report)
    throw new Error('Requirements report drifted; run bun run requirements:write')
  console.log(
    `Validated ${ledger.requirements.length} requirements and ${ledger.priorMilestoneAudits.length} issue audits`
  )
}

if (import.meta.main) await main()
