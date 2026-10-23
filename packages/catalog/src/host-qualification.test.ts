import { describe, expect, it } from 'vitest'
import { tools } from './data/index.ts'
import { PHASE1_TOOL_PROBES, qualifyHostTools, type HostQualificationReport } from './host-qualification.ts'

const passed = (executor: HostQualificationReport['executor'], probes: HostQualificationReport['probes']): HostQualificationReport =>
  ({ executor, probes })

describe('host qualification', () => {
  it('leaves the production catalog unqualified', () => {
    expect(tools.filter(tool => tool.status === 'verified')).toEqual([])
    expect(qualifyHostTools(tools, null).filter(tool => tool.status === 'verified')).toEqual([])
    expect(qualifyHostTools(tools, passed('fake', { 'control-plane': 'passed', apache: 'passed', 'linux-account': 'passed' })).filter(tool => tool.status === 'verified')).toEqual([])
  })

  it('verifies only implemented tools whose probes passed', () => {
    const report = passed('linux', {
      'control-plane': 'passed',
      'linux-account': 'passed',
      apache: 'failed',
      mariadb: 'passed',
      mail: 'failed',
      files: 'failed',
    })
    const qualified = new Set(qualifyHostTools(tools, report).filter(tool => tool.status === 'verified').map(tool => tool.id))
    expect(qualified).toEqual(new Set(['list-accounts', 'modify-account', 'password-modification', 'manage-account-suspension', 'terminate-accounts', 'add-package', 'edit-package', 'delete-package', 'mysql-databases', 'mysql-users', 'ssl-tls-status']))
    expect(qualified.has('create-account')).toBe(false)
    expect(qualified.has('file-manager')).toBe(false)
    expect(qualified.has('email-accounts')).toBe(false)
    for (const id of qualified) expect(PHASE1_TOOL_PROBES[id]?.every(probe => report.probes[probe] === 'passed')).toBe(true)
  })

  it('stays unqualified when the operator turns host qualification off', () => {
    const previous = process.env.XPANEL_HOST_QUALIFICATION
    process.env.XPANEL_HOST_QUALIFICATION = 'off'
    try {
      const report = passed('linux', { 'control-plane': 'passed' })
      expect(qualifyHostTools(tools, report).some(tool => tool.status === 'verified')).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.XPANEL_HOST_QUALIFICATION
      else process.env.XPANEL_HOST_QUALIFICATION = previous
    }
  })
})
