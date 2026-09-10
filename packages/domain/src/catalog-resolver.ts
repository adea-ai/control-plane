import { createHash } from 'node:crypto'
import { AgentProfileVersionSchema, type SkillVersion } from './catalog-models.js'
import {
  ExecutionConstraintSetSchema,
  composeExecutionConstraints,
  type ExecutionConstraintSet,
} from './execution-constraints.js'
import type { SkillRepository } from './versioned-catalog.js'

export type ResolutionLayer =
  | 'platform-security'
  | 'workspace-policy'
  | 'agent-profile'
  | 'task-runtime'
  | 'agent-defaults'
  | 'task-skill-augmentation'
  | 'harness-project'

export class CatalogResolutionError extends Error {
  constructor(
    readonly code: string,
    readonly details: readonly string[] = []
  ) {
    super(code)
    this.name = 'CatalogResolutionError'
  }
}

export interface SkillRequest {
  readonly skillId: string
  readonly versionRange: string
  readonly source: 'profile-baseline' | 'task-authorized' | 'dependency'
  readonly requestedBy?: string
}

export interface ResolvedSkill {
  readonly skillVersionId: string
  readonly skillId: string
  readonly semanticVersion: string
  readonly contentDigest: string
  readonly dependencies: readonly SkillRequest[]
}

export interface ResolutionProvenance {
  readonly layers: readonly ResolutionLayer[]
  readonly selected: readonly {
    readonly skillId: string
    readonly requestedRanges: readonly string[]
    readonly skillVersionId: string
    readonly semanticVersion: string
    readonly contentDigest: string
    readonly reason: 'profile-baseline' | 'task-authorized' | 'dependency'
  }[]
  readonly decisions: readonly string[]
  readonly digest: string
}

export interface ResolvedCatalogManifest {
  readonly profileVersionId: string
  readonly profileDigest: string
  readonly skills: readonly ResolvedSkill[]
  readonly provenance: ResolutionProvenance
}

/**
 * Compose policy layers from strongest to weakest. Every layer is restrictive;
 * consequently a later layer can narrow an earlier one but cannot grant new
 * tools, models, locations, permissions, budgets, or instructions.
 */
export function resolveConstraintLayers(
  layers: readonly { readonly layer: ResolutionLayer; readonly constraints: unknown }[]
): { readonly constraints: ExecutionConstraintSet; readonly layers: readonly ResolutionLayer[] } {
  if (layers.length === 0) throw new CatalogResolutionError('CONSTRAINT_LAYERS_REQUIRED')
  const parsed = layers.map((entry) => ({
    layer: entry.layer,
    constraints: ExecutionConstraintSetSchema.parse(entry.constraints),
  }))
  return {
    constraints: composeExecutionConstraints(parsed.map((entry) => entry.constraints)),
    layers: parsed.map((entry) => entry.layer),
  }
}

