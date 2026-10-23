import { describe, expect, it } from 'vitest'
import { tools } from './data/index.ts'
import { PHASE1_TOOL_PROBES, qualifyHostTools, type HostQualificationReport } from './host-qualification.ts'
import { visibleNavigation } from './navigation.ts'

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
    expect(qualified).toEqual(new Set(['list-accounts', 'modify-account', 'password-modification', 'manage-account-suspension', 'terminate-accounts', 'add-package', 'edit-package', 'delete-package', 'mysql-databases', 'mysql-users', 'ssl-tls-status', 'reseller-center']))
    expect(qualified.has('create-account')).toBe(false)
    expect(qualified.has('file-manager')).toBe(false)
    expect(qualified.has('email-accounts')).toBe(false)
    expect(qualified.has('ssl-install')).toBe(false)
    expect(qualified.has('webmail-message-list')).toBe(false)
    expect(qualified.has('webmail-compose')).toBe(false)
    for (const id of qualified) expect(PHASE1_TOOL_PROBES[id]?.every(probe => report.probes[probe] === 'passed')).toBe(true)
  })

  it('verifies certificate issuance when Apache and the ACME probe passed', () => {
    const report = passed('linux', { 'control-plane': 'passed', apache: 'passed', acme: 'passed' })
    const qualified = new Set(qualifyHostTools(tools, report).filter(tool => tool.status === 'verified').map(tool => tool.id))
    expect(qualified.has('ssl-install')).toBe(true)
    expect(qualified.has('ssl-tls-status')).toBe(true)
    expect(qualified.has('create-account')).toBe(false)
  })

  it('verifies the mailbox inbox when the mail probe passed', () => {
    const report = passed('linux', { 'control-plane': 'passed', mail: 'passed' })
    const qualified = new Set(qualifyHostTools(tools, report).filter(tool => tool.status === 'verified').map(tool => tool.id))
    expect(qualified.has('webmail-message-list')).toBe(true)
    expect(qualified.has('webmail-message-read')).toBe(true)
    expect(qualified.has('webmail-compose')).toBe(true)
    expect(qualified.has('webmail-folders')).toBe(false)
    expect(qualified.has('email-accounts')).toBe(true)
  })

  it('verifies phase 2 administrator tools only when their own probes passed', () => {
    const report = passed('linux', {
      'control-plane': 'passed',
      pdns: 'passed',
      backups: 'passed',
      systemd: 'passed',
      'host-info': 'passed',
    })
    const qualified = new Set(qualifyHostTools(tools, report).filter(tool => tool.status === 'verified').map(tool => tool.id))
    for (const id of ['reseller-center', 'dns-zone-manager', 'add-dns-zone', 'delete-dns-zone', 'backup-restoration', 'restart-web', 'restart-mysql', 'restart-mta', 'restart-imap', 'restart-ftp', 'restart-dns', 'server-information']) {
      expect(qualified.has(id), id).toBe(true)
    }
    for (const id of ['restart-ssh', 'aapanel-performance-test', 'backup-config', 'zone-ttl-bulk', 'create-account', 'file-manager']) {
      expect(qualified.has(id), id).toBe(false)
    }
    const root = { principal: { kind: 'root' as const, id: '00000000-0000-4000-8000-000000000001', username: 'root' } }
    const routes = visibleNavigation(root, qualifyHostTools(tools, report)).flatMap(surface => surface.sections.flatMap(section => section.pages.map(page => page.route)))
    expect(routes).toContain('/whm')
    expect(routes).toContain('/whm/monitoring/server-info')
    const withoutHost = passed('linux', { 'control-plane': 'passed', pdns: 'passed', backups: 'passed', systemd: 'passed' })
    const hidden = visibleNavigation(root, qualifyHostTools(tools, withoutHost)).flatMap(surface => surface.sections.flatMap(section => section.pages.map(page => page.route)))
    expect(hidden).not.toContain('/whm')
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
