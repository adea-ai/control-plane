import type { PiDurableInferenceResumePermit } from './contracts.js'

// Identity, not shape, makes a permit. A permit skips the ledger's physical-dispatch replay fence
// for one retained hold, so a structurally matching literal must never pass for one. Only the
// adapter's recovery path calls `issueInferenceResumePermit`; this module is not re-exported from
// the package entry point, so a consumer's usage authority can pass a permit on but not mint one.
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
