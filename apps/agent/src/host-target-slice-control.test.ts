import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { createProductionHostTargetMatcher, isSliceControlDirPath } from './executor.ts'

/**
 * Account termination removes the systemd control drop-in directories of the account slice and its
 * logind user slice. Those live under /etc/systemd/system.control and /run/systemd/system.control,
 * outside the normal unit search path, and the production host-target matcher must admit exactly
 * those generated paths (and nothing else in those trees).
 */
describe('production host-target matcher slice control paths', { tags: ['unit'] }, () => {
  const match = createProductionHostTargetMatcher()

  it('admits removal of the generated account slice control drop-in directories', () => {
    for (const uid of [20002, 20010, 60000]) {
      assert.equal(match(`/etc/systemd/system.control/xpanel-${uid}.slice.d`, 'remove'), true)
      assert.equal(match(`/run/systemd/system.control/xpanel-${uid}.slice.d`, 'remove'), true)
    }
  })

  it('keeps unrelated system.control content outside the grant', () => {
    assert.equal(match('/etc/systemd/system.control/sshd.service.d', 'remove'), false)
    assert.equal(match('/etc/systemd/system.control/xpanel-20002.service.d', 'remove'), false)
    assert.equal(match('/run/systemd/system.control/user-20002.slice.d', 'remove'), false)
  })
})

describe('slice-control tree removal predicate', { tags: ['unit'] }, () => {
  it('admits only the exact generated slice drop-in directories', () => {
    assert.equal(isSliceControlDirPath('/etc/systemd/system.control/xpanel-20002.slice.d'), true)
    assert.equal(isSliceControlDirPath('/run/systemd/system.control/xpanel-60000.slice.d'), true)
    for (const path of ['/etc/systemd/system.control/sshd.service.d', '/etc/systemd/system.control/xpanel-20002.slice.d/sub',
      '/etc/systemd/system/xpanel-20002.slice.d', '/etc/systemd/system.control/user-20002.slice.d']) {
      assert.equal(isSliceControlDirPath(path), false, path)
    }
  })
})