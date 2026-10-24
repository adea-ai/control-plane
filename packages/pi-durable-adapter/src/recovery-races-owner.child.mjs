import { readFile } from 'node:fs/promises'
import { PiDurableRuntimeAdapter } from './adapter.ts'

const inputPath = process.argv[2]
if (!inputPath) throw new Error('CHILD_FIXTURE_INPUT_REQUIRED')

const { admission, at, directory, probe, request, result, roundTripProbe, workspaceId } =
  JSON.parse(await readFile(inputPath, 'utf8'))

setInterval(() => {}, 1000)
const adapter = new PiDurableRuntimeAdapter({
  directory,
  now: () => at,
  resolveAdmission: async () => admission,
  assertAuthority: async () => {},
  resolveProvider: async () => ({
    ...admission.selection,
    workspaceId,
    provider: 'scripted',
    providerModel: 'race-model',
    location: 'remote_host',
    harness: 'pi_durable',
    harnessVersion: '1.1.0',
    providerBinding: 'pi_durable_models',
    withModels: async (use) => use({}),
  }),
  authorizeInference: async () => ({
    maxOutputTokens: 10,
    maximumInputTokens: 64,
    assertActive: async () => {},
  }),
  settleUsage: async (_authority, _key, usage) => usage,
  reconcileInference: async () => 'unresolved',
  engineFactory: async () => ({
    run: async () => result,
    cancel: async () => {},
    close: async () => {
      process.stdout.write(
        `${JSON.stringify({ ownerPid: process.pid, probe, admissionPrompt: admission.prompt, roundTripProbe })}\n`
      )
      await new Promise(() => {})
    },
  }),
})

await adapter.start(request)
await adapter.drain()
