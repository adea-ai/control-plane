import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { URL } from 'node:url'
import { GatewayProtocolManifest } from '../packages/runtime-gateway-protocol/dist/index.js'

import '../apps/runtime-gateway/src/authentication.test.mjs'
import '../apps/runtime-gateway/src/reconnect-reconciliation.test.mjs'
import '../apps/runtime-gateway/src/runtime-command-delivery.test.mjs'
import '../apps/runtime-gateway/src/runtime-event-ingestion.test.mjs'
import '../apps/runtime-gateway/src/runtime-inventory-ingestion.test.mjs'
import '../apps/runtime-gateway/src/websocket-lifecycle.test.mjs'

const acceptanceControls = {
  'authentication.test.mjs': [
    'device-bound channel',
    'wrong audience',
    'wrong node',
    'wrong workspace',
    'expiry',
    'credential replay',
    'revocation',
  ],
  'websocket-lifecycle.test.mjs': [
    'heartbeat degradation',
    'reconnects across instances',
    'oversized',
    'malformed',
    'backpressured',
  ],
  'runtime-command-delivery.test.mjs': [
    'lost ACK',
    'loss before ACK',
    'duplicate-result',
    'expires queued commands',
  ],
  'reconnect-reconciliation.test.mjs': [
    'after restart',
    'retained node terminal outcomes once',
    'expired, revoked, or capability-incompatible',
  ],
  'runtime-inventory-ingestion.test.mjs': [
    'omitted from a snapshot unavailable',
    'explicit removal',
    'survives reconnect',
  ],
  'runtime-event-ingestion.test.mjs': [
    'duplicate delivery',
    'cancellation races',
    'concurrent cancellation and completion',
  ],
}

describe('M5 runtime gateway acceptance manifest', () => {
  test('keeps every security and recovery control in the executable acceptance suite', async () => {
    for (const [file, controls] of Object.entries(acceptanceControls)) {
      const source = await readFile(
        new URL(`../apps/runtime-gateway/src/${file}`, import.meta.url),
        'utf8'
      )

      for (const control of controls) expect(source).toContain(control)
    }
  })

  test('records every supported Runtime Gateway protocol version', () => {
    expect(GatewayProtocolManifest).toEqual({
      name: 'control-plane-runtime-gateway',
      current: { major: 1, minor: 6 },
      supported: [
        { major: 1, minor: 0 },
        { major: 1, minor: 1 },
        { major: 1, minor: 2 },
        { major: 1, minor: 3 },
        { major: 1, minor: 4 },
        { major: 1, minor: 5 },
        { major: 1, minor: 6 },
      ],
    })
  })

  test('runs as an independent target and in the parallel Code Foundry E2E group', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    const groups = await readFile(
      new URL('../scripts/run-bun-test-group.mjs', import.meta.url),
      'utf8'
    )
    const codeFoundry = await readFile(
      new URL('../.github/code-foundry.yml', import.meta.url),
      'utf8'
    )
    const testingDocumentation = await readFile(
      new URL('../docs/testing.md', import.meta.url),
      'utf8'
    )

    expect(manifest.scripts['test:m5-acceptance']).toBe(
      'bun run build && bun test tests/m5-runtime-gateway.test.mjs'
    )
    expect(groups).toContain("'tests/m5-runtime-gateway.test.mjs'")
    expect(codeFoundry).toContain('features: all')
    expect(codeFoundry).toContain('coverage_minimum: 80')
    expect(testingDocumentation).toContain('`bun run test:m5-acceptance`')
    expect(testingDocumentation).toContain('M2-M6 acceptance flows')
  })
})
