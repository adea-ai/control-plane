import { createHash } from 'node:crypto'
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common'
import type { MarketplaceCatalogSnapshot } from './registry.js'

const digestPattern = /^sha256:[a-f0-9]{64}$/u
const releasePattern = /^release:[a-f0-9]{64}$/u
/* eslint-disable no-control-regex */
const pathPattern =
  /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[^\\:\u0000-\u001f\u007f/]+(?:\/[^\\:\u0000-\u001f\u007f/]+)*$/u
/* eslint-enable no-control-regex */
const transports = ['stdio', 'streamable-http', 'sse'] as const

type Transport = (typeof transports)[number]
type JsonObject = Record<string, unknown>

export type HarnessProfile = Readonly<{
  profileVersion: 1
  harness: string
  runtimeVersion: string
  adapterVersion: string
  agentPlugins: Readonly<{
    versions: readonly string[]
    skills: boolean
    mcpTransports: readonly Transport[]
  }>
  components: Readonly<{
    skillDirectories: boolean
    mcpTransports: readonly Transport[]
  }>
}>

export type InstallationPlan = Readonly<{
  planVersion: 2
  pluginId: string
  releaseId: string
  instanceId: string
  profile: HarnessProfile
  source: Readonly<{
    repositoryUrl: string
    commitSha: string
    pluginSubdirectory: string
    contentDigest: string
  }>
  package: JsonObject
  packageKey: string
  dataKey: string
  preserveDataAcrossUpdates: true
  strategy: 'native-agent-plugin' | 'component-adapter' | 'unavailable'
  compatibility: 'full' | 'partial' | 'unsupported'
  allowedToActivate: false
  approvalRequired: true
  selection: Readonly<{
    skillDirectories: readonly string[]
    mcpServers: Readonly<Record<string, JsonObject>>
  }>
  disabled: readonly Readonly<{ component: string; reason: string }>[]
  requiredConnectors: readonly string[]
  requiredCredentials: readonly string[]
  preconditions: readonly string[]
}>

export type MarketplaceAgentPluginsPlanRequest = Readonly<{
  pluginId: string
  releaseId: string
  instanceId: string
  requestedHarness: string
  workspaceIdentity: Readonly<{ workspaceId: string; userId: string }>
}>

export interface MarketplaceHarnessProfileAuthority {
  resolve(
    input: Readonly<{ harness: string; workspaceId: string; userId: string }>
  ): Promise<HarnessProfile | undefined>
}

/**
 * Verify the canonical package descriptor embedded in releaseMetadata. This
 * intentionally verifies metadata and recipes only; source bytes and Git modes
 * remain the responsibility of the immutable release verifier at activation.
 */
