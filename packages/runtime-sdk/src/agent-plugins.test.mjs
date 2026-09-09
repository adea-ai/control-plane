import { describe, expect, test } from 'bun:test'
import { createHarnessProfile, HarnessProfileSchema } from './agent-plugins.ts'

describe('Agent Plugins harness profiles', () => {
  test('requires explicit adapter evidence for both native and component paths', () => {
    const profile = createHarnessProfile({
      adapterVersion: '1.0.0',
      agentPlugins: { versions: ['1.0.0'], skills: true, mcpTransports: ['stdio'] },
      components: { skillDirectories: true, mcpTransports: ['stdio', 'streamable-http'] },
      harness: 'codex',
      runtimeVersion: '1.0.0',
    })
    expect(HarnessProfileSchema.parse(profile)).toEqual(profile)
    expect(() =>
      HarnessProfileSchema.parse({ ...profile, components: { skillDirectories: true } })
    ).toThrow()
  })
})
