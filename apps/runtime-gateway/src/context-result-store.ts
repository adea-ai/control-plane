import { createHash } from 'node:crypto'
import type { ObjectStore, StoredObject, StoredObjectDescriptor } from '@control-plane/deployment'
import { ContextCommandRecordSchema, type ContextCommandRecord } from '@control-plane/domain'
import {
  GatewayArtifactReferenceSchema,
  GatewayResultEnvelopeSchema,
  type GatewayResultEnvelope,
} from '@control-plane/runtime-gateway-protocol'
import { canonicalContextJson, contextCommandResultDigest } from './context-result-integrity.js'

const artifactIdSchema = ContextCommandRecordSchema.shape.resultReference.unwrap()

/** Stores verified bytes, not merely a node-provided Artifact ID. Does not own/close the ObjectStore. */
export class ContextCommandArtifactStore {
  constructor(
    readonly objectStore: ObjectStore,
    readonly maxResultBytes = 262144
  ) {
    if (
      !Number.isSafeInteger(maxResultBytes) ||
      maxResultBytes < 1 ||
      maxResultBytes > 64 * 1024 * 1024
    )
      fail('INVALID_LIMIT')
  }

  async persist(
    commandInput: ContextCommandRecord,
    resultInput: GatewayResultEnvelope,
    digest: string
  ): Promise<string> {
    const command = ContextCommandRecordSchema.parse(commandInput)
    const result = GatewayResultEnvelopeSchema.parse(resultInput)
    if (
      result.status !== 'succeeded' ||
      result.workspaceId !== command.scope.workspaceId ||
      result.nodeId !== command.nodeId ||
      result.commandId !== command.commandId ||
      result.payloadHash !== command.payloadHash ||
      contextCommandResultDigest(result) !== digest
    )
      fail('SCOPE_MISMATCH')
    const artifactId = allocatedArtifactId(command, digest)
    const key = storedKey(command, artifactId)
    // A retry after an ambiguous PUT verifies the stored bytes before returning its stable ID.
    try {
      await this.#read(command, artifactId, digest)
      return artifactId
    } catch (error) {
      if (!missing(error)) throw error
    }
    let body: Uint8Array
    if ('data' in result.result)
      body = new TextEncoder().encode(canonicalContextJson(result.result.data))
    else {
      const reference = result.result.artifact
      if (reference.sizeBytes > this.maxResultBytes) fail('TOO_LARGE')
      const uploadKey = contextCommandUploadKey(command, reference.artifactId)
      const metadata = contextCommandUploadMetadata(command)
      const head = await this.objectStore.head(uploadKey)
      this.#descriptor(head, uploadKey, metadata)
      if (
        head.size !== reference.sizeBytes ||
        head.sha256 !== reference.digest ||
        head.contentType !== reference.mediaType
      )
        fail('INTEGRITY_FAILURE')
      const uploaded = await this.objectStore.get(uploadKey)
      this.#bytes(uploaded, uploadKey, metadata)
      if (
        uploaded.sha256 !== reference.digest ||
        uploaded.size !== reference.sizeBytes ||
        uploaded.contentType !== reference.mediaType
      )
        fail('INTEGRITY_FAILURE')
      body = uploaded.body
    }
    if (body.byteLength > this.maxResultBytes) fail('TOO_LARGE')
    parseData(body)
    const metadata = {
      ...binding(command),
      kind: 'context-result-v1',
      'completion-digest': digest,
      'completed-at': result.completedAt,
      ...('artifact' in result.result
        ? { 'source-artifact': JSON.stringify(result.result.artifact) }
        : {}),
    }
    const stored = await this.objectStore.put({
      key,
      body,
      contentType: 'application/json',
      metadata,
    })
    this.#descriptor(stored, key, metadata)
    if (stored.size !== body.byteLength || stored.sha256 !== sha256(body)) fail('INTEGRITY_FAILURE')
    // PUT acknowledgement alone is not evidence that the expected bytes can be read.
    await this.#read(command, artifactId, digest)
    return artifactId
  }

  async read(commandInput: ContextCommandRecord): Promise<Record<string, unknown>> {
    const command = ContextCommandRecordSchema.parse(commandInput)
    if (command.status !== 'succeeded' || !command.resultReference || !command.completionDigest)
      fail('NOT_COMPLETED')
    return this.#read(command, command.resultReference, command.completionDigest)
  }

