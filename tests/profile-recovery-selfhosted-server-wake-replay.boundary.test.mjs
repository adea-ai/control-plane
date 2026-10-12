// CP1025 (#1025) self-hosted-server profile wake/replay boundary check.
//
// This is not a wake/replay proof. The package has a retained-record binder, but
// the hosted-server composition still exposes no profile-wake API or trusted
// topology-guard factory. A successful product-path replay proof remains unproven.

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
    expect(wakeExports).toEqual(['bindProfileWorkflowWake', 'bindRetainedProfileWorkflowWake'])
  })
})