export function verifyAgentPackage(input: unknown): JsonObject {
  const pkg = requireObject(input, 'Agent Plugins package')
  const status = stringValue(pkg['status'])
  if (!['portable', 'partial', 'unavailable'].includes(status))
    throw new Error('Agent Plugins package status is invalid')
  const files = pkg['files']
  if (!Array.isArray(files) || files.length > 8192)
    throw new Error('Agent Plugins package files are invalid')
  if (status === 'unavailable') {
    if (
      pkg['packageDigest'] !== undefined ||
      files.length > 0 ||
      (Array.isArray(pkg['skills']) && pkg['skills'].length > 0) ||
      (isObject(pkg['mcpServers']) && Object.keys(pkg['mcpServers']).length > 0)
    )
      throw new Error('Unavailable package contains activatable content')
    return pkg
  }
  const packageDigestValue = stringValue(pkg['packageDigest'])
  if (!digestPattern.test(packageDigestValue)) throw new Error('Package digest is invalid')
  if (!Array.isArray(pkg['skills']) || !isObject(pkg['mcpServers']))
    throw new Error('Agent Plugins package components are invalid')
  for (const server of Object.values(pkg['mcpServers'])) validateMcpServer(server)
  const targets = new Set<string>()
  for (const file of files) {
    const entry = requireObject(file, 'Agent Plugins package file')
    const action = stringValue(entry['action'])
    const targetPath = stringValue(entry['targetPath'])
    assertPackagePath(targetPath)
    const key = targetPath.normalize('NFC').toLowerCase()
    if (targets.has(key)) throw new Error('Duplicate package target')
    targets.add(key)
    if (!digestPattern.test(stringValue(entry['digest'])))
      throw new Error('Package file digest is invalid')
    if (action === 'copy') {
      assertPackagePath(stringValue(entry['sourcePath']))
      if (entry['preserveMode'] !== true) throw new Error('Source modes must be preserved')
    } else if (action === 'write') {
      if (entry['mode'] !== '0644' || typeof entry['content'] !== 'string')
        throw new Error('Generated package files are invalid')
      if (sha256(stringValue(entry['content'])) !== entry['digest'])
        throw new Error('Generated package file digest mismatch')
    } else throw new Error('Package file action is invalid')
  }
  for (const target of targets)
    for (let parent = parentPath(target); parent !== ''; parent = parentPath(parent))
      if (targets.has(parent)) throw new Error('Package file/directory collision')
  const manifest = requireObject(pkg['manifest'], 'Agent Plugins manifest')
  const servers = requireObject(pkg['mcpServers'], 'Agent Plugins MCP servers')
  const generated = (targetPath: string): JsonObject => {
    const file = files.find(
      (candidate) =>
        isObject(candidate) &&
        candidate['targetPath'] === targetPath &&
        candidate['action'] === 'write'
    )
    if (!file || typeof file['content'] !== 'string')
      throw new Error('Missing canonical package control file')
    return parseJson(file['content'])
  }
  if (stableJson(generated('plugin.json')) !== stableJson(manifest))
    throw new Error('Manifest descriptor differs from package bytes')
  if (
    stableJson(generated('mcp.json')) !==
    stableJson({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
      mcpServers: servers,
    })
  )
    throw new Error('MCP descriptor differs from package bytes')
  const skillNames = new Set<string>()
  for (const skill of pkg['skills']) {
    const value = requireObject(skill, 'Agent Plugins skill')
    const name = stringValue(value['name'])
    const path = stringValue(value['path'])
    if (
      !name ||
      skillNames.has(name) ||
      path !== `skills/${name}` ||
      !targets.has(`${path}/skill.md`)
    )
      throw new Error('Skill inventory differs from package files')
    skillNames.add(name)
  }
  const discoveredSkills = files
    .map((file) =>
      isObject(file)
        ? /^skills\/([^/]+)\/SKILL\.md$/u.exec(stringValue(file['targetPath']))?.[1]
        : undefined
    )
    .filter((name): name is string => name !== undefined)
  if (
    discoveredSkills.length !== skillNames.size ||
    discoveredSkills.some((name) => !skillNames.has(name))
  )
    throw new Error('Skill inventory differs from package discovery')
  const requirements = requireObject(pkg['requirements'], 'Agent Plugins requirements')
  const expectedTransports = [...new Set(Object.values(servers).map(serverType))].toSorted()
  const expectedExecutables = Object.values(servers)
    .filter((server) => serverType(server) === 'stdio')
    .map((server) => stringValue(requireObject(server, 'MCP server')['command']))
    .filter(Boolean)
    .toSorted()
  if (
    requirements['skills'] !== skillNames.size > 0 ||
    stableJson(stringArray(requirements['mcpTransports']).toSorted()) !==
      stableJson(expectedTransports) ||
    stableJson(stringArray(requirements['executables']).toSorted()) !==
      stableJson(expectedExecutables)
  )
    throw new Error('Package requirements differ from components')
  if (packageDigest(files) !== packageDigestValue)
    throw new Error('Canonical package digest mismatch')
  if (status === 'portable') {
    const nonPortable = pkg['nonPortable']
    const diagnostics = pkg['diagnostics']
    if ((Array.isArray(nonPortable) && nonPortable.length > 0) || hasErrorDiagnostic(diagnostics))
      throw new Error('Partial package is marked portable')
  }
  return pkg
}

