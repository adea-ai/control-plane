import {
  RuntimeInventoryCheckpointSchema,
  RuntimeInventoryScanSchema,
  RuntimeConnectionScanSchema,
  RuntimeConnectionSchema,
  RuntimeTimestampSchema,
  type RuntimeInventoryCheckpoint,
  type RuntimeInventoryCheckpointScanner,
  type RuntimeConnectionScanner,
  type RuntimeConnectionRegistry,
  type RuntimeHealthIngestionService,
  type projectRuntimeConnectionDiscovery,
} from '@control-plane/runtime-sdk'
import type { RuntimeNodeCoordinationPort } from './websocket-coordination.js'
import { isDeepStrictEqual } from 'node:util'

type Projection = ReturnType<typeof projectRuntimeConnectionDiscovery>
interface ProjectionScope {
  readonly workspaceId: string
  readonly runtimeNodeRefId: string
}
export interface RuntimeInventoryMaintenanceOptions {
  readonly checkpoints: RuntimeInventoryCheckpointScanner
  readonly connections: RuntimeConnectionScanner
  readonly registry: RuntimeConnectionRegistry
  readonly health: Pick<RuntimeHealthIngestionService, 'refresh'>
  readonly ownership: Pick<RuntimeNodeCoordinationPort, 'lookup'>
  readonly projections: {
    getRuntimeConnection(scope: ProjectionScope, id: string): Promise<Projection | undefined>
    compareAndSetRuntimeConnection(
      scope: ProjectionScope,
      expected: Projection,
      next: Projection
    ): Promise<boolean>
  }
  readonly pageSize?: number
  readonly now?: () => Date
}
export interface RuntimeInventoryMaintenanceResult {
  readonly visited: number
  readonly updated: number
  readonly conflicts: number
  readonly failed: readonly string[]
  readonly cycleComplete: boolean
}

/** Internal bounded maintenance pass. Restart begins a fresh cycle; no public discovery authority. */
export class RuntimeInventoryMaintenance {
  readonly #options: RuntimeInventoryMaintenanceOptions
  readonly #pageSize: number
  #nodeCursor: string | undefined
  #node: RuntimeInventoryCheckpoint | undefined
  #connectionCursor: string | undefined
  #running: Promise<RuntimeInventoryMaintenanceResult> | undefined

  constructor(options: RuntimeInventoryMaintenanceOptions) {
    this.#options = options
    this.#pageSize = options.pageSize ?? 32
    if (!Number.isSafeInteger(this.#pageSize) || this.#pageSize < 1 || this.#pageSize > 128)
      throw new Error('INVALID_INVENTORY_MAINTENANCE_PAGE_SIZE')
  }

  runPage(): Promise<RuntimeInventoryMaintenanceResult> {
    this.#running ??= this.#run().finally(() => {
      this.#running = undefined
    })
    return this.#running
  }

