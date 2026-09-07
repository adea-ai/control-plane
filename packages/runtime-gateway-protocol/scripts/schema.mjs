import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { GatewayEnvelopeSchema } from '../src/index.ts'

function formatJson(text) {
  const config = fileURLToPath(new URL('../../../.oxfmtrc.json', import.meta.url))
  const result = spawnSync(
    'bun',
    ['x', 'oxfmt', '--stdin-filepath', 'artifact.json', '--config', config],
    { input: text, encoding: 'utf8' }
  )
  if (result.status !== 0) throw new Error(`oxfmt JSON formatting failed: ${result.stderr}`)
  return result.stdout
}

const outputUrl = new URL('../schema/gateway-envelope.v1.json', import.meta.url)

export function gatewayJsonSchema() {
  return {
    $id: 'https://schemas.control-plane.dev/runtime-gateway/gateway-envelope.v1.json',
    title: 'Control Plane Runtime Gateway Envelope v1',
    ...z.toJSONSchema(GatewayEnvelopeSchema),
    'x-control-plane-prohibitedPayloadKeys': [
      'credential',
      'databaseId',
      'endpoint',
      'executable',
      'localPath',
      'password',
      'privateKey',
      'projectId',
      'sourceScope',
      'token',
      'url',
    ],
  }
}

const expected = formatJson(JSON.stringify(gatewayJsonSchema()))

if (import.meta.main) {
  if (process.argv.includes('--check')) {
    const actual = await readFile(outputUrl, 'utf8').catch(() => '')
    if (actual !== expected) throw new Error('Runtime Gateway JSON schema is out of date')
  } else {
    await Bun.write(fileURLToPath(outputUrl), expected)
  }
}
