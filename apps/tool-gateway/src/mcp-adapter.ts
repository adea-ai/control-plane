import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { managedCloudOperationalPolicy } from '@control-plane/config'
import {
  ToolExecutorError,
  type ToolExecutionRequest,
  type ToolExecutor,
  type ToolVersion,
  type ToolVersionDraft,
} from '@control-plane/tool-sdk'
import { ToolGateway, ToolRegistry } from './tool-registry.js'

export interface McpServerRegistration {
  readonly serverId: string
  /** Server-side vault or lease reference. Never copied into canonical tool records. */
  readonly credentialRef: string
}

export interface McpDiscoveredTool {
  readonly name: string
  readonly description: string
  readonly version?: string
  readonly inputSchema: ToolVersionDraft['inputSchema']
  readonly outputSchema: ToolVersionDraft['outputSchema']
  readonly capabilities?: readonly string[]
  readonly readOnly?: boolean
}

export interface McpClientPort {
  /** The client must reject a raw response above maxResponseBytes before parsing it. */
  readonly enforcesRawDiscoveryLimit: true
  discover(
    registration: McpServerRegistration,
    limits: { readonly maxResponseBytes: number }
  ): Promise<readonly McpDiscoveredTool[]>
  invoke(
    request: {
      readonly serverId: string
      readonly toolName: string
      readonly input: unknown
      readonly credentialRef: string
    },
    signal: AbortSignal
  ): Promise<unknown>
}

export class McpAdapterError extends Error {
  constructor(
    readonly code: 'MCP_DISCOVERY_FAILED' | 'MCP_INVALID_REGISTRATION' | 'MCP_UNBOUNDED_CLIENT'
  ) {
    super(code)
    this.name = 'McpAdapterError'
  }
}

interface Binding {
  readonly toolDefinitionId: string
  latest: ToolVersion | undefined
  revision: number
  availability: 'available' | 'removed' | 'disconnected'
}

const mcpDiscoveryLimits = {
  maxTools: 256,
  maxAggregateBytes: managedCloudOperationalPolicy.payload.gatewayFrameBytes,
  maxSchemaBytes: managedCloudOperationalPolicy.payload.remoteMetadataBytes,
  maxSchemaDepth: 32,
  maxNameBytes: 256,
  maxDescriptionBytes: 2_048,
  maxVersionBytes: 128,
  maxCapabilities: 64,
  maxCapabilityBytes: 256,
} as const

