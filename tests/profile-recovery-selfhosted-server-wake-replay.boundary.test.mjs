// CP1025 (#1025) self-hosted-server profile wake/replay boundary check.
//
// This is not a wake/replay proof. Hosted now has opt-in binder wiring for
// explicitly supplied guards and placement, but it has no authoritative actor,
// residency, or topology inputs. A product-path replay proof remains unproven.

import { describe, expect, test } from 'bun:test'
import * as profileAdapters from '@control-plane/profile-adapters'
import { HostedServerControlPlaneComposition } from '../apps/hosted-control-plane/src/composition.ts'

describe('self-hosted-server profile wake/replay boundary (#1025)', () => {
  test('the supported server composition exposes no public wake method', () => {
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
