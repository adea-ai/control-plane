import { digestJson } from './manifest.js'

export type ConformancePort =
  | 'catalog'
  | 'project-state'
  | 'context'
  | 'execution-plan'
  | 'persistence'
  | 'workflow-runtime'
  | 'object-store'
  | 'secrets'
  | 'runtime-transport'
  | 'policy'
  | 'usage'
  | 'orchestration'
  | 'domain-contract'
  | 'telemetry'

export interface ProfileConformanceAdapter {
  readonly profile: 'cloud' | 'local' | 'hosted-simple' | 'hosted-server'
  readonly ports: Readonly<Record<ConformancePort, string>>
  run(caseId: string, input: unknown): Promise<unknown>
}

export interface ProfileConformanceCase {
  readonly caseId: string
  readonly owner: ConformancePort
  readonly input: unknown
  readonly normalize?: (output: unknown) => unknown
}

export interface ProfileConformanceResult {
  readonly schemaVersion: 1
  readonly baselineProfile: 'cloud'
  readonly cases: readonly {
    readonly caseId: string
    readonly owner: ConformancePort
    readonly baselineDigest: `sha256:${string}`
    readonly profiles: readonly {
      readonly profile: ProfileConformanceAdapter['profile']
      readonly adapter: string
      readonly digest: `sha256:${string}`
      readonly conforms: boolean
    }[]
  }[]
  readonly conforms: boolean
}

export async function runProfileConformance(
  adapters: readonly ProfileConformanceAdapter[],
  cases: readonly ProfileConformanceCase[]
): Promise<ProfileConformanceResult> {
  const profiles = new Set(adapters.map(({ profile }) => profile))
  for (const required of ['cloud', 'local', 'hosted-simple', 'hosted-server'] as const) {
    if (!profiles.has(required)) throw new Error(`PROFILE_CONFORMANCE_MISSING:${required}`)
  }
  if (profiles.size !== adapters.length) throw new Error('PROFILE_CONFORMANCE_DUPLICATE')
  const baseline = adapters.find(({ profile }) => profile === 'cloud')
  if (baseline === undefined) throw new Error('PROFILE_CONFORMANCE_MISSING:cloud')
  const results = []
  for (const fixture of cases) {
    const normalize = fixture.normalize ?? ((value: unknown) => value)
    const baselineDigest = digestJson(normalize(await baseline.run(fixture.caseId, fixture.input)))
    // Callers own adapter resources. Drain every started adapter before
    // propagating a failure so their cleanup cannot race with live siblings.
    const settled = await Promise.allSettled(
      adapters.map(async (adapter) => {
        const digest =
          adapter === baseline
            ? baselineDigest
            : digestJson(normalize(await adapter.run(fixture.caseId, fixture.input)))
        return {
          profile: adapter.profile,
          adapter: adapter.ports[fixture.owner],
          digest,
          conforms: digest === baselineDigest,
        }
      })
    )
    const errors = settled.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    )
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1)
      throw new AggregateError(errors, `PROFILE_CONFORMANCE_FAILED:${fixture.caseId}`)
    const profileResults = settled.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : []
    )
    results.push({
      caseId: fixture.caseId,
      owner: fixture.owner,
      baselineDigest,
      profiles: profileResults,
    })
  }
  return {
    schemaVersion: 1,
    baselineProfile: 'cloud',
    cases: results,
    conforms: results.every(({ profiles: profileResults }) =>
      profileResults.every(({ conforms }) => conforms)
    ),
  }
}
