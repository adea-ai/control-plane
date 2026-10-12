import { expect, test } from 'bun:test'
import { createRequire } from 'node:module'
import { piDurableRegistryMetadata } from './registry.ts'

const requireFromAdapter = createRequire(import.meta.url)

test('pinned registry metadata matches the installed Pi 1.1.0 packages and Responses-only catalog', () => {
  expect(requireFromAdapter('@earendil-works/pi-ai/package.json').version).toBe(
    piDurableRegistryMetadata.piAiVersion
  )
  expect(requireFromAdapter('@earendil-works/pi-durable/package.json').version).toBe(
    piDurableRegistryMetadata.piDurableVersion
  )
  expect(Object.isFrozen(piDurableRegistryMetadata)).toBe(true)
  const models = piDurableRegistryMetadata.getModels()
  expect(models.map((model) => model.id)).toContain('gpt-5')
  expect([...new Set(models.map((model) => `${model.provider}/${model.api}`))]).toEqual([
    'openai/openai-responses',
  ])
})