export class McpAdapter implements ToolExecutor {
  readonly #registration: McpServerRegistration
  readonly #workspaceId: string
  readonly #client: McpClientPort
  readonly #registry: ToolRegistry
  readonly #ids: { definition(): string; version(): string }
  readonly #now: () => string
  readonly #limits: {
    readonly maxInputBytes: number
    readonly maxOutputBytes: number
    readonly timeoutMs: number
  }
  readonly #bindings = new Map<string, Binding>()

  constructor(options: {
    readonly registration: McpServerRegistration
    readonly workspaceId: string
    readonly client: McpClientPort
    readonly registry: ToolRegistry
    readonly gateway: ToolGateway
    readonly ids: { definition(): string; version(): string }
    readonly limits?: {
      readonly maxInputBytes: number
      readonly maxOutputBytes: number
      readonly timeoutMs: number
    }
    readonly now?: () => string
  }) {
    if (
      !/^[a-z][a-z0-9.-]{0,127}$/.test(options.registration.serverId) ||
      !/^(?:vault|lease):\/\/\S{1,500}$/.test(options.registration.credentialRef)
    ) {
      throw new McpAdapterError('MCP_INVALID_REGISTRATION')
    }
    if (options.client.enforcesRawDiscoveryLimit !== true) {
      throw new McpAdapterError('MCP_UNBOUNDED_CLIENT')
    }
    this.#registration = { ...options.registration }
    this.#workspaceId = options.workspaceId
    this.#client = options.client
    this.#registry = options.registry
    this.#ids = options.ids
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#limits = options.limits ?? {
      maxInputBytes: managedCloudOperationalPolicy.payload.encryptedContentBytes,
      maxOutputBytes: managedCloudOperationalPolicy.payload.encryptedContentBytes,
      timeoutMs: managedCloudOperationalPolicy.payload.publicRequestDeadlineMs,
    }
    options.gateway.registerExecutor('mcp', this.#executorReference, this)
  }

  get #executorReference(): string {
    return `mcp/${this.#registration.serverId}`
  }

  async refresh(): Promise<readonly ToolVersion[]> {
    let discovered: readonly McpDiscoveredTool[]
    try {
      discovered = await this.#client.discover(this.#registration, {
        maxResponseBytes: mcpDiscoveryLimits.maxAggregateBytes,
      })
    } catch {
      for (const binding of this.#bindings.values()) binding.availability = 'disconnected'
      throw new McpAdapterError('MCP_DISCOVERY_FAILED')
    }

    try {
      assertBoundedDiscovery(discovered)
      for (const tool of discovered) {
        this.#registry.validateSchemas(tool.inputSchema, tool.outputSchema)
      }
    } catch {
      throw new McpAdapterError('MCP_DISCOVERY_FAILED')
    }

    const names = new Set<string>()
    for (const tool of discovered) {
      if (names.has(tool.name)) throw new McpAdapterError('MCP_DISCOVERY_FAILED')
      names.add(tool.name)
    }
    for (const [name, binding] of this.#bindings) {
      if (!names.has(name)) binding.availability = 'removed'
    }

    const versions: ToolVersion[] = []
    for (const tool of discovered) versions.push(await this.#import(tool))
    return versions
  }

  async execute(request: ToolExecutionRequest, version: ToolVersion, signal: AbortSignal) {
    const source = version.source
    if (source?.kind !== 'mcp' || source.serverId !== this.#registration.serverId) {
      throw new ToolExecutorError('MCP_PROVENANCE_MISMATCH', false, 'none')
    }
    const binding = this.#bindings.get(source.sourceToolName)
    if (!binding || binding.availability === 'removed') {
      throw new ToolExecutorError('MCP_TOOL_REMOVED', false, 'none')
    }
    if (binding.availability === 'disconnected') {
      throw new ToolExecutorError('MCP_DISCONNECTED', true, 'none')
    }
    if (binding.latest?.source?.schemaDigest !== source.schemaDigest) {
      throw new ToolExecutorError('MCP_SCHEMA_CHANGED', false, 'none')
    }
    try {
      const output = await this.#client.invoke(
        {
          serverId: this.#registration.serverId,
          toolName: source.sourceToolName,
          input: request.input,
          credentialRef: this.#registration.credentialRef,
        },
        signal
      )
      return { output }
    } catch (error) {
      const code =
        error instanceof Error && typeof (error as Error & { code?: unknown }).code === 'string'
          ? String((error as Error & { code: string }).code)
          : 'MCP_PROTOCOL_ERROR'
      const disconnected = code === 'MCP_DISCONNECTED'
      if (disconnected) binding.availability = 'disconnected'
      throw new ToolExecutorError(code, disconnected, 'none')
    }
  }

  async #import(tool: McpDiscoveredTool): Promise<ToolVersion> {
    const schemaDigest = digest({
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      sourceToolVersion: tool.version,
      requiredCapabilities: [...(tool.capabilities ?? [])].map(canonicalName),
      readOnly: tool.readOnly === true,
    })
    let binding = this.#bindings.get(tool.name)
    const current = binding?.latest
    if (binding && current?.source?.schemaDigest === schemaDigest) {
      binding.availability = 'available'
      return structuredClone(current)
    }

    const now = this.#now()
    if (!binding) {
      const toolDefinitionId = this.#ids.definition()
      await this.#registry.createDefinition({
        toolDefinitionId,
        name: `${this.#registration.serverId}.${canonicalName(tool.name)}`,
        displayName: tool.name.slice(0, 128),
        description: tool.description.slice(0, 2_048),
        ownership: { scope: 'workspace', workspaceId: this.#workspaceId },
        createdAt: now,
      })
      binding = {
        toolDefinitionId,
        latest: undefined,
        revision: 0,
        availability: 'available',
      }
      this.#bindings.set(tool.name, binding)
    }

    binding.revision += 1
    const published = await this.#registry.publishVersion({
      toolVersionId: this.#ids.version(),
      toolDefinitionId: binding.toolDefinitionId,
      semanticVersion: `0.0.${binding.revision}`,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      operations: [
        {
          name: 'invoke',
          requiredCapabilities: [...(tool.capabilities ?? [])].map(canonicalName),
          riskClass: tool.readOnly === true ? 'low' : 'medium',
          approvalMode: tool.readOnly === true ? 'policy' : 'always',
          idempotency: tool.readOnly === true ? 'inherent' : 'none',
        },
      ],
      executor: { type: 'mcp', reference: this.#executorReference },
      source: {
        kind: 'mcp',
        serverId: this.#registration.serverId,
        sourceToolName: tool.name,
        ...(tool.version === undefined ? {} : { sourceToolVersion: tool.version }),
        schemaDigest,
        discoveredAt: now,
      },
      limits: this.#limits,
      createdAt: now,
      publishedAt: now,
    })
    binding.latest = published
    binding.availability = 'available'
    return structuredClone(published)
  }
}

