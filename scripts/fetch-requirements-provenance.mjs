import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const ledgerPath = 'docs/requirements/control-plane-requirements.v1.json'
const fullCommit = /^[0-9a-f]{40}$/

// The ledger names immutable commits that an ordinary clone does not carry: the
// candidate, the reconciliation base and the head each worker lane recorded. A
// lane head can live only in the hosting provider's commit store, so it is
// fetched by its exact object name. The name is the content hash, so a commit
// that arrives under that name is the recorded commit, and anything that does
// not arrive stays reported as unavailable. Nothing is substituted, rewritten
// or inferred, and an unavailable object is never read as verified.
export function provenanceTargets(ledger) {
  const targets = []
  if (fullCommit.test(ledger.candidate?.commit ?? ''))
    targets.push({ label: 'candidate', sha: ledger.candidate.commit })
  if (fullCommit.test(ledger.reconciliation?.reconciliationBase ?? ''))
    targets.push({ label: 'reconciliation base', sha: ledger.reconciliation.reconciliationBase })
  for (const worker of ledger.workerEvidence ?? []) {
    if (worker.status === 'pending') continue
    if (fullCommit.test(worker.head ?? ''))
      targets.push({ label: `${worker.id} (${worker.lane})`, sha: worker.head })
  }
  return targets
}

function git(spawn, root, args) {
  return spawn('git', args, { cwd: root, encoding: 'utf8' })
}

function resolveCommit(spawn, root, sha) {
  const result = git(spawn, root, ['rev-parse', '--verify', '-q', `${sha}^{commit}`])
  return result.status === 0 ? (result.stdout ?? '').trim() : null
}

export function fetchProvenanceObjects(ledger, options = {}) {
  const root = options.root ?? repositoryRoot
  const remote = options.remote ?? 'origin'
  const spawn = options.spawnSync ?? spawnSync
  const results = []
  for (const target of provenanceTargets(ledger)) {
    if (resolveCommit(spawn, root, target.sha) === target.sha) {
      results.push({ ...target, status: 'present' })
      continue
    }
    const fetched = git(spawn, root, ['fetch', '--quiet', '--no-tags', remote, target.sha])
    if (fetched.status !== 0) {
      const reason = (fetched.stderr ?? '').trim().split('\n').at(-1) || `exit ${fetched.status}`
      results.push({ ...target, status: 'unavailable', reason })
      continue
    }
    // Accept only the exact recorded object; a different resolved name is not it.
    const resolved = resolveCommit(spawn, root, target.sha)
    results.push(
      resolved === target.sha
        ? { ...target, status: 'fetched' }
        : {
            ...target,
            status: 'unavailable',
            reason: 'the fetched object does not carry the recorded name',
          }
    )
  }
  return results
}

export function isShallowRepository(root = repositoryRoot, spawn = spawnSync) {
  const result = git(spawn, root, ['rev-parse', '--is-shallow-repository'])
  return result.status === 0 && (result.stdout ?? '').trim() === 'true'
}

async function main() {
  const ledger = JSON.parse(await readFile(new URL(`../${ledgerPath}`, import.meta.url), 'utf8'))
  const remoteIndex = process.argv.indexOf('--remote')
  const remote = remoteIndex === -1 ? 'origin' : process.argv[remoteIndex + 1]
  if (isShallowRepository()) {
    console.warn(
      'Requirements provenance warning: this is a shallow checkout; the reconciliation-base ancestry stays unverified until the history is complete (git fetch --unshallow)'
    )
  }
  const results = fetchProvenanceObjects(ledger, { remote })
  for (const result of results) {
    const detail = result.reason ? `: ${result.reason}` : ''
    console.log(`${result.status.toUpperCase()} ${result.sha} ${result.label}${detail}`)
  }
  const unavailable = results.filter(({ status }) => status === 'unavailable')
  if (unavailable.length > 0) {
    throw new Error(
      `${unavailable.length} recorded provenance object(s) are unavailable; their evidence is unverified`
    )
  }
  console.log(`Fetched or found ${results.length} recorded provenance objects by exact name`)
}

if (import.meta.main) await main()
