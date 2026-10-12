// CP1025 (#1025) self-hosted-server profile wake/replay boundary check.
//
// This is not a wake/replay proof. It records the current public product boundary:
// the hosted-server composition exposes no profile-wake API, and the profile
// adapters package exports the binder but no wake topology-guard factory. A
// successful replay proof through the supported product path remains unproven.

import { describe, expect, test } from 'bun:test'
import * as profileAdapters from '@control-plane/profile-adapters'
import { HostedServerControlPlaneComposition } from '../apps/hosted-control-plane/src/composition.ts'

describe('self-hosted-server profile wake/replay boundary (#1025)', () => {
  test('the supported server composition exposes no profile-wake member', () => {
    const members = Object.getOwnPropertyNames(HostedServerControlPlaneComposition.prototype)
    expect(members).toContain('start')
    expect(members).toContain('close')
    expect(members.filter((member) => /wake/i.test(member))).toEqual([])
  })

  test('the profile-adapters package exports no wake topology-guard factory', () => {
    const wakeExports = Object.keys(profileAdapters)
      .filter((name) => /wake/i.test(name))
      .toSorted()
    expect(wakeExports).toEqual(['bindProfileWorkflowWake'])
  })
})
