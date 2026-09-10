import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { failureScenarios } from '../packages/production-readiness/src/failure-injection.ts'
import { withGuaranteedCleanup } from './guaranteed-cleanup.mjs'
import { recoveryEvidence } from './m9-evidence-matrices.mjs'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const recoveryPort = await availablePort()
const recoveryEnvironment = {
  ...process.env,
  COMPOSE_PROJECT_NAME: `control-plane-m9-recovery-${String(process.pid)}`,
  POSTGRES_HOST_PORT: String(recoveryPort),
  DATABASE_ADMIN_URL: `postgresql://control_plane_admin:local-admin-only@127.0.0.1:${String(recoveryPort)}/postgres`,
  DATABASE_MIGRATION_URL: `postgresql://control_plane_migrator:local-migration-only@127.0.0.1:${String(recoveryPort)}/control_plane`,
  DATABASE_URL: `postgresql://control_plane_app:local-application-only@127.0.0.1:${String(recoveryPort)}/control_plane`,
}
const injectorEvidence = {
  file: 'packages/production-readiness/src/failure-injection.test.mjs',
  testName: 'injects every named production failure through a reusable bounded control',
}
const actualScenarios = recoveryEvidence.map(({ scenario }) => scenario)
if (new Set(actualScenarios).size !== actualScenarios.length)
  throw new Error('RECOVERY_MATRIX_DUPLICATE')
if (
  failureScenarios.some((scenario) => !actualScenarios.includes(scenario)) ||
  actualScenarios.length !== failureScenarios.length
) {
  throw new Error('RECOVERY_MATRIX_INCOMPLETE')
}

const testEvidence = [injectorEvidence, ...recoveryEvidence.filter(({ kind }) => kind === 'test')]
for (const { file, testName } of testEvidence) {
  const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8')
  if (!source.includes(`test('${testName}'`))
    throw new Error(`RECOVERY_EVIDENCE_MISSING:${file}:${testName}`)
}

for (const { file, evidenceText } of recoveryEvidence.filter(
  ({ kind }) => kind === 'integration'
)) {
  const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8')
  if (!source.includes(evidenceText)) {
    throw new Error(`RECOVERY_INTEGRATION_EVIDENCE_MISSING:${file}:${evidenceText}`)
  }
}

const files = [...new Set(testEvidence.map(({ file }) => `./${file}`))].toSorted()
run(process.execPath, ['test', ...files])
await withGuaranteedCleanup(
  () => {
    for (const command of new Set(
      recoveryEvidence
        .filter(({ kind }) => kind === 'integration')
        .map(({ command: commandText }) => commandText)
    )) {
      const [program, ...arguments_] = command.split(' ')
      const output = run(program, arguments_, true, recoveryEnvironment)
      for (const { evidenceText } of recoveryEvidence.filter(
        (entry) => entry.kind === 'integration' && entry.command === command
      )) {
        if (!output.includes(evidenceText)) {
          throw new Error(`RECOVERY_INTEGRATION_NOT_OBSERVED:${evidenceText}`)
        }
      }
    }
  },
  () =>
    run('docker', ['compose', 'down', '--volumes', '--remove-orphans'], false, recoveryEnvironment)
)
console.log(`Recovery matrix passed: ${actualScenarios.length} named failure scenarios.`)

function run(command, arguments_, capture = false, environment = process.env) {
  const result = spawnSync(command, arguments_, {
    cwd: repositoryRoot,
    stdio: capture ? 'pipe' : 'inherit',
    encoding: capture ? 'utf8' : undefined,
    env: environment,
  })
  if (result.error) throw result.error
  if (capture) {
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${String(result.status ?? 1)}`)
  }
  return capture ? `${result.stdout ?? ''}\n${result.stderr ?? ''}` : ''
}

async function availablePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('RECOVERY_PORT_UNAVAILABLE')
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
  return address.port
}
