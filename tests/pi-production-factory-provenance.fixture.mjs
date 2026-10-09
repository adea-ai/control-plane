import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// This fixture's repository owns the launcher identity, regardless of caller cwd.
export function productionFactorySourceIdentity() {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
}

// Count attempted reads of the selected port, including denied/failed reads.
// Preserve the actual reader's result, rejection and receiver.
export function countProductionProductReads(reader, state) {
  return {
    async readCurrent(input) {
      state.productReads++
      return reader.readCurrent(input)
    },
  }
}
