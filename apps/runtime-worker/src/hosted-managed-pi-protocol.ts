import { type StoredObjectDescriptor } from '@control-plane/object-store'
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

// CANONICAL-JSON: site-specific semantics, see contracts canonicalJsonStringify
// values are z.json() (arbitrary keys); serializations cross a process boundary and feed artifact fingerprints
export function canonicalJson(value: z.util.JSONType): string {
  return JSON.stringify(canonicalValue(value))
}

export function canonicalValue(value: z.util.JSONType): z.util.JSONType {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalValue(child)])
    )
  }
  return value
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
