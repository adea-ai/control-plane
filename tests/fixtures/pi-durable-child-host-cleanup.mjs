import { cleanupTemporaryCompositions } from './profile-recovery-cleanup.mjs'

/** Drain accepted work before closing every owner of the child host's shared state. */
export async function cleanupChildHost({
  directory,
  closeSteps,
  ownedWork,
  removeDirectory,
  primaryFailure,
}) {
  // Rejections belong to the work's caller; settlement establishes that no owned
  // operation can still use a resource or its directory during teardown.
  await Promise.allSettled(ownedWork)
  try {
    await cleanupTemporaryCompositions({
      ownedCompositions: closeSteps.map((close) => ({ composition: close, directory })),
      directories: [directory],
      disposeComposition: (close) => close(),
      removeDirectory,
    })
  } catch (error) {
    if (primaryFailure === undefined) throw error
    throw new AggregateError(
      [primaryFailure, ...(error instanceof AggregateError ? error.errors : [error])],
      'Child host failed and cleanup failed',
      { cause: error }
    )
  }
}