  async #read(
    command: ContextCommandRecord,
    artifactId: string,
    digest: string
  ): Promise<Record<string, unknown>> {
    if (artifactId !== allocatedArtifactId(command, digest)) fail('SCOPE_MISMATCH')
    const key = storedKey(command, artifactId)
    const metadata = { ...binding(command), kind: 'context-result-v1', 'completion-digest': digest }
    this.#descriptor(await this.objectStore.head(key), key, metadata)
    const stored = await this.objectStore.get(key)
    this.#bytes(stored, key, metadata)
    if (stored.contentType !== 'application/json') fail('INTEGRITY_FAILURE')
    const source = stored.metadata['source-artifact']
    const reference =
      source === undefined ? undefined : GatewayArtifactReferenceSchema.parse(JSON.parse(source))
    const frame = {
      payloadHash: command.payloadHash,
      status: 'succeeded',
      completedAt: stored.metadata['completed-at'],
      result: reference
        ? { artifact: reference }
        : { data: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stored.body)) },
    }
    if (contextCommandResultDigest(frame) !== digest) fail('INTEGRITY_FAILURE')
    if (
      reference &&
      (reference.digest !== sha256(stored.body) || reference.sizeBytes !== stored.body.byteLength)
    )
      fail('INTEGRITY_FAILURE')
    return parseData(stored.body)
  }

  #descriptor(
    value: StoredObjectDescriptor,
    key: string,
    metadata: Readonly<Record<string, string>>
  ): void {
    if (!Number.isSafeInteger(value.size) || value.size < 0 || value.size > this.maxResultBytes)
      fail('TOO_LARGE')
    if (
      value.key !== key ||
      Object.entries(metadata).some(([name, expected]) => value.metadata[name] !== expected)
    )
      fail('SCOPE_MISMATCH')
  }
  #bytes(value: StoredObject, key: string, metadata: Readonly<Record<string, string>>): void {
    this.#descriptor(value, key, metadata)
    if (
      !(value.body instanceof Uint8Array) ||
      value.body.byteLength !== value.size ||
      sha256(value.body) !== value.sha256
    )
      fail('INTEGRITY_FAILURE')
  }
}

/** Upload credentials must permit only this command-scoped key; metadata is checked again on ingest. */
export function contextCommandUploadKey(
  commandInput: ContextCommandRecord,
  artifactId: string
): string {
  const command = ContextCommandRecordSchema.parse(commandInput)
  return `context-results/v1/uploads/${command.scope.workspaceId}/${command.nodeId}/${command.commandId}/${artifactIdSchema.parse(artifactId)}`
}
export function contextCommandUploadMetadata(
  commandInput: ContextCommandRecord
): Record<string, string> {
  return {
    ...binding(ContextCommandRecordSchema.parse(commandInput)),
    kind: 'context-result-upload-v1',
  }
}
function binding(command: ContextCommandRecord): Record<string, string> {
  return {
    'workspace-id': command.scope.workspaceId,
    'node-id': command.nodeId,
    'command-id': command.commandId,
    'payload-hash': command.payloadHash,
  }
}
function storedKey(command: ContextCommandRecord, artifactId: string): string {
  return `context-results/v1/stored/${command.scope.workspaceId}/${command.nodeId}/${command.commandId}/${artifactId}`
}
function allocatedArtifactId(command: ContextCommandRecord, digest: string): string {
  let value = BigInt(
    `0x${createHash('sha256')
      .update(
        canonicalContextJson({
          scope: command.scope,
          commandId: command.commandId,
          digest,
        })
      )
      .digest('hex')
      .slice(0, 32)}`
  )
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let suffix = ''
  for (let index = 0; index < 26; index++) {
    suffix = alphabet[Number(value & 31n)] + suffix
    value >>= 5n
  }
  return artifactIdSchema.parse(`art_${suffix}`)
}
function parseData(body: Uint8Array): Record<string, unknown> {
  const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
  return GatewayResultEnvelopeSchema.shape.result.options[0].shape.data.parse(parsed)
}
function sha256(body: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(body).digest('hex')}`
}
function missing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'OBJECT_STORE_NOT_FOUND'
  )
}
function fail(code: string): never {
  throw new Error(`CONTEXT_RESULT_${code}`)
}
