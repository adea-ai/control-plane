/** Closes all owned compositions before removing their data directories. */
export async function cleanupTemporaryCompositions({
  ownedCompositions,
  directories,
  disposeComposition,
  removeDirectory,
}) {
  const failures = []
  const unconfirmedDirectories = new Set()

  for (const { composition, directory } of ownedCompositions) {
    try {
      await disposeComposition(composition)
    } catch (error) {
      failures.push(error)
      unconfirmedDirectories.add(directory)
    }
  }

  const allDirectories = new Set([
    ...directories,
    ...ownedCompositions.map(({ directory }) => directory),
  ])
  for (const directory of allDirectories) {
    if (unconfirmedDirectories.has(directory)) {
      failures.push(new Error(`temporary state preserved until close is confirmed: ${directory}`))
      continue
    }
    try {
      await removeDirectory(directory)
    } catch (error) {
      failures.push(error)
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, 'Temporary composition cleanup failed', {
      cause: failures[0],
    })
  }
}
