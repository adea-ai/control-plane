import {
  runRuntimeNodeIdentityAdmin,
  runtimeNodeIdentityAdminDiagnostic,
} from './runtime-node-identity-admin.mjs'

try {
  const result = await runRuntimeNodeIdentityAdmin({ argv: process.argv.slice(2) })
  process.stdout.write(`${JSON.stringify(result)}\n`)
} catch (error) {
  process.stderr.write(`${runtimeNodeIdentityAdminDiagnostic(error)}\n`)
  process.exitCode = 1
}
