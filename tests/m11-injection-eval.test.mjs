import { expect, test } from 'bun:test'
import { evaluateInjectionChannels } from '../scripts/evaluation-m11-injection.mjs'

test('M11.6 evidence injection controls reject untrusted completion and action requests', async () => {
  const report = await evaluateInjectionChannels()

  expect(report).toMatchObject({
    evaluation: 'm11.6-immutable-evidence-injection-controls',
    version: '1.0.0',
    mode: 'offline-harness',
    seed: 1104,
  })
  expect(report.cases).toHaveLength(3)
  expect(
    report.cases.every(
      ({ honestControl, injectionFollowingNegativeControl }) =>
        honestControl.passed && !injectionFollowingNegativeControl.passed
    )
  ).toBe(true)
})
