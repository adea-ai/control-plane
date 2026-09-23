import { type StoredObjectDescriptor } from '@control-plane/object-store'
import { canonicalJsonStringify } from '@control-plane/domain'
import { RuntimeAdapterError, RuntimeArtifactReferenceSchema } from '@control-plane/runtime-sdk'
import { z } from 'zod'

export function unavailableHost(): RuntimeAdapterError {
  return new RuntimeAdapterError({
    code: 'HOSTED_PI_HOST_UNAVAILABLE',
    classification: 'unavailable',
    message: 'Hosted managed Pi host is unavailable',
    retryable: true,
  })
}

export function stable(value: unknown): string {
  return JSON.stringify(value)
}

// CANONICAL-JSON: code-point canonical form since the #612 cutover (contracts
// canonicalJsonStringify). Artifact fingerprints and cross-process
// serializations are host-independent; an execution replaying across the
// cutover boundary with locale-divergent result keys conflicts by design
// (fail-closed), matching the previous cross-host behavior — pre-cutover
// artifacts age out with retention.
export function canonicalJson(value: z.util.JSONType): string {
  return canonicalJsonStringify(value) ?? 'null'
}

export function artifactReference(
  attemptId: string,
  stored: StoredObjectDescriptor
): z.output<typeof RuntimeArtifactReferenceSchema> {
  return RuntimeArtifactReferenceSchema.parse({
    artifactId: `art_${attemptId.slice(4)}`,
    version: 1,
    mediaType: stored.contentType,
    digest: stored.sha256,
    sizeBytes: stored.size,
    locator: `artifact://${stored.key}`,
  })
}

export function artifactConflict(): Error {
  return new Error('HOSTED_ARTIFACT_RESULT_CONFLICT')
}
