import { createHash } from 'node:crypto'
import { canonicalJsonStringify, IdentifierSchemas } from '@control-plane/contracts'
import type { ObjectStore, StoredObjectDescriptor } from '@control-plane/deployment'
import { ToolExecutorError, type ToolExecutor } from '@control-plane/tool-sdk'

export interface ObjectStoreJsonArtifactScope {
  readonly workspaceId: string
  readonly projectId: string
}

/** Writes bounded JSON under a server-derived artifact key and verifies exact replay. */
export class ScopedObjectStoreJsonToolExecutor implements ToolExecutor {
  readonly #scope: ObjectStoreJsonArtifactScope

  constructor(
    readonly store: ObjectStore,
    readonly executorReference: string,
    scope: ObjectStoreJsonArtifactScope
  ) {
    this.#scope = {
      workspaceId: IdentifierSchemas.workspaceId.parse(scope.workspaceId),
      projectId: IdentifierSchemas.projectId.parse(scope.projectId),
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(executorReference)) {
      throw new Error('OBJECT_STORE_JSON_EXECUTOR_REFERENCE_INVALID')
    }
    if (!store.putIfAbsent) throw new Error('IMMUTABLE_OBJECT_STORE_REQUIRED')
  }

  async execute(
    request: Parameters<ToolExecutor['execute']>[0],
    version: Parameters<ToolExecutor['execute']>[1],
    signal: AbortSignal
  ) {
    if (signal.aborted) throw new ToolExecutorError('CANCELLED', false, 'none')
    if (
      request.operation !== 'store-json' ||
      version.executor.type !== 'internal' ||
      version.executor.reference !== this.executorReference
    ) {
      throw new ToolExecutorError('TOOL_BINDING_MISMATCH', false, 'none')
    }
    if (request.workspaceId !== this.#scope.workspaceId) {
      throw new ToolExecutorError('ARTIFACT_SCOPE_MISMATCH', false, 'none')
    }
    const body = new TextEncoder().encode(canonicalJsonStringify(request.input))
    const contentDigest = 'sha256:' + createHash('sha256').update(body).digest('hex')
    const suffix = createHash('sha256')
      .update(canonicalJsonStringify([request.workspaceId, request.executionId, request.requestId]))
      .digest('hex')
      .slice(0, 26)
      .toUpperCase()
    const artifactRef = IdentifierSchemas.artifactId.parse(`art_${suffix}`)
    const metadata = {
      workspace: request.workspaceId,
      execution: request.executionId,
      'workspace-id': request.workspaceId,
      'project-id': this.#scope.projectId,
      'execution-id': request.executionId,
      sensitivity: 'internal',
    }
    try {
      const creation = await this.store.putIfAbsent!({
        key: artifactRef,
        body,
        contentType: 'application/json',
        metadata,
      })
      const descriptor =
        creation.outcome === 'exists' ? await this.store.get(artifactRef) : creation.object
      if (
        !matchesArtifactDescriptor(
          descriptor,
          request,
          this.#scope,
          artifactRef,
          contentDigest,
          body
        )
      ) {
        throw new ToolExecutorError(
          creation.outcome === 'exists' ? 'OBJECT_EFFECT_CONFLICT' : 'OBJECT_EFFECT_INVALID',
          false,
          'committed'
        )
      }
      return { output: { artifactRef, contentDigest, size: body.byteLength } }
    } catch (error) {
      if (error instanceof ToolExecutorError) throw error
      throw new ToolExecutorError('OBJECT_EFFECT_UNCONFIRMED', false, 'unknown')
    }
  }
}

function matchesArtifactDescriptor(
  descriptor: StoredObjectDescriptor,
  request: Parameters<ToolExecutor['execute']>[0],
  scope: ObjectStoreJsonArtifactScope,
  artifactRef: string,
  contentDigest: string,
  body: Uint8Array
): boolean {
  return (
    descriptor.key === artifactRef &&
    descriptor.sha256 === contentDigest &&
    descriptor.size === body.byteLength &&
    descriptor.contentType === 'application/json' &&
    descriptor.metadata['workspace'] === request.workspaceId &&
    descriptor.metadata['execution'] === request.executionId &&
    descriptor.metadata['workspace-id'] === request.workspaceId &&
    descriptor.metadata['project-id'] === scope.projectId &&
    descriptor.metadata['execution-id'] === request.executionId &&
    descriptor.metadata['sensitivity'] === 'internal' &&
    descriptor.metadata['artifact-state'] === undefined
  )
}