export async function resolveCatalogManifest(input: {
  readonly profile: unknown
  readonly skills: SkillRepository
  readonly taskSkills?: readonly Omit<SkillRequest, 'source'>[]
  readonly layers?: Partial<Record<ResolutionLayer, unknown>>
}): Promise<ResolvedCatalogManifest> {
  const profile = AgentProfileVersionSchema.parse(input.profile)
  if (profile.lifecycle !== 'published' && profile.lifecycle !== 'deprecated') {
    throw new CatalogResolutionError('PROFILE_NOT_EXECUTABLE', [profile.profileVersionId])
  }

  const requests = new Map<string, SkillRequest[]>()
  const add = (request: SkillRequest) => {
    const list = requests.get(request.skillId) ?? []
    if (
      !list.some(
        (item) => item.versionRange === request.versionRange && item.source === request.source
      )
    ) {
      list.push(request)
      requests.set(request.skillId, list)
    }
  }
  for (const pin of profile.definition.skills) {
    const version = await input.skills.getSkillVersion(pin.skillVersionId)
    if (
      !version ||
      version.skillId !== pin.skillId ||
      version.manifest.contentDigest !== pin.contentDigest
    ) {
      throw new CatalogResolutionError('PROFILE_SKILL_PIN_INVALID', [pin.skillVersionId])
    }
    add({
      skillId: pin.skillId,
      versionRange: `=${version.manifest.semanticVersion}`,
      source: 'profile-baseline',
      requestedBy: profile.profileVersionId,
    })
  }
  for (const taskSkill of input.taskSkills ?? []) add({ ...taskSkill, source: 'task-authorized' })

  const selected = new Map<string, SkillVersion>()
  const reasons = new Map<string, SkillRequest['source']>()
  const visiting = new Set<string>()
  const visit = async (skillId: string): Promise<void> => {
    if (visiting.has(skillId))
      throw new CatalogResolutionError('SKILL_DEPENDENCY_CYCLE', [...visiting, skillId].toSorted())
    if (selected.has(skillId)) return
    const constraints = requests.get(skillId) ?? []
    if (constraints.length === 0)
      throw new CatalogResolutionError('SKILL_REQUEST_MISSING', [skillId])
    visiting.add(skillId)
    const versions = (await input.skills.listSkillVersions(skillId))
      .filter(
        (version) =>
          version.lifecycle === 'published' && !isPrerelease(version.manifest.semanticVersion)
      )
      .filter((version) =>
        constraints.every((request) =>
          satisfies(version.manifest.semanticVersion, request.versionRange)
        )
      )
      .toSorted(
        (left, right) =>
          compareVersions(right.manifest.semanticVersion, left.manifest.semanticVersion) ||
          left.skillVersionId.localeCompare(right.skillVersionId)
      )
    const version = versions[0]
    if (!version)
      throw new CatalogResolutionError(
        'SKILL_VERSION_UNSATISFIED',
        constraints.map((item) => `${skillId}:${item.versionRange}`).toSorted()
      )
    selected.set(skillId, version)
    const reason =
      constraints.find((item) => item.source === 'profile-baseline')?.source ??
      constraints[0]?.source
    if (!reason) throw new CatalogResolutionError('SKILL_REQUEST_MISSING', [skillId])
    reasons.set(skillId, reason)
    for (const dependency of [...version.manifest.dependencies].toSorted(
      (a, b) => a.skillId.localeCompare(b.skillId) || a.versionRange.localeCompare(b.versionRange)
    )) {
      const dependencyRequests = requests.get(dependency.skillId) ?? []
      dependencyRequests.push({
        ...dependency,
        source: 'dependency',
        requestedBy: version.skillVersionId,
      })
      requests.set(dependency.skillId, dependencyRequests)
      await visit(dependency.skillId)
    }
    visiting.delete(skillId)
  }
  for (const skillId of [...requests.keys()].toSorted()) await visit(skillId)

  const selectedVersions = [...selected.values()]
  for (const version of selectedVersions) {
    for (const conflict of version.manifest.conflicts) {
      const other = selected.get(conflict.skillId)
      if (!other || !satisfies(other.manifest.semanticVersion, conflict.versionRange)) continue
      const supersedes = version.manifest.supersedes.some(
        (relation) =>
          relation.skillId === other.skillId &&
          satisfies(other.manifest.semanticVersion, relation.versionRange)
      )
      if (!supersedes)
        throw new CatalogResolutionError(
          'SKILL_CONFLICT',
          [version.skillVersionId, other.skillVersionId].toSorted()
        )
    }
  }

  const ordered = topologicalOrder(selected)
  const resolved = ordered.map((version) => ({
    skillVersionId: version.skillVersionId,
    skillId: version.skillId,
    semanticVersion: version.manifest.semanticVersion,
    contentDigest: version.manifest.contentDigest,
    dependencies: [...version.manifest.dependencies]
      .toSorted(
        (a, b) => a.skillId.localeCompare(b.skillId) || a.versionRange.localeCompare(b.versionRange)
      )
      .map((dependency) => ({ ...dependency, source: 'dependency' as const })),
  }))
  const provenance = {
    layers: [
      'platform-security',
      'workspace-policy',
      'agent-profile',
      'task-runtime',
      'agent-defaults',
      'task-skill-augmentation',
      'harness-project',
    ] satisfies ResolutionLayer[],
    selected: resolved.map((skill) => ({
      ...skill,
      requestedRanges: (requests.get(skill.skillId) ?? [])
        .map((request) => request.versionRange)
        .toSorted(),
      reason: reasons.get(skill.skillId) ?? 'dependency',
    })),
    decisions: [...selected.keys()]
      .toSorted()
      .map((skillId) => `SELECTED:${skillId}:${selected.get(skillId)?.skillVersionId}`),
  }
  return {
    profileVersionId: profile.profileVersionId,
    profileDigest: profile.contentDigest,
    skills: resolved,
    provenance: { ...provenance, digest: digest(provenance) },
  }
}