export async function createMarketplaceAgentPluginsPlan(
  input: Readonly<{
    snapshot: MarketplaceCatalogSnapshot
    request: MarketplaceAgentPluginsPlanRequest
    profile: HarnessProfile
  }>
): Promise<InstallationPlan> {
  if (input.snapshot.state !== 'ready')
    throw new MarketplaceRegistryPlanError(
      'MARKETPLACE_CATALOG_STALE',
      'A stale marketplace snapshot cannot produce an installation plan'
    )
  assertHarnessProfile(input.profile)
  if (input.profile.harness !== input.request.requestedHarness)
    throw new MarketplaceRegistryPlanError(
      'MARKETPLACE_HARNESS_PROFILE_MISMATCH',
      'The selected harness profile does not match the requested harness'
    )
  const rawCatalog = parseJson(input.snapshot.artifacts['catalog.v1.json'])
  const plugins = rawCatalog['plugins']
  if (!Array.isArray(plugins)) throw invalidCatalog()
  const plugin = plugins.find(
    (candidate): candidate is JsonObject =>
      isObject(candidate) && candidate['pluginId'] === input.request.pluginId
  )
  if (!plugin)
    throw new MarketplaceRegistryPlanError('MARKETPLACE_PLUGIN_NOT_FOUND', 'Plugin not found')
  const releases = plugin['availableReleases']
  const release = Array.isArray(releases)
    ? releases.find(
        (candidate): candidate is JsonObject =>
          isObject(candidate) && candidate['releaseId'] === input.request.releaseId
      )
    : undefined
  if (!release)
    throw new MarketplaceRegistryPlanError('MARKETPLACE_RELEASE_NOT_FOUND', 'Release not found')
  if (release['contentResolution'] !== 'complete')
    throw new MarketplaceRegistryPlanError(
      'MARKETPLACE_COMPLETE_SOURCE_REQUIRED',
      'A metadata-only release cannot produce an activation plan'
    )
  let metadata: JsonObject
  try {
    metadata = requireObject(release['releaseMetadata'], 'Release metadata')
  } catch {
    throw invalidPlan('Release metadata is invalid')
  }
  let pkg: JsonObject
  try {
    pkg = verifyAgentPackage(metadata['agentPlugins'])
  } catch (error) {
    throw invalidPlan(error instanceof Error ? error.message : 'Agent Plugins package is invalid')
  }
  const source = {
    commitSha: stringValue(release['resolvedCommitSha']),
    contentDigest: stringValue(release['canonicalContentDigest']),
    pluginSubdirectory: stringValue(release['pluginSubdirectory']),
    repositoryUrl: stringValue(release['resolvedRepositoryUrl']),
  }
  if (!/^[a-f0-9]{40}$/u.test(source.commitSha) || !digestPattern.test(source.contentDigest))
    throw invalidPlan('Release source identity is invalid')
  if (stringValue(pkg['sourceDigest']) !== source.contentDigest)
    throw invalidPlan('Package recipe does not match the selected immutable release')

  const disabled: Array<{ component: string; reason: string }> = []
  const nonPortable = pkg['nonPortable']
  if (Array.isArray(nonPortable))
    for (const item of nonPortable) {
      const value = requireObject(item, 'Non-portable component')
      disabled.push({ component: stringValue(value['kind']), reason: stringValue(value['reason']) })
    }
  const diagnostics = pkg['diagnostics']
  if (Array.isArray(diagnostics))
    for (const item of diagnostics) {
      const value = requireObject(item, 'Package diagnostic')
      if (value['severity'] === 'error')
        disabled.push({
          component: stringValue(value['path']),
          reason: stringValue(value['message']),
        })
    }

  const skills = Array.isArray(pkg['skills']) ? pkg['skills'].filter(isObject) : []
  const servers = isObject(pkg['mcpServers']) ? pkg['mcpServers'] : {}
  const manifest = isObject(pkg['manifest']) ? pkg['manifest'] : {}
  const nativeEligible =
    input.profile.agentPlugins.versions.includes(stringValue(pkg['specVersion'])) &&
    disabled.length === 0 &&
    (!isObject(manifest['extensions']) || Object.keys(manifest['extensions']).length === 0)
  const nativeCoverage =
    (input.profile.agentPlugins.skills ? skills.length : 0) +
    Object.values(servers).filter((server) =>
      input.profile.agentPlugins.mcpTransports.includes(serverType(server))
    ).length
  const adapterCoverage =
    (input.profile.components.skillDirectories ? skills.length : 0) +
    Object.values(servers).filter((server) =>
      input.profile.components.mcpTransports.includes(serverType(server))
    ).length
  const native = nativeEligible && nativeCoverage > 0 && nativeCoverage >= adapterCoverage
  const strategy =
    statusValue(pkg) === 'unavailable'
      ? 'unavailable'
      : native
        ? 'native-agent-plugin'
        : 'component-adapter'
  let skillDirectories: string[] = []
  const selectedServers: Record<string, JsonObject> = {}
  if (strategy !== 'unavailable') {
    if (native ? input.profile.agentPlugins.skills : input.profile.components.skillDirectories)
      skillDirectories = skills.map((skill) => stringValue(skill['path'])).filter(Boolean)
    else
      for (const skill of skills)
        disabled.push({
          component: `skill:${stringValue(skill['name'])}`,
          reason: 'The selected adapter cannot expose skill directories.',
        })
    for (const [name, serverInput] of Object.entries(servers)) {
      const server = requireObject(serverInput, `MCP server ${name}`)
      const transport = serverType(server)
      if (
        (native
          ? input.profile.agentPlugins.mcpTransports
          : input.profile.components.mcpTransports
        ).includes(transport)
      )
        selectedServers[name] = server
      else
        disabled.push({
          component: `mcp:${name}`,
          reason: `No ${transport} MCP binding on this harness adapter.`,
        })
    }
  }
  const hasContent = skillDirectories.length > 0 || Object.keys(selectedServers).length > 0
  const compatibility = !hasContent ? 'unsupported' : disabled.length > 0 ? 'partial' : 'full'
  const selectedStrategy = !hasContent ? 'unavailable' : strategy
  const requiredConnectors = stringArray(release['requiredConnectors'])
  const requiredCredentials = stringArray(release['requiredCredentials'])
  return {
    allowedToActivate: false,
    approvalRequired: true,
    compatibility,
    dataKey: `instances/${identity(input.request.pluginId, input.request.instanceId)}`,
    disabled,
    instanceId: input.request.instanceId,
    package: pkg,
    packageKey: `packages/${identity(source.repositoryUrl, source.commitSha, source.pluginSubdirectory, stringValue(pkg['packageDigest']))}`,
    planVersion: 2,
    pluginId: input.request.pluginId,
    preconditions: [
      'Verify catalog integrity/provenance and exact source digest before applying the package recipe.',
      'Use an immutable package root and preserve source file modes.',
      'Create a writable data directory for this installation instance; never key it by release.',
      'Control Plane must authorize activation, filesystem/network access, executables and credentials.',
      'Recheck the actual harness/runtime/adapter profile and realpath containment immediately before activation.',
      'Do not install dependencies or run lifecycle scripts implicitly.',
    ],
    preserveDataAcrossUpdates: true,
    profile: input.profile,
    releaseId: input.request.releaseId,
    requiredConnectors,
    requiredCredentials,
    selection: { mcpServers: selectedServers, skillDirectories },
    source,
    strategy: selectedStrategy,
  }
}

