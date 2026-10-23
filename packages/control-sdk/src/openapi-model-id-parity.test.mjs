import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ModelIdSchema } from '@control-plane/contracts'
import { expandAsciiCasePattern } from '../scripts/openapi.mjs'

const artifact = JSON.parse(
  readFileSync(join(import.meta.dir, '..', 'openapi', 'control-plane.v3.json'), 'utf8')
)

/** The published pattern of the accepted model id in the execution acceptance payload. */
const publishedModelIdPattern = (() => {
  const request = artifact.paths['/v1/executions/accept'].post.requestBody
  const properties = request.content['application/json'].schema.properties.payload.properties
  return properties.modelId.pattern
})()

const published = new RegExp(publishedModelIdPattern)
const runtime = (value) => ModelIdSchema.safeParse(value).success

describe('the accepted model id keeps the runtime acceptance in the generated contract', () => {
  test('the runtime model id accepts uppercase ASCII ids', () => {
    for (const modelId of [
      'deepseek-flash',
      'DeepSeek-V3',
      'GPT-4o',
      'DEEPSEEK',
      'glm-4',
      'GLM-4',
      'a',
      'Z',
      '0',
      'model.with/slash-and_underscore',
      'deepseek/',
    ]) {
      expect(runtime(modelId)).toBe(true)
    }
  })

  test('the runtime model id refuses the ids it has always refused', () => {
    for (const modelId of [
      '',
      ' ',
      'deepseek flash',
      '-deepseek',
      '.deepseek',
      'deepseek flash/x',
    ]) {
      expect(runtime(modelId)).toBe(false)
    }
  })

  test('the published pattern is the explicit ASCII class, not the narrowed one', () => {
    expect(publishedModelIdPattern).toBe('^[a-zA-Z0-9][a-zA-Z0-9._/-]*$')
    expect(publishedModelIdPattern).not.toBe('^[a-z0-9][a-z0-9._/-]*$')
  })

  test('the published pattern accepts exactly what the runtime accepts', () => {
    // The ASCII domain of the model id: every string of up to two characters
    // over the characters the id may contain. The comparison is exhaustive
    // over that domain, so a narrowed published pattern is a failure here
    // rather than a gap in the contract.
    const alphabet = 'aAzZ09._/-'
    const candidates = ['']
    for (const first of alphabet) {
      candidates.push(first)
      for (const second of alphabet) candidates.push(first + second)
    }
    for (const candidate of candidates) {
      expect([candidate, published.test(candidate)]).toEqual([candidate, runtime(candidate)])
    }
  })

  test('the published pattern accepts an uppercase ASCII id the runtime accepts', () => {
    for (const modelId of ['DeepSeek-V3', 'GPT-4o', 'GLM-4']) {
      expect(runtime(modelId)).toBe(true)
      expect(published.test(modelId)).toBe(true)
    }
  })
})

describe('the explicit ASCII expansion of a case-insensitive pattern', () => {
  test('a case-insensitive range becomes both cases', () => {
    expect(expandAsciiCasePattern('^[a-z0-9][a-z0-9._/-]*$')).toBe('^[a-zA-Z0-9][a-zA-Z0-9._/-]*$')
    expect(expandAsciiCasePattern('^[a-f0-9]{64}$')).toBe('^[a-fA-F0-9]{64}$')
    expect(expandAsciiCasePattern('^[A-Z][a-z]+$')).toBe('^[A-Za-z][a-zA-Z]+$')
  })

  test('the expansion matches the case-insensitive pattern it replaces', () => {
    const alphabet = 'aAzZ09._/-'
    const candidates = ['']
    for (const first of alphabet) {
      candidates.push(first)
      for (const second of alphabet) candidates.push(first + second)
    }
    for (const source of [
      '^[a-z0-9][a-z0-9._/-]*$',
      '^[a-f0-9]{64}$',
      '^[A-Z][a-z]+$',
      '^[A-Za-z]+$',
    ]) {
      const caseInsensitive = new RegExp(source, 'i')
      const expanded = new RegExp(expandAsciiCasePattern(source))
      for (const candidate of candidates) {
        expect([source, candidate, expanded.test(candidate)]).toEqual([
          source,
          candidate,
          caseInsensitive.test(candidate),
        ])
      }
    }
  })
})
