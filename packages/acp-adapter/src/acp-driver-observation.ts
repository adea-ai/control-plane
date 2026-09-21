import { computeBackoffDelayMs } from '@control-plane/domain'
import {
  RuntimeConnectionSchema,
  assessExternalSession,
  projectExternalSessionDiscovery,
  type ExternalSession,
} from '@control-plane/runtime-sdk'
import {
  MaximumObservationRepairAttempts,
  MaximumObservationRepairs,
  MaximumPendingPublications,
} from './acp-schemas.js'
import { safeNativeDisplayName } from './acp-helpers.js'
import { fail } from './acp-utils.js'
import type { AcpDriverState } from './acp-driver-state.js'
import { deadline, externalSessionCall } from './acp-driver-transport.js'

export function normalizedSession(
  state: AcpDriverState,
  nativeSessionId: string,
  sessionState: 'active' | 'closed'
) {
  const sessionId = state.externalSessionId(nativeSessionId)
  state.nativeByExternalSession.set(sessionId, nativeSessionId)
  return { sessionId, state: sessionState, observedAt: state.now().toISOString() }
}

export async function observeNativeSession(
  state: AcpDriverState,
  nativeSessionId: string,
  origin: 'native_discovery' | 'created_through_control_plane',
  displayName?: string,
  sessionState: 'active' | 'closed' = 'active',
  generation?: string
) {
  if (!state.externalSessions) return normalizedSession(state, nativeSessionId, sessionState)
  return externalSessionCall(state, () =>
    observeNativeSessionUnbounded(
      state,
      nativeSessionId,
      origin,
      displayName,
      sessionState,
      generation
    )
  )
}

async function observeNativeSessionUnbounded(
  state: AcpDriverState,
  nativeSessionId: string,
  origin: 'native_discovery' | 'created_through_control_plane',
  displayName?: string,
  sessionState: 'active' | 'closed' = 'active',
  generation?: string
) {
  const normalized = normalizedSession(state, nativeSessionId, sessionState)
  if (!state.externalSessions) return normalized
  const connection = RuntimeConnectionSchema.parse(state.externalSessions.runtimeConnection())
  const observedAt = state.now().toISOString()
  const capabilitySnapshot = {
    version: connection.capabilitySnapshotVersion ?? 1,
    observedAt: connection.capabilitySnapshotObservedAt ?? observedAt,
    expiresAt:
      connection.capabilitySnapshotExpiresAt ??
      new Date(state.now().getTime() + state.externalSessions.capabilityTtlMs).toISOString(),
    operations: connection.capabilities
      .filter(({ name, support }) => name.startsWith('session.') && support !== 'unsupported')
      .map(({ name }) => name),
  }
  const existing = await state.externalSessions.registry.repository.findByNativeIdentity(
    connection.runtimeConnectionId,
    state.externalSessions.opaqueNativeSessionId(nativeSessionId)
  )
  if (
    generation !== undefined &&
    state.nativeSessionGenerations.get(nativeSessionId) !== generation
  ) {
    return normalized
  }
  const safeDisplayName = safeNativeDisplayName(displayName)
  if (!existing) {
    const session = await state.externalSessions.registry.register({
      externalSessionId: normalized.sessionId,
      runtimeConnectionId: connection.runtimeConnectionId,
      opaqueNativeSessionId: state.externalSessions.opaqueNativeSessionId(nativeSessionId),
      workspaceId: state.externalSessions.workspaceId,
      ...(state.externalSessions.projectId === undefined
        ? {}
        : { projectId: state.externalSessions.projectId }),
      state: sessionState,
      ownership: {
        authority: 'external_runtime',
        imported: false,
        concurrentNativeUse: 'allowed',
      },
      capabilitySnapshot,
      safeMetadata: {
        origin,
        ...(safeDisplayName === undefined ? {} : { displayName: safeDisplayName }),
        limitations: [],
      },
      lastObservedAt: observedAt,
    })
    if (
      generation === undefined ||
      state.nativeSessionGenerations.get(nativeSessionId) === generation
    ) {
      await publishSessionDiscovery(state, session)
    }
    return normalized
  }
  const session = await state.externalSessions.registry.update({
    externalSessionId: existing.externalSessionId,
    expectedVersion: existing.version,
    observedAt,
    state: sessionState,
    capabilitySnapshot,
    safeMetadata: {
      ...existing.safeMetadata,
      ...(safeDisplayName === undefined ? {} : { displayName: safeDisplayName }),
    },
  })
  if (
    generation === undefined ||
    state.nativeSessionGenerations.get(nativeSessionId) === generation
  ) {
    await publishSessionDiscovery(state, session)
  }
  return normalized
}

export async function rollbackObservedSession(
  state: AcpDriverState,
  nativeSessionId: string,
  closed: boolean,
  publishCorrection = false,
  generation?: string
): Promise<boolean> {
  try {
    if (
      generation !== undefined &&
      state.nativeSessionGenerations.get(nativeSessionId) !== generation
    ) {
      return true
    }
    const externalSessionId = state.externalSessionId(nativeSessionId)
    if (state.nativeByExternalSession.get(externalSessionId) === nativeSessionId) {
      state.nativeByExternalSession.delete(externalSessionId)
    }
    const externalSessions = state.externalSessions
    if (!closed || !externalSessions) return true
    const timeoutMs = publishCorrection
      ? Math.min(30_000, Math.max(1_000, state.requestTimeoutMs * 4))
      : state.requestTimeoutMs
    return await deadline(
      state,
      () =>
        externalSessionCall(state, async () => {
          const connection = RuntimeConnectionSchema.parse(externalSessions.runtimeConnection())
          const session = await externalSessions.registry.repository.findByNativeIdentity(
            connection.runtimeConnectionId,
            externalSessions.opaqueNativeSessionId(nativeSessionId)
          )
          if (
            generation !== undefined &&
            state.nativeSessionGenerations.get(nativeSessionId) !== generation
          ) {
            return true
          }
          if (!session) return false
          const corrected =
            session.state === 'active'
              ? await externalSessions.registry.update({
                  externalSessionId: session.externalSessionId,
                  expectedVersion: session.version,
                  observedAt: state.now().toISOString(),
                  state: 'closed',
                })
              : session
          if (publishCorrection && corrected.state === 'closed') {
            await publishSessionDiscovery(state, corrected)
          }
          return true
        }),
      timeoutMs
    )
  } catch {
    // Native cleanup remains authoritative; stale projection repair can be retried by discovery.
    return false
  }
}

