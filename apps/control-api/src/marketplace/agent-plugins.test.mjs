import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  assertMarketplacePlanRequest,
  createMarketplaceAgentPluginsPlan,
  verifyAgentPackage,
} from './agent-plugins.ts'

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  return `{${Object.keys(value)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
    .join(',')}}`
}

function packageFixture(sourceDigest) {
  const manifest = {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: 'demo',
  }
  const manifestContent = `${stable(manifest)}\n`
  const mcp = { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: {} }
  const mcpContent = `${stable(mcp)}\n`
  const files = [
    {
      action: 'copy',
      sourcePath: 'skills/review/SKILL.md',
      targetPath: 'skills/review/SKILL.md',
      digest: digest('review'),
      preserveMode: true,
    },
    {
      action: 'write',
      targetPath: 'mcp.json',
      digest: digest(mcpContent),
      content: mcpContent,
      mode: '0644',
    },
    {
      action: 'write',
      targetPath: 'plugin.json',
      digest: digest(manifestContent),
      content: manifestContent,
      mode: '0644',
    },
  ]
  const packageDigest = digest(
    stable({
      algorithm: 'adea-package-files/1',
      files: files
        .map((file) => ({
          digest: file.digest,
          mode: file.action === 'copy' ? 'preserve-source' : file.mode,
          path: file.targetPath,
        }))
        .toSorted((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
    })
  )
  return {
    contractVersion: 1,
    normalizerVersion: 'adea-agent-plugins/1',
    format: 'agent-plugins',
    specVersion: '1.0.0',
    originFormat: 'agent-plugins',
    sourceDigest,
    status: 'portable',
    manifest,
    packageDigest,
    files,
    skills: [{ name: 'review', path: 'skills/review', description: 'Review changes' }],
    mcpServers: {},
    nonPortable: [],
    diagnostics: [],
    requirements: { skills: true, mcpTransports: [], executables: [], environmentReview: false },
  }
}

function snapshotFixture() {
  const sourceDigest = `sha256:${'a'.repeat(64)}`
  const release = {
    releaseId: `release:${'b'.repeat(64)}`,
    resolvedRepositoryUrl: 'https://github.com/example/plugins',
    resolvedCommitSha: 'c'.repeat(40),
    pluginSubdirectory: 'plugins/demo',
    canonicalContentDigest: sourceDigest,
    manifestDigest: `sha256:${'d'.repeat(64)}`,
    contentResolution: 'complete',
    releaseMetadata: { agentPlugins: packageFixture(sourceDigest) },
    requiredConnectors: [],
    requiredCredentials: [],
  }
  const plugin = {
    pluginId: 'plugin:example:demo',
    availableReleases: [release],
    currentReleaseId: release.releaseId,
  }
  return {
    catalog: { plugins: [plugin] },
    catalogId: `catalog:${'e'.repeat(64)}`,
    releaseId: `catalog:${'e'.repeat(64)}`,
    state: 'ready',
    artifacts: { 'catalog.v1.json': JSON.stringify({ plugins: [plugin] }) },
  }
}

describe('Agent Plugins installation planning', () => {
  test('rejects a workspace identity that does not match the request scope', () => {
    expect(() =>
      assertMarketplacePlanRequest({
        workspaceId: 'workspace-a',
        payload: {
          pluginId: 'plugin:example:demo',
          releaseId: `release:${'b'.repeat(64)}`,
          instanceId: 'instance-1',
          requestedHarness: 'codex',
          workspaceIdentity: { workspaceId: 'workspace-b', userId: 'user-1' },
        },
      })
    ).toThrow()
  })

  test('rejects package metadata whose canonical control file differs', () => {
    const sourceDigest = `sha256:${'a'.repeat(64)}`
    const pkg = packageFixture(sourceDigest)
    expect(() =>
      verifyAgentPackage({ ...pkg, manifest: { ...pkg.manifest, name: 'tampered' } })
    ).toThrow()
  })

  test('selects a native plan from a verified package and never grants activation', async () => {
    const snapshot = snapshotFixture()
    const plan = await createMarketplaceAgentPluginsPlan({
      snapshot,
      request: {
        pluginId: 'plugin:example:demo',
        releaseId: `release:${'b'.repeat(64)}`,
        instanceId: 'workspace-user-demo',
        requestedHarness: 'codex',
        workspaceIdentity: { workspaceId: 'workspace-1', userId: 'user-1' },
      },
      profile: {
        profileVersion: 1,
        harness: 'codex',
        runtimeVersion: '1.0.0',
        adapterVersion: '1.0.0',
        agentPlugins: { versions: ['1.0.0'], skills: true, mcpTransports: [] },
        components: { skillDirectories: true, mcpTransports: [] },
      },
    })
    expect(plan).toMatchObject({
      allowedToActivate: false,
      approvalRequired: true,
      compatibility: 'full',
      planVersion: 2,
      strategy: 'native-agent-plugin',
      selection: { skillDirectories: ['skills/review'] },
    })
  })
})
