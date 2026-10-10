// CP1025 (#1025) self-hosted-server profile wake/replay — BOUNDARY REPRODUCER.
//
// This file is deliberately NOT a wake/replay proof. It is the minimal
// reproducer for the missing product wiring that blocks one:
//
// - The supported self-hosted-server composition
//   (`HostedServerControlPlaneComposition`, apps/hosted-control-plane/src/composition.ts)
//   creates `RestateExecutionWorkflowDispatcher` instances internally and exposes
//   only `workflow: RemoteRestateRuntime`; it never calls
//   `bindProfileWorkflowWake` and registers no `workflow.wake` profile operation.
// - `packages/profile-adapters/src/wake.ts` requires a
//   `CurrentProfileWorkflowWakeTopologyGuard` implementation (a server-owned guard
//   proving the exact dispatcher instance). No product module implements that
//   interface, and the package ships no guard factory.
//
// A wake/replay proof through the supported composition would therefore have to
// invent a driver/guard, which the task explicitly forbids. The execution-level
// park/restart/resume path is already proven by the qualification-gated
// `apps/hosted-control-plane/src/hosted-graph.integration.test.mjs`, which needs
// externally provisioned Restate and identity environment; that is not the
// CP1025 profile wake binding either.

import { describe, expect, test } from 'bun:test'
import * as profileAdapters from '@control-plane/profile-adapters'
import { HostedServerControlPlaneComposition } from '../apps/hosted-control-plane/src/composition.ts'

describe('self-hosted-server profile wake boundary (#1025)', () => {
  test('the supported server composition exposes no profile wake binding', () => {
    const members = Object.getOwnPropertyNames(HostedServerControlPlaneComposition.prototype)
    // The lifecycle exists; a wake binding does not.
    expect(members).toContain('start')
    expect(members).toContain('close')
    expect(members.filter((member) => /wake/i.test(member))).toEqual([])
  })

  test('the profile-adapters package ships no wake topology guard implementation', () => {
    // `bindProfileWorkflowWake` is exported, but no guard implementation or
    // factory is; the composition cannot supply the server-owned guard.
    const wakeExports = Object.keys(profileAdapters)
      .filter((name) => /wake/i.test(name))
      .toSorted()
    expect(wakeExports).toEqual(['bindProfileWorkflowWake'])
  })
})