export function assertMarketplacePlanRequest(value: unknown): MarketplaceAgentPluginsPlanRequest {
  if (!isObject(value) || !isObject(value['payload']))
    throw new BadRequestException({
      code: 'MARKETPLACE_REQUEST_INVALID',
      message: 'Marketplace installation-plan request is invalid',
    })
  const payload = value['payload']
  if (!isObject(payload['workspaceIdentity']))
    throw new BadRequestException({
      code: 'MARKETPLACE_REQUEST_INVALID',
      message: 'Marketplace installation-plan request is invalid',
    })
  const workspaceIdentity = payload['workspaceIdentity']
  if (
    !stringValue(value['workspaceId']) ||
    stringValue(value['workspaceId']) !== stringValue(workspaceIdentity['workspaceId']) ||
    !stringValue(payload['pluginId']) ||
    !releasePattern.test(stringValue(payload['releaseId'])) ||
    !stringValue(payload['instanceId']) ||
    stringValue(payload['instanceId']).length > 256 ||
    !stringValue(payload['requestedHarness']) ||
    !stringValue(workspaceIdentity['workspaceId']) ||
    !stringValue(workspaceIdentity['userId'])
  )
    throw new BadRequestException({
      code: 'MARKETPLACE_REQUEST_INVALID',
      message: 'Marketplace installation-plan request is invalid',
    })
  return {
    instanceId: stringValue(payload['instanceId']),
    pluginId: stringValue(payload['pluginId']),
    releaseId: stringValue(payload['releaseId']),
    requestedHarness: stringValue(payload['requestedHarness']),
    workspaceIdentity: {
      userId: stringValue(workspaceIdentity['userId']),
      workspaceId: stringValue(workspaceIdentity['workspaceId']),
    },
  }
}

