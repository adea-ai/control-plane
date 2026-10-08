import { RuntimeCapabilityNameSchema, type RuntimeCapabilityName } from '@control-plane/runtime-sdk'
import { z } from 'zod'
import { SemanticVersionSchema } from './acp-schemas.ts'
import type { AcpGatewayConnectionState } from './acp-gateway-types.ts'
import { pinnedAcpBuild } from './pinned-codex-build.ts'

/**
 * Executor qualification (M13.03). Pure, fail-closed evaluator that turns
 * trusted deployment evidence into the exact capability set an ACP execution
 * bridge may claim for one observed native executor. It never performs I/O,
 * never contacts a harness, never routes around a denial, and never accepts,
 * stores, or returns credentials: the evidence schema has no credential fields
 * and rejects unknown keys, so credentials cannot enter through evidence.
 */

/** Supported ACP harness routes. Pi is deliberately absent: Pi dispatch is not native checkpointing or subscription entitlement. */
export const ExecutorHarnessSchema = z.enum(['codex', 'opencode', 'claude'])
export type ExecutorHarness = z.output<typeof ExecutorHarnessSchema>

/** Execution locations; mirrors the deployment execution-target vocabulary. `agent_hq_cloud` never qualifies a native executor route. */
export const ExecutionLocationSchema = z.enum(['local_device', 'remote_host', 'agent_hq_cloud'])
export type ExecutionLocation = z.output<typeof ExecutionLocationSchema>

/**
 * Authentication modes. Only `native_owned` keeps credentials on the executor;
 * `cloud_vault` and `delegated_session` never qualify a native executor route.
 */
export const AuthenticationModeSchema = z.enum(['native_owned', 'cloud_vault', 'delegated_session'])
export type AuthenticationMode = z.output<typeof AuthenticationModeSchema>

/** Governed native effect channels; each requires proven pre-effect policy enforcement before it may appear as qualified. */
export const GovernedNativePathSchema = z.enum(['shell', 'network', 'hooks', 'mcp', 'extensions'])
export type GovernedNativePath = z.output<typeof GovernedNativePathSchema>

/** Transport reachability; reuses the gateway connection-state vocabulary. */
export const TransportStateSchema = z.enum([
  'online',
  'offline',
  'revoked',
]) satisfies z.ZodType<AcpGatewayConnectionState>
export type TransportState = z.output<typeof TransportStateSchema>

const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/)

/**
 * Native-installation evidence: the exact build identity that was verified at
 * qualification time. For the codex route this must equal the pinned ACP build
 * (`pinnedAcpBuild`); any drift fails closed as `evidence_mismatch`.
 */
export const NativeInstallationEvidenceSchema = z.strictObject({
  repository: z.string().min(1).max(512),
  tag: z.string().min(1).max(128),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  bundleSha256: Sha256HexSchema,
})
export type NativeInstallationEvidence = z.output<typeof NativeInstallationEvidenceSchema>

const GovernedPathEvidenceSchema = z.strictObject({
  path: GovernedNativePathSchema,
  policyEnforced: z.boolean(),
})

/**
 * Trusted deployment evidence for one native executor route. Records are
 * supplied by deployment configuration, never by the executor or a session
 * request (same trust boundary as model-gateway qualification records).
 */
export const ExecutorQualificationEvidenceSchema = z
  .strictObject({
    harness: ExecutorHarnessSchema,
    harnessVersion: SemanticVersionSchema,
    location: ExecutionLocationSchema,
    authentication: AuthenticationModeSchema,
    /** Deployment authorization for this route and location; unauthorized records never qualify. */
    deploymentAuthorized: z.boolean(),
    nativeInstallation: NativeInstallationEvidenceSchema,
    /** Digest of the qualified native configuration (settings, hooks, MCP registrations). */
    configurationDigest: Sha256HexSchema,
    /** Explicit capability allow-list derived only from evidence. Absent names stay disabled. */
    capabilities: RuntimeCapabilityNameSchema.array().max(64),
    /** Usage claims (usage_update/snapshot usage) are opt-in evidence; default disabled. */
    usageReporting: z.boolean(),
    governedPaths: GovernedPathEvidenceSchema.array().max(8),
    validUntil: z.iso.datetime(),
    revokedAt: z.iso.datetime().optional(),
  })
  .refine(
    (record) => new Set(record.capabilities).size === record.capabilities.length,
    'Capability evidence must be unique'
  )
  .refine(
    (record) =>
      new Set(record.governedPaths.map((path) => path.path)).size === record.governedPaths.length,
    'Governed path evidence must be unique'
  )