export function scheduleObservationCompensation(
  state: AcpDriverState,
  nativeSessionId: string,
  closed: boolean,
  generation?: string
): void {
  if (!closed || !state.externalSessions) return
  const existing = state.observationRepairs.get(nativeSessionId)
  if (existing?.timer) clearTimeout(existing.timer)
  if (!existing && state.observationRepairs.size >= MaximumObservationRepairs) return
  const repair: {
    generation: string | undefined
    attempt: number
    timer: ReturnType<typeof setTimeout> | undefined
  } = { generation, attempt: 0, timer: undefined }
  state.observationRepairs.set(nativeSessionId, repair)

  const schedule = (): void => {
    if (state.observationRepairs.get(nativeSessionId) !== repair) return
    const delayMs = computeBackoffDelayMs({
      baseDelayMs: state.requestTimeoutMs,
      attempt: repair.attempt,
      minDelayMs: 20,
      maxDelayMs: 30_000,
      maxExponent: 10,
    })
    const timer = setTimeout(() => {
      void (async () => {
        if (state.observationRepairs.get(nativeSessionId) !== repair) return
        const repaired = await rollbackObservedSession(
          state,
          nativeSessionId,
          true,
          true,
          generation
        )
        if (state.observationRepairs.get(nativeSessionId) !== repair) return
        if (repaired) {
          state.observationRepairs.delete(nativeSessionId)
          return
        }
        repair.attempt += 1
        if (repair.attempt >= MaximumObservationRepairAttempts) {
          state.observationRepairs.delete(nativeSessionId)
          return
        }
        schedule()
      })()
    }, delayMs)
    repair.timer = timer
    timer.unref?.()
  }
  schedule()
}

export async function markUnlistedSessionsRemoved(
  state: AcpDriverState,
  observed: ReadonlySet<string>
): Promise<void> {
  const externalSessions = state.externalSessions
  if (!externalSessions) return
  const connection = RuntimeConnectionSchema.parse(externalSessions.runtimeConnection())
  const sessions = await externalSessionCall(state, () =>
    externalSessions.registry.list({
      workspaceId: externalSessions.workspaceId,
      ...(externalSessions.projectId === undefined
        ? {}
        : { projectId: externalSessions.projectId }),
      runtimeConnectionId: connection.runtimeConnectionId,
    })
  )
  for (const session of sessions) {
    if (session.state !== 'active' || observed.has(session.externalSessionId)) continue
    const updated = await externalSessionCall(state, () =>
      externalSessions.registry.update({
        externalSessionId: session.externalSessionId,
        expectedVersion: session.version,
        observedAt: state.now().toISOString(),
        state: 'removed',
      })
    )
    await publishSessionDiscovery(state, updated)
  }
}

export async function publishSessionDiscovery(
  state: AcpDriverState,
  session: ExternalSession
): Promise<void> {
  if (!state.externalSessions?.publishDiscovery) return
  const existing = state.pendingPublications.get(session.externalSessionId)
  if (existing) {
    if (session.version > existing.latestVersion) {
      existing.latestVersion = session.version
      existing.pending = session
    }
    return
  }
  if (state.pendingPublications.size >= MaximumPendingPublications) {
    fail('ACP_DISCOVERY_BACKPRESSURE', 'unavailable', true)
  }
  const publication: {
    latestVersion: number
    pending: ExternalSession | undefined
    promise: Promise<void>
  } = {
    latestVersion: session.version,
    pending: session,
    promise: Promise.resolve(),
  }
  const drain = Promise.resolve().then(async () => {
    while (publication.pending) {
      const next = publication.pending
      publication.pending = undefined
      const externalSessions = state.externalSessions
      if (!externalSessions?.publishDiscovery) return
      const connection = RuntimeConnectionSchema.parse(externalSessions.runtimeConnection())
      const evaluatedAt = state.now().toISOString()
      await externalSessions.publishDiscovery({
        scope: {
          workspaceId: externalSessions.workspaceId,
          ...(externalSessions.projectId === undefined
            ? {}
            : { projectId: externalSessions.projectId }),
          ...(connection.runtimeNodeRefId === undefined
            ? {}
            : { runtimeNodeRefId: connection.runtimeNodeRefId }),
        },
        model: projectExternalSessionDiscovery({
          session: next,
          assessment: assessExternalSession(next, {
            connection,
            nodeStatus: externalSessions.nodeStatus(),
            evaluatedAt,
          }),
        }),
      })
    }
  })
  publication.promise = drain.finally(() => {
    if (state.pendingPublications.get(session.externalSessionId) === publication) {
      state.pendingPublications.delete(session.externalSessionId)
    }
  })
  state.pendingPublications.set(session.externalSessionId, publication)
  await publication.promise
}