export class MarketplaceRegistryPlanError extends Error {
  constructor(
    readonly code:
      | 'MARKETPLACE_PORTABLE_CATALOG_INVALID'
      | 'MARKETPLACE_CATALOG_STALE'
      | 'MARKETPLACE_HARNESS_PROFILE_MISMATCH'
      | 'MARKETPLACE_PLUGIN_NOT_FOUND'
      | 'MARKETPLACE_RELEASE_NOT_FOUND'
      | 'MARKETPLACE_COMPLETE_SOURCE_REQUIRED'
      | 'MARKETPLACE_INSTALLATION_PLAN_INVALID',
    message: string
  ) {
    super(message)
    this.name = 'MarketplaceRegistryPlanError'
  }
}

export function planFailureResponse(error: MarketplaceRegistryPlanError): never {
  if (error.code === 'MARKETPLACE_CATALOG_STALE')
    throw new ServiceUnavailableException({ code: error.code, message: error.message })
  throw new BadRequestException({ code: error.code, message: error.message })
}

function assertHarnessProfile(value: HarnessProfile): void {
  if (
    value.profileVersion !== 1 ||
    !value.harness ||
    !value.runtimeVersion ||
    !value.adapterVersion ||
    !profilePart(value.agentPlugins, false) ||
    !profilePart(value.components, true)
  )
    throw invalidPlan('Harness profile is invalid')
}

function profilePart(value: unknown, components: boolean): boolean {
  if (!isObject(value) || !Array.isArray(value['mcpTransports'])) return false
  if (!value['mcpTransports'].every((item) => transports.includes(item as Transport))) return false
  return components
    ? typeof value['skillDirectories'] === 'boolean'
    : Array.isArray(value['versions']) &&
        value['versions'].every((item) => typeof item === 'string') &&
        typeof value['skills'] === 'boolean'
}

