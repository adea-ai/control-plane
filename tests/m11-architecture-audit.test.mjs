import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { URL } from 'node:url'
import {
  discoverArchitecture,
  renderArchitectureReport,
  validateArchitectureAudit,
} from '../scripts/architecture-audit.mjs'

const repositoryRoot = new URL('..', import.meta.url)
const auditUrl = new URL('../docs/architecture/control-plane-architecture.v1.json', import.meta.url)
const reportUrl = new URL('../docs/architecture/control-plane-architecture.md', import.meta.url)
const audit = JSON.parse(await readFile(auditUrl, 'utf8'))
const clone = (value) => JSON.parse(JSON.stringify(value))

const profileIds = ['cloud', 'hosted-server', 'hosted-simple', 'local']
const infrastructurePorts = [
  'coordination',
  'discovery',
  'objectStore',
  'observability',
  'persistence',
  'processes',
  'runtimeTransport',
  'secrets',
  'workflow',
]

const publicOperations = [
  'authentication.verify',
  'context-package.resolve',
  'execution.accept',
  'execution.cancel',
  'execution.validate',
  'external-session.get',
  'external-session.list',
  'interaction.respond',
  'marketplace.catalog.read',
  'marketplace.install.plan',
  'marketplace.install.request',
  'profile.resolve',
  'project-state.resolve',
  'runtime-connection.get',
  'runtime-connection.list',
  'runtime.list',
]

describe('M11.2 architecture audit', () => {
  test('matches current workspace and public-operation discovery', async () => {
    const discovered = await discoverArchitecture(repositoryRoot)
    const result = await validateArchitectureAudit(audit, { repositoryRoot, discovered })

    expect(result.errors).toEqual([])
    expect(audit.packages).toHaveLength(41)
    // Snapshot versions are informational: Release Please owns version bumps,
    // so the live invariant is workspace-to-manifest consistency, not
    // snapshot-to-manifest equality (which is false on every release PR).
    expect(
      discovered.packages.every(({ path, version }) => discovered.releaseManifest[path] === version)
    ).toBe(true)
    expect(audit.operations.map(({ operation }) => operation).toSorted()).toEqual(publicOperations)
    expect(audit.profiles.map(({ id }) => id).toSorted()).toEqual(profileIds)
    for (const profile of audit.profiles) {
      expect(Object.keys(profile.ports).toSorted(), profile.id).toEqual(infrastructurePorts)
      expect(profile.sourceDigest, profile.id).toMatch(/^sha256:[0-9a-f]{64}$/)
    }
  })

  test('fails closed on package, operation, profile, and evidence drift', async () => {
    const discovered = await discoverArchitecture(repositoryRoot)
    for (const [mutation, expectedError] of [
      [(value) => value.packages.pop(), 'package inventory drifted from workspace manifests'],
      [(value) => value.operations.pop(), 'operation inventory drifted from SDK declarations'],
      [
        (value) => value.profiles.pop(),
        'profiles must contain cloud, local, hosted-simple, and hosted-server',
      ],
      [(value) => value.persistenceParity.pop(), 'persistence parity inventory drifted'],
    ]) {
      const changed = clone(audit)
      mutation(changed)
      const { errors } = await validateArchitectureAudit(changed, { repositoryRoot, discovered })
      expect(errors, expectedError).toContain(expectedError)
    }

    const cyclic = clone(discovered)
    cyclic.packages[0].workspaceDependencies.push(cyclic.packages[0].name)
    const { errors } = await validateArchitectureAudit(audit, {
      repositoryRoot,
      discovered: cyclic,
    })
    expect(errors).toContain('workspace runtime dependency graph contains a cycle')

    const releaseDrift = clone(discovered)
    releaseDrift.releaseManifest[releaseDrift.packages[0].path] = '0.0.0-drift'
    const releaseResult = await validateArchitectureAudit(audit, {
      repositoryRoot,
      discovered: releaseDrift,
    })
    expect(releaseResult.errors).toContain(
      'workspace package versions drifted from release-please manifest'
    )
  })

  test('ignores release-please version bumps in the package inventory', async () => {
    const discovered = await discoverArchitecture(repositoryRoot)
    const bumped = clone(discovered)
    for (const entry of bumped.packages) {
      entry.version = '9.9.9-bump'
      entry.lockVersion = '9.9.9-bump'
      bumped.releaseManifest[entry.path] = '9.9.9-bump'
    }
    const { errors } = await validateArchitectureAudit(audit, {
      repositoryRoot,
      discovered: bumped,
    })
    expect(errors).not.toContain('package inventory drifted from workspace manifests')
    expect(errors).toEqual([])
  })

  test('classifies every unsupported or partial path with an owned M11 disposition', () => {
    for (const row of [
      ...audit.operations,
      ...audit.profiles,
      ...audit.persistenceParity,
      ...audit.compatibilityMatrix,
    ]) {
      if (row.classification === 'verified') continue
      expect(row.gap.issue, row.id).toBeNumber()
      expect(row.gap.severity, row.id).toMatch(/^(critical|high|medium|low)$/)
      expect(row.gap.owner, row.id).toBeString()
      expect(row.gap.disposition, row.id).toBeString()
    }
  })

  test('records ownership and lifecycle coverage', () => {
    expect(new Set(audit.ownership.map(({ entity }) => entity))).toEqual(
      new Set([
        'AgentProfile/Skill',
        'Artifact',
        'ContextPackage',
        'ContextProvider/MemoryWriteProposal',
        'Execution/Attempt',
        'ExecutionPlan',
        'ProjectState',
        'RuntimeConnection/ExternalSession',
        'Tool/Model/Sandbox',
        'Usage/Evaluation',
        'events',
      ])
    )
    expect(audit.lifecycleCoverage.map(({ concern }) => concern).toSorted()).toEqual([
      'approval-and-interaction',
      'cancellation-and-timeout',
      'idempotency-and-inbox',
      'immutable-pinning',
      'outbox-and-event-delivery',
      'reconciliation-and-restart',
      'retention-and-deletion',
      'state-machine-and-cas',
    ])
  })

  test('keeps generated diagrams and report synchronized', async () => {
    const report = await readFile(reportUrl, 'utf8')
    expect(report).toBe(await renderArchitectureReport(audit))
    expect(report).toContain('```mermaid')
    expect(report).toContain('flowchart LR')
    expect(report).not.toContain('[object Object]')
    expect(report).toContain('auth:')
  })
})
