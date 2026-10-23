import type { PiDurableInferenceResumePermit } from './contracts.js'

// Identity, rather than a caller-supplied shape, authorizes reuse of a retained hold.
const issued = new WeakSet<object>()

export function issueInferenceResumePermit(inferenceKey: string): PiDurableInferenceResumePermit {
  const permit = Object.freeze({
    schemaVersion: 'pi-inference-resume-permit/v1' as const,
    inferenceKey,
  })
  issued.add(permit)
  return permit
}

export function isIssuedInferenceResumePermit(
  value: unknown,
  inferenceKey: string
): value is PiDurableInferenceResumePermit {
  return (
    typeof value === 'object' &&
    value !== null &&
    issued.has(value) &&
    (value as PiDurableInferenceResumePermit).inferenceKey === inferenceKey
  )
}
