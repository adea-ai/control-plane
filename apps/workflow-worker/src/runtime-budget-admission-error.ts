export class RuntimeBudgetAdmissionError extends Error {
  readonly code = 'RUNTIME_BUDGET_ADMISSION_DENIED'

  constructor() {
    super('RUNTIME_BUDGET_ADMISSION_DENIED')
    this.name = 'RuntimeBudgetAdmissionError'
  }
}