export type ExecutorQualificationEvidence = z.output<typeof ExecutorQualificationEvidenceSchema>

/** Live observation of one executor, as detected at evaluation time (never trusted, always compared against evidence). */
export const ExecutorObservationSchema = z.strictObject({
  harness: ExecutorHarnessSchema,
  harnessVersion: SemanticVersionSchema,
  location: ExecutionLocationSchema,
  authentication: AuthenticationModeSchema,
  nativeInstallation: NativeInstallationEvidenceSchema,
  configurationDigest: Sha256HexSchema,
  transport: TransportStateSchema,
  /** Effect channels the native harness currently exposes. */
  nativePaths: GovernedNativePathSchema.array().max(8),
})
export type ExecutorObservation = z.output<typeof ExecutorObservationSchema>

/**
 * Typed fail-closed reasons. `evidence_missing`, `evidence_expired`,
 * `evidence_revoked` and `evidence_mismatch` cover missing, stale, revoked and
 * drifted evidence; the transport reasons are local denials that never suggest
 * or enable a cloud reroute (`fallback: 'none'`).
 */
export type ExecutorQualificationFailure =
  | { readonly reason: 'evidence_invalid'; readonly detail: string }
  | { readonly reason: 'evidence_missing'; readonly harness: ExecutorHarness }
  | { readonly reason: 'evidence_expired'; readonly expiredAt: string }
  | { readonly reason: 'evidence_revoked'; readonly revokedAt: string }
  | {
      readonly reason: 'evidence_mismatch'
      readonly field:
        | 'harnessVersion'
        | 'location'
        | 'nativeInstallation'
        | 'configurationDigest'
        | 'deploymentPin'
      readonly detail: string
    }
  | { readonly reason: 'auth_unsupported'; readonly authentication: AuthenticationMode }
  | { readonly reason: 'location_unauthorized'; readonly location: ExecutionLocation }
  | { readonly reason: 'transport_offline'; readonly fallback: 'none' }
  | { readonly reason: 'transport_revoked'; readonly fallback: 'none' }

export interface DisabledGovernedNativePath {
  readonly path: GovernedNativePath
  readonly reason: 'not_evidenced' | 'controls_missing'
}

/**
 * Evaluated qualification. When `qualified` is false every allow-list is empty
 * and every optional claim is disabled; nothing defaults to permissive.
 */
export interface ExecutorQualification {
  readonly qualified: boolean
  readonly failure: ExecutorQualificationFailure | null
  readonly capabilities: readonly RuntimeCapabilityName[]
  readonly governedNativePaths: readonly GovernedNativePath[]
  readonly disabledGovernedNativePaths: readonly DisabledGovernedNativePath[]
  readonly usageReporting: boolean
}

/** Build identity the codex route must match exactly to qualify; derived from the pinned ACP build, never duplicated. */
const pinnedCodexInstallation: NativeInstallationEvidence = {
  repository: pinnedAcpBuild.repository,
  tag: pinnedAcpBuild.tag,
  commit: pinnedAcpBuild.commit,
  bundleSha256: pinnedAcpBuild.bundleSha256,
}

const unqualified: ExecutorQualification = {
  qualified: false,
  failure: null,
  capabilities: [],
  governedNativePaths: [],
  disabledGovernedNativePaths: [],
  usageReporting: false,
}

const sortNames = <Name extends string>(names: readonly Name[]): Name[] => names.toSorted()

const sortDisabledPaths = (
  paths: readonly DisabledGovernedNativePath[]
): DisabledGovernedNativePath[] =>
  paths.toSorted((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))

function nativeInstallationMatches(
  left: NativeInstallationEvidence,
  right: NativeInstallationEvidence
): boolean {
  return (
    left.repository === right.repository &&
    left.tag === right.tag &&
    left.commit === right.commit &&
    left.bundleSha256 === right.bundleSha256
  )
}

/**
 * Fail-closed executor qualification evaluator. Evidence records are parsed
 * once at construction (malformed trusted evidence throws); observations are
 * parsed per evaluation and produce a typed `evidence_invalid` failure rather
 * than a permissive default. Evaluation is pure and deterministic given `now`.
 */
export class ExecutorQualificationEvaluator {
  readonly #records: readonly ExecutorQualificationEvidence[]
  readonly #now: () => string

  constructor(records: unknown[], now: () => string = () => new Date().toISOString()) {
    this.#records = records.map((record) => ExecutorQualificationEvidenceSchema.parse(record))
    this.#now = now
  }

