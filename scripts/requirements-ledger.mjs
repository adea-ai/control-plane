import { spawnSync } from 'node:child_process'
import { access, readFile, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

function formatMarkdown(text) {
  const result = spawnSync(
    'bun',
    [
      'x',
      'oxfmt',
      '--stdin-filepath',
      'report.md',
      '--config',
      resolve(repositoryRoot, '.oxfmtrc.json'),
    ],
    { input: text, encoding: 'utf8' }
  )
  if (result.status !== 0) throw new Error(`oxfmt markdown formatting failed: ${result.stderr}`)
  return result.stdout
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
const reportPath = resolve(repositoryRoot, 'docs/requirements/control-plane-requirements.md')

export async function validateRequirementsLedger(ledger, options = {}) {
  const errors = []
  const warnings = []
  const root = fileURLToPath(options.repositoryRoot ?? new URL('..', import.meta.url))
  let candidateAvailable = false
  let committedArtifacts = new Set()
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
      const shallowRepository =
        typeof options.shallowRepository === 'boolean'
          ? options.shallowRepository
          : (() => {
              const shallow = spawnSync('git', ['rev-parse', '--is-shallow-repository'], {
                cwd: root,
                encoding: 'utf8',
              })
              return shallow.status === 0 && shallow.stdout.trim() === 'true'
            })()
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
    if (sourceIds.has(source.id)) errors.push(`duplicate source ID: ${source.id}`)
    sourceIds.add(source.id)
  }

  const expectedProfiles = ['cloud', 'hosted-server', 'hosted-simple', 'local']
  const actualProfiles = (ledger.deploymentProfiles ?? []).map(({ id }) => id).sort()
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
    if (row.classification !== 'verified') validateGap(errors, row)
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
    .sort()
  const requirementRows = (ledger.requirements ?? [])
    .map(({ id, sourceId }) => `${id}:${sourceId}`)
    .sort()
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
  const inventoryIssues = (ledger.priorIssueInventory ?? []).map(({ issue }) => issue).sort(numeric)
  const auditIssues = (ledger.priorMilestoneAudits ?? []).map(({ issue }) => issue).sort(numeric)
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
  return { errors, warnings }
}

export function refreshPriorMilestoneAudits(ledger, issues) {
  const issueByNumber = new Map(issues.map((issue) => [issue.number, issue]))
  const gapIssues = [
    ...ledger.sources,
    ...ledger.deploymentProfiles,
    ...ledger.requirements,
    ...ledger.priorMilestoneAudits,
  ]
    .map(({ gap }) => gap?.issue)
    .filter((issue) => issue !== undefined)
  for (const issueNumber of new Set(gapIssues)) {
    const issue = issueByNumber.get(issueNumber)
    if (issue?.state !== 'OPEN' || !(issue.milestone?.title ?? '').startsWith('M11:')) {
      throw new Error(`Gap issue #${issueNumber} must be open and assigned to M11`)
    }
  }
  const inventory = issues
    .filter(({ milestone }) => /^M(?:10|[1-9]):/.test(milestone?.title ?? ''))
    .map((issue) => ({
      issue: issue.number,
      title: issue.title,
      milestone: issue.milestone.title.match(/^M(?:10|[1-9])/)?.[0],
      closedAt: issue.closedAt,
      url: issue.url,
    }))
    .sort((left, right) => left.issue - right.issue)
  const audits = new Map(ledger.priorMilestoneAudits.map((row) => [row.issue, row]))
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

export async function renderRequirementsReport(ledger) {
  const counts = countBy(ledger.requirements, 'classification')
  const auditCounts = countBy(ledger.priorMilestoneAudits, 'classification')
  const lines = [
    '# Control Plane requirements and prior-milestone evidence ledger',
    '',
    `Generated from [control-plane-requirements.v1.json](./control-plane-requirements.v1.json) for candidate \`${ledger.candidate.commit}\`. Do not edit this report directly; run \`bun run requirements:write\`.`,
    '',
    '## Candidate',
    '',
    `- Audited commit: \`${ledger.candidate.commit}\` (\`${ledger.candidate.ref}\`)`,
    `- Recorded at: ${ledger.candidate.recordedAt}`,
    `- Toolchain: Node ${ledger.candidate.toolchain.node}; Bun ${ledger.candidate.toolchain.bun}; Restate ${ledger.candidate.toolchain.restate}`,
    `- Contract/schema versions: ${formatObject(ledger.candidate.versions)}`,
    `- Committed ledger artifacts: ${ledger.candidate.artifacts.map((artifact) => `\`${artifact}\``).join(', ')}`,
    '',
    '## Summary',
    '',
    `- ${ledger.requirements.length} atomic normative requirements: ${formatCounts(counts)}.`,
    `- ${ledger.priorMilestoneAudits.length} M1–M10 issue audits: ${formatCounts(auditCounts)}.`,
    `- ${ledger.contradictions.length} explicit contradictions or supersessions.`,
    '',
    '## Normative sources',
    '',
    '| Source | Provider | Revision / modified time | Requirements |',
    '| --- | --- | --- | ---: |',
    ...ledger.sources.map(
      (source) =>
        `| [${escapeCell(source.title)}](${source.uri}) | ${source.provider} | ${source.updatedAt} | ${ledger.requirements.filter(({ sourceId }) => sourceId === source.id).length} |`
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
    'Run `bun run requirements:check` after changing this ledger or any referenced evidence. The check validates row shape, stable IDs, source coverage, gap ownership, reachable repository paths, and byte-for-byte report drift.',
    '',
  ]
  return formatMarkdown(lines.join('\n'))
}

function requireFields(errors, value, fields) {
  for (const field of fields) {
    if (value?.[field] === undefined || value[field] === '') {
      errors.push(`${value?.id ?? 'row'}: ${field} is required`)
    }
  }
}

function validateGap(errors, row, label = 'gap') {
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

function numeric(left, right) {
  return left - right
}

function countBy(rows, key) {
  return rows.reduce((counts, row) => ({ ...counts, [row[key]]: (counts[row[key]] ?? 0) + 1 }), {})
}

function formatCounts(counts) {
  return Object.entries(counts)
    .sort(([left], [right]) => left.localeCompare(right))
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

function escapeCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')
}

async function main() {
  let ledger = JSON.parse(await readFile(ledgerPath, 'utf8'))
  if (process.argv.includes('--refresh-issues')) {
    const result = spawnSync(
      'gh',
      [
        'issue',
        'list',
        '--state',
        'all',
        '--limit',
        '300',
        '--json',
        'number,title,milestone,url,state,closedAt',
      ],
      { cwd: repositoryRoot, encoding: 'utf8' }
    )
    if (result.error) throw result.error
    if (result.status !== 0)
      throw new Error(result.stderr.trim() || 'Unable to query GitHub issues')
    ledger = refreshPriorMilestoneAudits(ledger, JSON.parse(result.stdout))
    await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`)
  }
  const { errors, warnings } = await validateRequirementsLedger(ledger, {
    repositoryRoot: new URL('..', import.meta.url),
  })
  for (const warning of warnings) console.warn(`Requirements ledger warning: ${warning}`)
  if (errors.length > 0)
    throw new Error(`Requirements ledger is invalid:\n- ${errors.join('\n- ')}`)
  const report = await renderRequirementsReport(ledger)
  if (process.argv.includes('--write') || process.argv.includes('--refresh-issues')) {
    await writeFile(reportPath, report)
    console.log(`Wrote ${relative(repositoryRoot, reportPath)}`)
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