function assertBoundedDiscovery(discovered: readonly McpDiscoveredTool[]): void {
  if (!Array.isArray(discovered) || discovered.length > mcpDiscoveryLimits.maxTools) {
    throw new McpAdapterError('MCP_DISCOVERY_FAILED')
  }

  for (const tool of discovered) {
    if (tool === null || typeof tool !== 'object') failDiscovery()
    assertBoundedString(tool.name, mcpDiscoveryLimits.maxNameBytes)
    assertBoundedString(tool.description, mcpDiscoveryLimits.maxDescriptionBytes)
    if (tool.version !== undefined) {
      assertBoundedString(tool.version, mcpDiscoveryLimits.maxVersionBytes)
    }
    if (tool.readOnly !== undefined && typeof tool.readOnly !== 'boolean') failDiscovery()

    if (tool.capabilities !== undefined) {
      if (
        !Array.isArray(tool.capabilities) ||
        tool.capabilities.length > mcpDiscoveryLimits.maxCapabilities
      ) {
        failDiscovery()
      }
      const capabilities = new Set<string>()
      for (const capability of tool.capabilities) {
        assertBoundedString(capability, mcpDiscoveryLimits.maxCapabilityBytes)
        const canonicalCapability = canonicalName(capability)
        if (capabilities.has(canonicalCapability)) failDiscovery()
        capabilities.add(canonicalCapability)
      }
    }

    measureJsonBytes(
      tool.inputSchema,
      mcpDiscoveryLimits.maxSchemaBytes,
      mcpDiscoveryLimits.maxSchemaDepth
    )
    measureJsonBytes(
      tool.outputSchema,
      mcpDiscoveryLimits.maxSchemaBytes,
      mcpDiscoveryLimits.maxSchemaDepth
    )
  }

  measureJsonBytes(discovered, mcpDiscoveryLimits.maxAggregateBytes)
}

function assertBoundedString(value: unknown, maxBytes: number): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maxBytes
  ) {
    failDiscovery()
  }
}

function measureJsonBytes(value: unknown, maxBytes: number, maxDepth = Number.POSITIVE_INFINITY) {
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 1 }]
  const seen = new WeakSet<object>()
  let bytes = 0

  const add = (count: number) => {
    bytes += count
    if (bytes > maxBytes) failDiscovery()
  }

  while (stack.length > 0) {
    const entry = stack.pop()
    if (!entry || entry.depth > maxDepth) failDiscovery()
    const current = entry.value
    if (current === null) {
      add(4)
    } else if (typeof current === 'string') {
      add(Buffer.byteLength(JSON.stringify(current), 'utf8'))
    } else if (typeof current === 'boolean') {
      add(current ? 4 : 5)
    } else if (typeof current === 'number') {
      if (!Number.isFinite(current)) failDiscovery()
      add(Buffer.byteLength(JSON.stringify(current), 'utf8'))
    } else if (typeof current === 'object') {
      if (seen.has(current)) failDiscovery()
      seen.add(current)
      if (Array.isArray(current)) {
        add(2 + Math.max(0, current.length - 1))
        for (const item of current) stack.push({ value: item, depth: entry.depth + 1 })
      } else {
        const entries = Object.entries(current).filter(([, item]) => item !== undefined)
        add(2 + Math.max(0, entries.length - 1))
        for (const [key, item] of entries) {
          add(Buffer.byteLength(JSON.stringify(key), 'utf8') + 1)
          stack.push({ value: item, depth: entry.depth + 1 })
        }
      }
    } else {
      failDiscovery()
    }
  }

  return bytes
}

function failDiscovery(): never {
  throw new McpAdapterError('MCP_DISCOVERY_FAILED')
}

function canonicalName(value: string): string {
  const normalizedName = value
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
  return (
    /^[a-z]/.test(normalizedName) ? normalizedName : `tool.${normalizedName || 'unnamed'}`
  ).slice(0, 128)
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`
}

function canonical(value: unknown): string {
  if (value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}
