import { createHash } from 'node:crypto'
import { RuntimeConnectionSchema } from '@control-plane/runtime-sdk'
import { z } from 'zod'
import {
  HostedRuntimeHostInspectionSchema,
  type HostedRuntimeHostInspection,
  type RuntimeHostProvider,
} from './hosted-managed-pi-schemas.js'

export interface HostedManagedPiWorkerOptions {
  readonly host: RuntimeHostProvider
  readonly targetUtilizationPermille?: number
}

export class HostedManagedPiWorker {
  readonly #host: RuntimeHostProvider
  readonly #targetUtilizationPermille: number

  constructor(options: HostedManagedPiWorkerOptions) {
    this.#host = options.host
    this.#targetUtilizationPermille = z
      .number()
      .int()
      .min(100)
      .max(1_000)
      .parse(options.targetUtilizationPermille ?? 700)
  }

  async readiness(): Promise<{
    readonly ready: boolean
    readonly reason: 'READY' | 'HOST_DEGRADED' | 'HOST_UNAVAILABLE' | 'CAPACITY_UNAVAILABLE'
  }> {
    const host = HostedRuntimeHostInspectionSchema.parse(await this.#host.inspect())
    if (host.health === 'unavailable') return { ready: false, reason: 'HOST_UNAVAILABLE' }
    if (host.capacity.maximumConcurrent === 0) {
      return { ready: false, reason: 'CAPACITY_UNAVAILABLE' }
    }
    if (host.health === 'degraded') return { ready: true, reason: 'HOST_DEGRADED' }
    return { ready: true, reason: 'READY' }
  }

  async scaling(): Promise<{
    readonly currentCapacity: number
    readonly desiredCapacity: number
    readonly active: number
    readonly queued: number
  }> {
    const host = HostedRuntimeHostInspectionSchema.parse(await this.#host.inspect())
    const demand = host.capacity.active + host.capacity.queued
    const demandedCapacity = Math.ceil((demand * 1_000) / this.#targetUtilizationPermille)
    return {
      currentCapacity: host.capacity.maximumConcurrent,
      desiredCapacity: Math.max(host.capacity.maximumConcurrent, demandedCapacity),
      active: host.capacity.active,
      queued: host.capacity.queued,
    }
  }

  close(): Promise<void> {
    return this.#host.close()
  }
}

export function buildHostedManagedPiRuntimeConnection(input: {
  readonly runtimeConnectionId: string
  readonly runtimeDefinitionId: string
  readonly observedAt: string
  readonly host: HostedRuntimeHostInspection
}) {
  const host = HostedRuntimeHostInspectionSchema.parse(input.host)
  const unavailable = host.health === 'unavailable'
  const degraded = host.health === 'degraded'
  const expiresAt = new Date(Date.parse(input.observedAt) + 60_000).toISOString()
  const identityDigest = `sha256:${createHash('sha256')
    .update(`${input.runtimeDefinitionId}:managed-sandbox:${host.providerFamily}`)
    .digest('hex')}`
  return RuntimeConnectionSchema.parse({
    runtimeConnectionId: input.runtimeConnectionId,
    identityDigest,
    connectionType: 'managed_cloud',
    runtimeDefinitionId: input.runtimeDefinitionId,
    location: 'agent_hq_cloud',
    adapterVersion: '1.0.0',
    driverVersion: host.driverVersion,
    harnessVersion: host.harnessVersion,
    status: unavailable ? 'unavailable' : degraded ? 'degraded' : 'connected',
    health: host.health,
    capabilities: host.capabilities,
    compatibilityState: unavailable ? 'unavailable' : degraded ? 'degraded' : 'compatible',
    availabilityState: unavailable ? 'offline' : degraded ? 'degraded' : 'healthy',
    protocolVersion: '1.0.0',
    capabilitySnapshotVersion: 1,
    capabilitySnapshotObservedAt: input.observedAt,
    capabilitySnapshotExpiresAt: expiresAt,
    capabilityVerification: 'verified',
    lastHealthReportSequence: 1,
    lastHealthReportDigest: identityDigest,
    limitations: host.limitations,
    diagnostics: unavailable ? ['HOST_UNAVAILABLE'] : [],
    lastDiscoveredAt: input.observedAt,
    lastHeartbeatAt: input.observedAt,
    lastHealthCheckAt: input.observedAt,
    expiresAt,
    version: 1,
    createdAt: input.observedAt,
    updatedAt: input.observedAt,
  })
}