function packageDigest(files: readonly unknown[]): string {
  return sha256(
    stableJson({
      algorithm: 'adea-package-files/1',
      files: files
        .map((file) => {
          const value = requireObject(file, 'Package file')
          return {
            digest: stringValue(value['digest']),
            mode: value['action'] === 'copy' ? 'preserve-source' : value['mode'],
            path: stringValue(value['targetPath']),
          }
        })
        .toSorted((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
    })
  )
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const object = value as JsonObject
  return `{${Object.keys(object)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(',')}}`
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function identity(...parts: string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

function assertPackagePath(value: string): void {
  if (!pathPattern.test(value) || value.split('/').some((part) => /[. ]$/u.test(part)))
    throw new Error('Unsafe package-relative path')
}

function parentPath(value: string): string {
  const index = value.lastIndexOf('/')
  return index < 0 ? '' : value.slice(0, index)
}

function serverType(value: unknown): Transport {
  const type = isObject(value) ? value['type'] : undefined
  if (!transports.includes(type as Transport)) throw new Error('MCP transport is invalid')
  return type as Transport
}

function validateMcpServer(value: unknown): void {
  const server = requireObject(value, 'MCP server')
  const type = serverType(server)
  if (type === 'stdio') {
    const command = stringValue(server['command'])
    if (
      !command ||
      command.includes('\u0000') ||
      (command.startsWith('./')
        ? !pathPattern.test(command.slice(2))
        : !/^[^\\/\s:$]+$/u.test(command))
    )
      throw new Error('MCP executable binding is invalid')
    if (
      server['args'] !== undefined &&
      (!Array.isArray(server['args']) ||
        server['args'].some((arg) => typeof arg !== 'string' || arg.includes('\u0000')))
    )
      throw new Error('MCP arguments are invalid')
    if (isObject(server['env']))
      for (const [key, entry] of Object.entries(server['env'])) {
        if (
          /^PLUGIN_(?:ROOT|DATA)$/iu.test(key) ||
          key.includes('=') ||
          typeof entry !== 'string' ||
          entry.includes('\u0000')
        )
          throw new Error('MCP environment binding is invalid')
      }
    return
  }
  let url: URL
  try {
    url = new URL(stringValue(server['url']))
  } catch {
    throw new Error('MCP URL is invalid')
  }
  const host = url.hostname.replace(/^\[|\]$/gu, '')
  const loopback = host === 'localhost' || host === '::1' || host.startsWith('127.')
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    (url.protocol !== 'https:' && !loopback) ||
    url.username ||
    url.password ||
    url.hash ||
    url.href.includes('\\')
  )
    throw new Error('MCP remote endpoint is invalid')
  const reserved = new Set([
    'authorization',
    'connection',
    'content-length',
    'host',
    'transfer-encoding',
    'upgrade',
  ])
  if (isObject(server['headers']))
    for (const [key, entry] of Object.entries(server['headers']))
      if (
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(key) ||
        typeof entry !== 'string' ||
        reserved.has(key.toLowerCase())
      )
        throw new Error('MCP header binding is invalid')
}

function hasErrorDiagnostic(value: unknown): boolean {
  return (
    Array.isArray(value) && value.some((item) => isObject(item) && item['severity'] === 'error')
  )
}

function statusValue(value: JsonObject): string {
  return stringValue(value['status'])
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function parseJson(value: string): JsonObject {
  try {
    return requireObject(JSON.parse(value), 'catalog.v1.json')
  } catch {
    throw invalidCatalog()
  }
}

function invalidCatalog(): MarketplaceRegistryPlanError {
  return new MarketplaceRegistryPlanError(
    'MARKETPLACE_PORTABLE_CATALOG_INVALID',
    'The catalog is invalid'
  )
}

function invalidPlan(message: string): MarketplaceRegistryPlanError {
  return new MarketplaceRegistryPlanError('MARKETPLACE_INSTALLATION_PLAN_INVALID', message)
}

function requireObject(value: unknown, name: string): JsonObject {
  if (!isObject(value)) throw new Error(`${name} must be an object`)
  return value
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
