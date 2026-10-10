import { expect, test } from 'bun:test'
import { agentProfileStateNotice } from '../../src/agent-profile-state'

test('an unconfigured workspace lead is described as unselected, not a missing version', () => {
  const notice = agentProfileStateNotice({
    id: 'workspace-lead-unconfigured',
    state: 'missing',
    version: 'unconfigured',
  })
  expect(notice).toContain('No profile is selected')
  expect(notice).not.toContain('version is missing')
})

test('other missing profile versions keep the version-specific notice', () => {
  expect(agentProfileStateNotice({ id: 'general', state: 'missing', version: '3' })).toBe(
    'This profile version is missing. Choose an approved, compatible version in Customize.'
  )
})

test('available and unavailable profiles keep their existing notices', () => {
  expect(agentProfileStateNotice({ id: 'general', state: 'available', version: '3' })).toBe(
    'The selected profile version is configured.'
  )
  expect(agentProfileStateNotice({ id: 'general', state: 'unavailable', version: '3' })).toContain(
    'Profile check unavailable'
  )
})
