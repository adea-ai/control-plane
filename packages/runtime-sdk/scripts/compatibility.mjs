import { access, readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { RuntimeCompatibilityMatrixSchema } from '../src/index.ts'

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

const matrixUrl = new URL(
  '../../../docs/runtime-compatibility/runtime-certifications.v1.json',
  import.meta.url
)
const schemaUrl = new URL(
  '../../../docs/runtime-compatibility/runtime-certifications.schema.json',
  import.meta.url
)

export function compatibilityJsonSchema() {
  return {
    $id: 'https://schemas.control-plane.dev/runtime/runtime-certifications.v1.json',
    title: 'Control Plane Runtime Compatibility Certifications v1',
    ...z.toJSONSchema(RuntimeCompatibilityMatrixSchema),
  }
}

const matrix = RuntimeCompatibilityMatrixSchema.parse(JSON.parse(await readFile(matrixUrl, 'utf8')))
for (const certification of matrix.certifications) {
  for (const evidence of certification.evidence) {
    await access(new URL(`../../../${evidence.source}`, import.meta.url))
  }
}
const expected = formatJson(JSON.stringify(compatibilityJsonSchema()))

if (import.meta.main) {
  if (process.argv.includes('--check')) {
    const actual = await readFile(schemaUrl, 'utf8').catch(() => '')
    if (actual !== expected) throw new Error('Runtime compatibility JSON schema is out of date')
  } else {
    await Bun.write(fileURLToPath(schemaUrl), expected)
  }
}
