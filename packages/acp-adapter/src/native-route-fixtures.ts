import { pinnedAcpBuild } from './pinned-codex-build.js'
import { ExecutorQualificationEvaluator } from './qualification.js'
import { QualifiedNativeRoute } from './native-route-qualification.js'

/**
 * Deterministic deployment evidence for a qualified native route (M13.03,
 * control-plane#1021).
 *
 * A native ACP route may only claim what trusted deployment evidence allows,
 * so every composition that constructs an ACP gateway client now has to say
 * which route it is bound to. These fixtures answer exactly that question for
 * the codex ACP route, which is the one installation identity this package
 * knows: the PINNED ACP build. Every other harness would need its own pinned
 * build identity before it can carry production evidence, and until then it
 * cannot qualify at all.
 *
 * The evidence is deployment configuration, not executor output: it carries no
 * credential, and the route performs no I/O, spawns no harness and contacts no
 * network.
 */

export const FIXTURE_NOW = '2026-10-08T12:00:00.000Z'
export const FIXTURE_VALID_UNTIL = '2026-10-09T12:00:00.000Z'

/**
 * The ACP capability surface a qualified route may claim. It mirrors the
 * capability set the ACP protocol surface exposes, so a qualified route is not
 * silently narrower than the transport it drives.
 */
export const qualifiedAcpCapabilities = Object.freeze([
  'execution.cancel',
  'interaction.approval',
  'session.close',
  'session.create',
  'session.history',
  'session.list',
  'session.load',
  'session.resume',
  'stream.events',
  'stream.output',
  'tool.call',
])

const pinnedInstallation = {
  repository: pinnedAcpBuild.repository,
  tag: pinnedAcpBuild.tag,
  commit: pinnedAcpBuild.commit,
  bundleSha256: pinnedAcpBuild.bundleSha256,
}

/** The deployment evidence a qualified codex ACP route is bound to. */
export function qualifiedRouteEvidence(overrides: Record<string, unknown> = {}) {
  return {
    harness: 'codex',
    harnessVersion: pinnedAcpBuild.codexVersion,
    location: 'local_device',
    authentication: 'native_owned',
    deploymentAuthorized: true,
    nativeInstallation: pinnedInstallation,
    configurationDigest: 'c'.repeat(64),
    capabilities: [...qualifiedAcpCapabilities],
    usageReporting: true,
    governedPaths: [
      { path: 'shell', policyEnforced: true },
      { path: 'mcp', policyEnforced: true },
    ],
    validUntil: FIXTURE_VALID_UNTIL,
    ...overrides,
  }
}

/** The live observation of that route, as the executor would detect it. */
export function qualifiedRouteObservation(overrides: Record<string, unknown> = {}) {
  const record = qualifiedRouteEvidence()
  return {
    harness: record.harness,
    harnessVersion: record.harnessVersion,
    location: record.location,
    authentication: record.authentication,
    nativeInstallation: record.nativeInstallation,
    configurationDigest: record.configurationDigest,
    transport: 'online',
    nativePaths: ['shell', 'mcp'],
    ...overrides,
  }
}

/**
 * A qualified native route over the fixture evidence, with a deterministic
 * clock. `overrides` replace the evidence or the observation, so a suite can
 * model an expired, revoked, unauthorized or drifted route without a real
 * deployment.
 */
export function qualifiedNativeRouteFixture({
  evidence = {},
  observation = {},
  now = FIXTURE_NOW,
}: {
  readonly evidence?: Record<string, unknown>
  readonly observation?: Record<string, unknown>
  readonly now?: string
} = {}): QualifiedNativeRoute {
  return new QualifiedNativeRoute({
    evaluator: new ExecutorQualificationEvaluator([qualifiedRouteEvidence(evidence)], () => now),
    observation: () => qualifiedRouteObservation(observation),
  })
}
