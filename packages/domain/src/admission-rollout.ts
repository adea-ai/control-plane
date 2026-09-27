/** Lightweight error contract shared by persistence and portable acceptance consumers. */
export type AdmissionRolloutErrorCode =
  | 'ADMISSION_ROLLOUT_PAUSED'
  | 'ADMISSION_ROLLOUT_GATE_UNAVAILABLE'
  | 'ADMISSION_ROLLOUT_STATE_INVALID'
  | 'ADMISSION_ROLLOUT_AUTHORITY_DENIED'

export class AdmissionRolloutError extends Error {
  readonly code: AdmissionRolloutErrorCode

  constructor(code: AdmissionRolloutErrorCode) {
    super('Admission rollout gate operation was denied')
    this.name = 'AdmissionRolloutError'
    this.code = code
  }
}