function topologicalOrder(selected: Map<string, SkillVersion>): SkillVersion[] {
  const result: SkillVersion[] = []
  const visited = new Set<string>()
  const visit = (skillId: string) => {
    if (visited.has(skillId)) return
    visited.add(skillId)
    const version = selected.get(skillId)
    if (!version) return
    for (const dependency of [...version.manifest.dependencies].toSorted((a, b) =>
      a.skillId.localeCompare(b.skillId)
    ))
      visit(dependency.skillId)
    result.push(version)
  }
  for (const skillId of [...selected.keys()].toSorted()) visit(skillId)
  return result
}

function isPrerelease(version: string): boolean {
  return version.includes('-')
}

function parseVersion(version: string): [number, number, number, string] {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(version)
  if (!match) throw new CatalogResolutionError('INVALID_SEMVER', [version])
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? '']
}

function compareVersions(left: string, right: string): number {
  const a = parseVersion(left),
    b = parseVersion(right)
  const [aMajor, aMinor, aPatch] = a
  const [bMajor, bMinor, bPatch] = b
  for (const [leftPart, rightPart] of [
    [aMajor, bMajor],
    [aMinor, bMinor],
    [aPatch, bPatch],
  ] as const) {
    if (leftPart !== rightPart) return leftPart - rightPart
  }
  if (a[3] === b[3]) return 0
  if (!a[3]) return 1
  if (!b[3]) return -1
  return a[3].localeCompare(b[3])
}

function satisfies(version: string, range: string): boolean {
  const value = parseVersion(version)
  return range.split('||').some((part) =>
    part
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .every((token) => {
        const operator = /^(\^|~|>=|<=|>|<|=)?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/.exec(
          token.trim()
        )
        if (!operator) return token.trim() === '*' || token.trim() === ''
        const major = Number(operator[2]),
          minor = operator[3] && !/[x*]/.test(operator[3]) ? Number(operator[3]) : undefined
        const patch = operator[4] && !/[x*]/.test(operator[4]) ? Number(operator[4]) : undefined
        const lower = [major, minor ?? 0, patch ?? 0, ''].join('.')
        const comparison = compareVersions(version, lower)
        if (!operator[1])
          return (
            value[0] === major &&
            (minor === undefined || value[1] === minor) &&
            (patch === undefined || value[2] === patch)
          )
        if (operator[1] === '^') return comparison >= 0 && value[0] === major
        if (operator[1] === '~')
          return (
            comparison >= 0 && value[0] === major && (minor === undefined || value[1] === minor)
          )
        return (
          {
            '>=': comparison >= 0,
            '<=': comparison <= 0,
            '>': comparison > 0,
            '<': comparison < 0,
            '=': comparison === 0,
          }[operator[1]] ?? false
        )
      })
  )
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}