  evaluate(observationInput: unknown): ExecutorQualification {
    const observation = ExecutorObservationSchema.safeParse(observationInput)
    if (!observation.success) {
      return {
        ...unqualified,
        failure: { reason: 'evidence_invalid', detail: 'EXECUTOR_OBSERVATION_INVALID' },
      }
    }
    const observed = observation.data
    // Offline or revoked transport is a fail-closed local denial. The evaluator
    // has no cloud route to offer and never implies one: fallback is always 'none'.
    if (observed.transport === 'offline') {
      return { ...unqualified, failure: { reason: 'transport_offline', fallback: 'none' } }
    }
    if (observed.transport === 'revoked') {
      return { ...unqualified, failure: { reason: 'transport_revoked', fallback: 'none' } }
    }
    const record = this.#records.find((candidate) => candidate.harness === observed.harness)
    if (!record)
      return { ...unqualified, failure: { reason: 'evidence_missing', harness: observed.harness } }
    // Only executor-owned credentials qualify; cloud vaults and delegated
    // sessions never do, whatever the evidence claims.
    if (
      record.authentication !== 'native_owned' ||
      observed.authentication !== record.authentication
    ) {
      return {
        ...unqualified,
        failure: { reason: 'auth_unsupported', authentication: observed.authentication },
      }
    }
    if (
      !record.deploymentAuthorized ||
      record.location === 'agent_hq_cloud' ||
      observed.location === 'agent_hq_cloud'
    ) {
      return {
        ...unqualified,
        failure: { reason: 'location_unauthorized', location: observed.location },
      }
    }
    if (record.revokedAt) {
      return {
        ...unqualified,
        failure: { reason: 'evidence_revoked', revokedAt: record.revokedAt },
      }
    }
    const now = Date.parse(this.#now())
    if (!Number.isFinite(now) || now >= Date.parse(record.validUntil)) {
      return {
        ...unqualified,
        failure: { reason: 'evidence_expired', expiredAt: record.validUntil },
      }
    }
    // Native configuration drift against the qualified evidence fails closed.
    if (observed.harnessVersion !== record.harnessVersion) {
      return {
        ...unqualified,
        failure: {
          reason: 'evidence_mismatch',
          field: 'harnessVersion',
          detail: 'HARNESS_VERSION_CHANGED',
        },
      }
    }
    if (observed.location !== record.location) {
      return {
        ...unqualified,
        failure: {
          reason: 'evidence_mismatch',
          field: 'location',
          detail: 'EXECUTION_LOCATION_CHANGED',
        },
      }
    }
    if (!nativeInstallationMatches(observed.nativeInstallation, record.nativeInstallation)) {
      return {
        ...unqualified,
        failure: {
          reason: 'evidence_mismatch',
          field: 'nativeInstallation',
          detail: 'NATIVE_INSTALLATION_CHANGED',
        },
      }
    }
    if (observed.configurationDigest !== record.configurationDigest) {
      return {
        ...unqualified,
        failure: {
          reason: 'evidence_mismatch',
          field: 'configurationDigest',
          detail: 'CONFIGURATION_DIGEST_CHANGED',
        },
      }
    }
    // The codex route additionally must match the pinned ACP build exactly;
    // fixture or otherwise-fake installation evidence can never qualify it.
    if (
      observed.harness === 'codex' &&
      !nativeInstallationMatches(observed.nativeInstallation, pinnedCodexInstallation)
    ) {
      return {
        ...unqualified,
        failure: {
          reason: 'evidence_mismatch',
          field: 'deploymentPin',
          detail: 'DEPLOYMENT_PIN_CHANGED',
        },
      }
    }
    // Allow-lists derive only from evidence. Governed paths additionally need
    // proven pre-effect policy enforcement; everything else stays disabled.
    const evidencedPaths = new Map(
      record.governedPaths.map((path) => [path.path, path.policyEnforced] as const)
    )
    const governedNativePaths: GovernedNativePath[] = []
    const disabledGovernedNativePaths: DisabledGovernedNativePath[] = []
    for (const path of observed.nativePaths) {
      const policyEnforced = evidencedPaths.get(path)
      if (policyEnforced === undefined) {
        disabledGovernedNativePaths.push({ path, reason: 'not_evidenced' })
      } else if (policyEnforced) {
        governedNativePaths.push(path)
      } else {
        disabledGovernedNativePaths.push({ path, reason: 'controls_missing' })
      }
    }
    return {
      qualified: true,
      failure: null,
      capabilities: sortNames(record.capabilities),
      governedNativePaths: sortNames(governedNativePaths),
      disabledGovernedNativePaths: sortDisabledPaths(disabledGovernedNativePaths),
      usageReporting: record.usageReporting,
    }
  }
}