  async #run(): Promise<RuntimeInventoryMaintenanceResult> {
    const options = this.#options
    const evaluatedAt = RuntimeTimestampSchema.parse((options.now?.() ?? new Date()).toISOString())
    if (this.#node === undefined) {
      const page = await options.checkpoints.scan(
        RuntimeInventoryScanSchema.parse({
          limit: 1,
          ...(this.#nodeCursor ? { afterNodeId: this.#nodeCursor } : {}),
        })
      )
      if (page.length > 1) throw new Error('INVENTORY_MAINTENANCE_SCAN_INVALID')
      if (page.length === 0) {
        this.#nodeCursor = undefined
        return { visited: 0, updated: 0, conflicts: 0, failed: [], cycleComplete: true }
      }
      const node = RuntimeInventoryCheckpointSchema.parse(page[0])
      if (this.#nodeCursor && node.runtimeNodeRefId <= this.#nodeCursor)
        throw new Error('INVENTORY_MAINTENANCE_SCAN_INVALID')
      this.#node = node
    }
    const node = this.#node
    const query = RuntimeConnectionScanSchema.parse({
      runtimeNodeRefId: node.runtimeNodeRefId,
      limit: this.#pageSize,
      ...(this.#connectionCursor ? { afterConnectionId: this.#connectionCursor } : {}),
    })
    const page = await options.connections.scanByRuntimeNode(query)
    if (page.length > this.#pageSize) throw new Error('INVENTORY_MAINTENANCE_SCAN_INVALID')
    let last = this.#connectionCursor
    for (const value of page) {
      const row = RuntimeConnectionSchema.parse(value)
      if (
        row.runtimeNodeRefId !== node.runtimeNodeRefId ||
        (last && row.runtimeConnectionId <= last)
      )
        throw new Error('INVENTORY_MAINTENANCE_SCAN_INVALID')
      last = row.runtimeConnectionId
    }
    let updated = 0
    let conflicts = 0
    const failed: string[] = []
    for (const row of page) {
      try {
        const outcome = await this.#refresh(node, row.runtimeConnectionId, evaluatedAt)
        if (outcome === 'updated') updated++
        if (outcome === 'conflict') conflicts++
      } catch {
        failed.push(row.runtimeConnectionId)
      }
    }
    if (page.length < this.#pageSize) {
      this.#nodeCursor = node.runtimeNodeRefId
      this.#node = undefined
      this.#connectionCursor = undefined
    } else this.#connectionCursor = last
    return { visited: page.length, updated, conflicts, failed, cycleComplete: false }
  }

  async #refresh(
    node: RuntimeInventoryCheckpoint,
    id: string,
    evaluatedAt: string
  ): Promise<'updated' | 'conflict' | 'skipped'> {
    const options = this.#options
    const scope = { workspaceId: node.workspaceId, runtimeNodeRefId: node.runtimeNodeRefId }
    const previous = await options.projections.getRuntimeConnection(scope, id)
    if (!previous || previous.node?.runtimeNodeRefId !== node.runtimeNodeRefId)
      throw new Error('INVENTORY_MAINTENANCE_PROJECTION_MISSING')
    let current = await options.registry.get(id)
    if (!current || current.runtimeNodeRefId !== node.runtimeNodeRefId)
      throw new Error('INVENTORY_MAINTENANCE_SCOPE_MISMATCH')
    const owner = await options.ownership.lookup(node.runtimeNodeRefId)
    if (owner && (owner.workspaceId !== node.workspaceId || owner.nodeId !== node.runtimeNodeRefId))
      throw new Error('INVENTORY_MAINTENANCE_SCOPE_MISMATCH')
    const online =
      owner !== undefined && Date.parse(owner.lastHeartbeatAt) + 45_000 > Date.parse(evaluatedAt)
    const disappeared = current.diagnostics?.includes('RUNTIME_DISAPPEARED') === true
    if (
      disappeared &&
      current.status === 'unavailable' &&
      current.expiresAt &&
      Date.parse(current.expiresAt) <= Date.parse(evaluatedAt)
    ) {
      current = await options.registry.expire({
        runtimeConnectionId: id,
        expectedVersion: current.version,
        observedAt: evaluatedAt,
      })
    } else if (!disappeared && current.status !== 'revoked' && current.status !== 'expired') {
      current = (
        await options.health.refresh({
          runtimeConnectionId: id,
          nodeStatus: online ? 'online' : 'offline',
          evaluatedAt,
        })
      ).connection
    }
    if (
      current.status !== 'revoked' &&
      current.status !== 'expired' &&
      current.availabilityState !== 'stale' &&
      !disappeared
    )
      return 'skipped'
    const revoked = current.status === 'revoked' || previous.status === 'revoked'
    const previousNode = previous.node
    const offlineNode =
      !online &&
      previousNode &&
      previousNode.status !== 'revoked' &&
      (previousNode.status !== 'offline' || previousNode.health !== 'offline')
        ? {
            ...previousNode,
            status: 'offline' as const,
            health: 'offline' as const,
            observedAt: evaluatedAt,
          }
        : previousNode
    const next: Projection = {
      ...previous,
      ...(offlineNode ? { node: offlineNode } : {}),
      status: revoked ? 'revoked' : 'unavailable',
      connection: {
        status: revoked ? 'revoked' : current.status,
        health: revoked ? 'unavailable' : current.health,
        availability: revoked ? 'revoked' : (current.availabilityState ?? 'unknown'),
      },
      freshness: {
        ...previous.freshness,
        state: current.status === 'expired' ? 'expired' : 'stale',
      },
      eligibility: {
        ...previous.eligibility,
        state: 'ineligible',
        reasons: [
          ...new Set([
            ...previous.eligibility.reasons,
            ...(current.diagnostics ?? []),
            revoked ? 'RUNTIME_REVOKED' : 'RUNTIME_UNAVAILABLE',
          ]),
        ].slice(0, 128),
      },
      observedAt: previous.observedAt,
    }
    if (isDeepStrictEqual(next, previous)) return 'skipped'
    next.observedAt = evaluatedAt
    return (await options.projections.compareAndSetRuntimeConnection(scope, previous, next))
      ? 'updated'
      : 'conflict'
  }
}
