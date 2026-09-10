import type { GatewayProtocolVersion } from '@control-plane/runtime-gateway-protocol'
import type { RuntimeChannelOwnershipRepository } from '@control-plane/runtime-sdk'

/** Repository ownership is authoritative; lifecycle sweeps reconcile without push delivery. */
export class RepositoryRuntimeNodeCoordination implements RuntimeNodeCoordinationPort {
  constructor(readonly repository: RuntimeChannelOwnershipRepository) {}

  claim(record: ActiveRuntimeNodeChannelRecord): Promise<RuntimeNodeChannelClaimResult> {
    return this.repository.claim(record)
  }

  heartbeat(record: ActiveRuntimeNodeChannelRecord): Promise<boolean> {
    return this.repository.heartbeat(record)
  }

  lookup(nodeId: string): Promise<ActiveRuntimeNodeChannelRecord | undefined> {
    return this.repository.lookup(nodeId)
  }

  release(record: ActiveRuntimeNodeChannelRecord): Promise<boolean> {
    return this.repository.release(record)
  }

  subscribeReplacements(): () => void {
    // No notification dependency: incoming frames, sends and sweeps consult the repository.
    return () => undefined
  }
}

export interface ActiveRuntimeNodeChannelRecord {
  readonly nodeId: string
  readonly workspaceId: string
  readonly gatewayInstanceId: string
  readonly connectionId: string
  readonly channelGeneration: number
  readonly protocolVersion: GatewayProtocolVersion
  readonly connectedAt: string
  readonly lastHeartbeatAt: string
}

export interface RuntimeNodeChannelClaimResult {
  readonly accepted: boolean
  readonly previous?: ActiveRuntimeNodeChannelRecord
}

export interface RuntimeNodeCoordinationPort {
  claim(record: ActiveRuntimeNodeChannelRecord): Promise<RuntimeNodeChannelClaimResult>
  heartbeat(record: ActiveRuntimeNodeChannelRecord): Promise<boolean>
  lookup(nodeId: string): Promise<ActiveRuntimeNodeChannelRecord | undefined>
  release(record: ActiveRuntimeNodeChannelRecord): Promise<boolean>
  subscribeReplacements(
    gatewayInstanceId: string,
    listener: (record: ActiveRuntimeNodeChannelRecord) => void | Promise<void>
  ): () => void
}

export class InMemoryRuntimeNodeCoordination implements RuntimeNodeCoordinationPort {
  readonly #active = new Map<string, ActiveRuntimeNodeChannelRecord>()
  readonly #replacementListeners = new Map<
    string,
    Set<(record: ActiveRuntimeNodeChannelRecord) => void | Promise<void>>
  >()

  async claim(record: ActiveRuntimeNodeChannelRecord): Promise<RuntimeNodeChannelClaimResult> {
    const current = this.#active.get(record.nodeId)
    if (current !== undefined && record.channelGeneration <= current.channelGeneration) {
      return { accepted: false, previous: structuredClone(current) }
    }
    this.#active.set(record.nodeId, structuredClone(record))
    if (current !== undefined) {
      const listeners = this.#replacementListeners.get(current.gatewayInstanceId) ?? []
      await Promise.all([...listeners].map((listener) => listener(structuredClone(current))))
    }
    return {
      accepted: true,
      ...(current === undefined ? {} : { previous: structuredClone(current) }),
    }
  }

  async heartbeat(record: ActiveRuntimeNodeChannelRecord): Promise<boolean> {
    const current = this.#active.get(record.nodeId)
    if (!sameChannel(current, record)) return false
    this.#active.set(record.nodeId, structuredClone(record))
    return true
  }

  async lookup(nodeId: string): Promise<ActiveRuntimeNodeChannelRecord | undefined> {
    const record = this.#active.get(nodeId)
    return record === undefined ? undefined : structuredClone(record)
  }

