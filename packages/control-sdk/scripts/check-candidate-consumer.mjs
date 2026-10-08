import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Consume already-built public tarballs. No packing, publication, version invention,
// registry lookup, provider request, workspace edit or lifecycle script is performed.
const [sdkInput, contractsInput] = process.argv.slice(2)
if (!sdkInput || !contractsInput) throw new Error('Provide SDK and contracts candidate tarballs')
const sdk = resolve(sdkInput)
const contracts = resolve(contractsInput)
const sdkBytes = await readFile(sdk)
const contractBytes = await readFile(contracts)
const root = fileURLToPath(new URL('../../../', import.meta.url))
const directory = await mkdtemp(join(tmpdir(), 'model-funding-consumer-'))
try {
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      dependencies: { '@adea-ai/sdk': `file:${sdk}`, '@adea-ai/contracts': `file:${contracts}` },
      // Bind the SDK's real semver dependency to the exact unreleased candidate.
      // Do not add Zod here: its exported types must resolve from package metadata.
      overrides: { '@adea-ai/contracts': `file:${contracts}` },
    })
  )
  await writeFile(
    join(directory, 'consumer.ts'),
    `import {ControlPlaneClient,ModelSelectionFundingRequestSchema,ModelSelectionFundingViewSchema,type ModelSelectionFundingRequest,type ModelSelectionFundingResponse,type ModelFundingOwner} from '@adea-ai/sdk'
export async function readFunding(client:ControlPlaneClient,input:ModelSelectionFundingRequest):Promise<ModelSelectionFundingResponse> {
  const response=await client.getModelSelectionFunding(ModelSelectionFundingRequestSchema.parse(input))
  const view=ModelSelectionFundingViewSchema.parse(response.data.funding)
  if(view.state==='ready') {const payer:ModelFundingOwner=view.fundingOwner;if(!payer.evidenceRef||!view.authorizationRef) throw new Error('Missing recorded evidence')}
  return response
}
`
  )
  execFileSync('bun', ['install', '--offline', '--ignore-scripts'], {
    cwd: directory,
    stdio: 'pipe',
  })
  execFileSync(
    join(root, 'node_modules/.bin/tsc'),
    [
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      'false',
      '--target',
      'ES2023',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      'consumer.ts',
    ],
    { cwd: directory, stdio: 'pipe' }
  )
  console.log(
    JSON.stringify({
      qualification: 'Strict public candidate consumer only; no live inference or registry release',
      strictConsumerTypes: true,
      dependencyScripts: false,
      sdkSha256: createHash('sha256').update(sdkBytes).digest('hex'),
      contractsSha256: createHash('sha256').update(contractBytes).digest('hex'),
    })
  )
} finally {
  await rm(directory, { recursive: true, force: true })
}