  async release(record: ActiveRuntimeNodeChannelRecord): Promise<boolean> {
    const current = this.#active.get(record.nodeId)
    if (!sameChannel(current, record)) return false
    this.#active.delete(record.nodeId)
    return true
  }

  subscribeReplacements(
    gatewayInstanceId: string,
    listener: (record: ActiveRuntimeNodeChannelRecord) => void | Promise<void>
  ): () => void {
    const listeners = this.#replacementListeners.get(gatewayInstanceId) ?? new Set()
    listeners.add(listener)
    this.#replacementListeners.set(gatewayInstanceId, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.#replacementListeners.delete(gatewayInstanceId)
    }
  }
}

function sameChannel(
  current: ActiveRuntimeNodeChannelRecord | undefined,
  candidate: ActiveRuntimeNodeChannelRecord
): boolean {
  return (
    current?.gatewayInstanceId === candidate.gatewayInstanceId &&
    current.connectionId === candidate.connectionId &&
    current.channelGeneration === candidate.channelGeneration
  )
}

export type RuntimeNodeReachabilityState = 'online' | 'degraded' | 'offline'

export interface RuntimeNodeReachabilityChange {
  readonly nodeId: string
  readonly workspaceId: string
  readonly channelGeneration: number
  readonly state: RuntimeNodeReachabilityState
  readonly reason: string
  readonly observedAt: string
}

export interface RuntimeNodeReachabilityPublisher {
  publish(change: RuntimeNodeReachabilityChange): Promise<void>
}

export class RecordingRuntimeNodeReachabilityPublisher implements RuntimeNodeReachabilityPublisher {
  readonly events: RuntimeNodeReachabilityChange[] = []

  async publish(change: RuntimeNodeReachabilityChange): Promise<void> {
    this.events.push(structuredClone(change))
  }
}

export interface GatewayMetrics {
  setGauge(name: string, value: number, labels?: Readonly<Record<string, string>>): void
  increment(name: string, labels?: Readonly<Record<string, string>>): void
  observe(name: string, value: number, labels?: Readonly<Record<string, string>>): void
}

interface MetricSample {
  readonly name: string
  readonly kind: 'counter' | 'gauge' | 'observation'
  readonly value: number
  readonly labels: Readonly<Record<string, string>>
}

export class RecordingGatewayMetrics implements GatewayMetrics {
  readonly samples: MetricSample[] = []
  readonly #counters = new Map<string, number>()
  readonly #gauges = new Map<string, number>()

  setGauge(name: string, value: number, labels: Readonly<Record<string, string>> = {}): void {
    this.#gauges.set(metricKey(name, labels), value)
    this.samples.push({ name, kind: 'gauge', value, labels: { ...labels } })
  }

  increment(name: string, labels: Readonly<Record<string, string>> = {}): void {
    const key = metricKey(name, labels)
    const value = (this.#counters.get(key) ?? 0) + 1
    this.#counters.set(key, value)
    this.samples.push({ name, kind: 'counter', value: 1, labels: { ...labels } })
  }

  observe(name: string, value: number, labels: Readonly<Record<string, string>> = {}): void {
    this.samples.push({ name, kind: 'observation', value, labels: { ...labels } })
  }

  counterValue(name: string, labels: Readonly<Record<string, string>> = {}): number {
    return this.#counters.get(metricKey(name, labels)) ?? 0
  }

  gaugeValue(name: string, labels: Readonly<Record<string, string>> = {}): number {
    return this.#gauges.get(metricKey(name, labels)) ?? 0
  }

  observations(name: string, labels: Readonly<Record<string, string>> = {}): number[] {
    const key = metricKey(name, labels)
    return this.samples
      .filter(
        (sample) => sample.kind === 'observation' && metricKey(sample.name, sample.labels) === key
      )
      .map(({ value }) => value)
  }
}

function metricKey(name: string, labels: Readonly<Record<string, string>>): string {
  const suffix = Object.entries(labels)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(',')
  return `${name}{${suffix}}`
}
