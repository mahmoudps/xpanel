import { describe, expect, it } from 'vitest'
import { renderV2BackupDestinationsPage, renderV2BackupsPage, renderV2TransferPage, renderV2UpgradePage } from './index.ts'
import { parseMarkup } from '../../../../markup.ts'
import { translator } from '../../../../../i18n.ts'
import { escapeHtml } from '../../../html.ts'

const admitted = { locale: 'en', canRead: true, canManage: true } as const
const denied = { locale: 'en', canRead: false, canManage: false } as const
const credentials = [{ id: 'credential-internal-id', label: 'Offsite <key>', kind: 'ssh-key' }] as const

function controlTags(html: string): string[] {
  return html.match(/<(?:input|select|button)\b[^>]*>/g) ?? []
}

describe('v2 transfer workspace', () => {
  it.each(['en', 'ar'] as const)('preserves the %s approved eight-column comparison and one disabled selection owner in both scopes', locale => {
    for (const scope of ['accounts', 'server'] as const) {
      const html = renderV2TransferPage({ locale, canRead: false, canManage: false, scope })
      const beforeBody = html.slice(0, html.indexOf('data-transfer-inventory-rows'))
      const tableHead = beforeBody.slice(beforeBody.lastIndexOf('<table'))
      expect(tableHead.match(/<th\b/g)).toHaveLength(8)
      expect(tableHead).toContain('data-transfer-select-all'); expect(tableHead).toContain('type="checkbox"')
      expect(html.match(/\sdata-transfer-accounts(?:\s|>)/g)).toHaveLength(1)
      expect(html).toContain('data-transfer-inventory-rows data-transfer-accounts')
      expect(html).toContain('data-transfer-inventory-layout="comparison"')
      const prototype = html.match(/<template data-xp-template="transfer-inventory-row">([\s\S]*?)<\/template>/)![1]!
      expect(prototype.match(/<td\b/g)).toHaveLength(8)
      expect([...prototype.matchAll(/data-xp-slot="([^"]+)"/g)].map(match => match[1]).sort()).toEqual(['username', 'domain', 'uid', 'plan', 'disk', 'databases', 'mailboxes', 'conflict', 'resolution'].sort())
      expect(prototype).toContain('data-xp-action="select" disabled'); expect(prototype).toContain('data-xp-action="resolve" disabled')
      expect(html).toContain('<td colspan="8" data-xp-slot="message">')
      expect(html).not.toContain('xpanel-2020.slice'); expect(html).not.toContain('/home/alice')
    }
  })

  it('starts every native action locked until the authoritative controller reads its capabilities', () => {
    const html = renderV2TransferPage({ ...admitted, credentials })
    expect(controlTags(html).length).toBeGreaterThan(30)
    expect(controlTags(html).every(control => /\sdisabled(?:\s|>)/.test(control))).toBe(true)
    expect(html).toContain('data-transfer-status data-state="unread"')
    expect(html).toContain('No authenticated source inventory has been read.')
    expect(html).not.toContain('Connected ·')
  })

  it('carries all fields and mutation hooks needed for saved review, conflict resolution and archive import', () => {
    const html = renderV2TransferPage(admitted)
    for (const field of ['transfer-host', 'transfer-port', 'transfer-user', 'transfer-fingerprint', 'transfer-resolution-target', 'transfer-archive', 'transfer-archive-target', 'transfer-cpanel-host', 'transfer-cpanel-port', 'transfer-cpanel-user', 'transfer-cpanel-fingerprint']) {
      expect(html, field).toContain(`data-transfer-field="${field}"`)
      expect(html, field).toContain(`for="${field}"`)
    }
    for (const action of ['refresh', 'discover', 'cancel', 'create', 'select', 'resolve', 'review', 'run', 'stop', 'inspect', 'ssh-key', 'fetch', 'import-discard', 'import-run']) {
      expect(html, action).toContain(`data-transfer-${action}`)
    }
    for (const part of ['domains', 'home', 'databases', 'mail', 'dns']) expect(html).toContain(`data-transfer-import-${part}`)
    expect(html).toContain('data-transfer-import-warnings')
    expect(html).toContain('data-transfer-identities-observation')
  })

  it('escapes authorized credential labels and uses internal IDs only as option values', () => {
    const html = renderV2TransferPage({ ...admitted, credentials })
    expect(html).toContain('<option value="credential-internal-id" data-kind="ssh-key">Offsite &lt;key&gt;</option>')
    expect(html.match(/credential-internal-id/g)).toHaveLength(1)
    expect(html).not.toContain('<key>')
    expect(renderV2TransferPage({ ...denied, credentials })).not.toContain('Offsite')
  })

  it('keeps whole-server selection distinct and hides the separate account archive flow', () => {
    const html = renderV2TransferPage({ ...admitted, scope: 'server' })
    expect(html).toContain('data-transfer-scope="server" data-transfer-credentials="read"')
    expect(html).toContain('data-whm-detail-route="/whm/transfers/server"')
    expect(html).toContain('<div hidden><section class="v2-card"')
    expect(html).toContain('Whole-server migration selects every source account and plan.')
  })
})

describe('v2 backup workspace', () => {
  it.each(['/whm/backups', '/whm/backups/restore'] as const)('starts the route-appropriate local panel and keeps tabs outside the native disable fence: %s', activeRoute => {
    const html = renderV2BackupsPage({ ...admitted, activeRoute })
    const initial = activeRoute === '/whm/backups/restore' ? 'restore' : 'settings'
    for (const key of ['settings', 'restore', 'runs']) {
      expect(html).toContain(`id="v2-backup-tab-${key}" aria-selected="${key === initial}" aria-controls="v2-backup-panel-${key}"`)
      expect(html).toContain(`id="v2-backup-panel-${key}" aria-labelledby="v2-backup-tab-${key}" tabindex="0"${key === initial ? '' : ' hidden'}`)
    }
    expect(html.indexOf('data-presentation-tab="settings"')).toBeLessThan(html.indexOf('data-approved-whm-backups'))
    expect(html.match(/data-backup-section="restore"/g)).toHaveLength(1)
    expect(html.match(/id="backup-layout-restore-acknowledge"/g)).toHaveLength(1)
    expect(html).toContain('data-backup-native="unavailable"')
  })
  it('preserves unread versus an authorized empty account list', () => {
    expect(renderV2BackupsPage(admitted)).toContain('The account list has not been read.')
    expect(renderV2BackupsPage({ ...admitted, accounts: [] })).toContain('No accounts were returned by the authorized read.')
  })

  it('mounts the local archive list with its controls, row template and manager admission', () => {
    const account = { username: 'alice', primaryDomain: 'alice.example' }
    const managed = renderV2BackupsPage({ ...admitted, accounts: [account] })
    expect(managed).toContain('data-account-backups data-backup-manage="true"')
    expect(managed).toContain('<option value="alice">alice</option>')
    for (const hook of ['data-backup-account disabled', 'data-backup-local-read disabled', 'data-backup-create disabled', 'data-backup-files', 'data-backup-status', 'data-backup-unread-note']) expect(managed).toContain(hook)
    const template = /<template data-xp-template="whm-local-archive-row"><tr>(.*?)<\/tr><\/template>/.exec(managed)?.[1] ?? ''
    expect(template).toContain('<bdi class="v2-mono" dir="ltr" data-xp-slot="archive"></bdi>')
    expect(template).toContain('data-xp-slot="bytes"')
    expect(template).toContain('<a class="v2-btn" href="/whm/backups/files" data-xp-slot="review"></a>')
    expect(managed).not.toContain('Local archive actions require the guarded preview')
    const forbidden = renderV2BackupsPage({ ...denied, accounts: [account] })
    expect(forbidden).not.toContain('alice')
    expect(forbidden).toContain('data-account-backups data-backup-manage="false"')
    expect(forbidden).toContain('data-backup-read-state="denied"')
  })

  it('keeps retention bounds and required policy/destination fields on the client-owned IDs', () => {
    const html = renderV2BackupsPage(admitted)
    for (const key of ['policy-enabled', 'policy-cron', 'daily-copies', 'weekly-copies', 'monthly-copies', 'include-databases', 'include-mail', 'include-dns', 'include-control', 'start-time', 'frequency', 'policy-compress']) {
      expect(html, key).toContain(`id="backup-layout-${key}"`)
    }
    expect(html).toContain('id="backup-layout-monthly-copies" type="number" dir="ltr" min="0" max="240" step="1" disabled')
    expect(html).toContain('data-destination-rows')
    expect(html).toContain('data-backup-snapshot-pager')
    expect(html).toContain('data-backup-difference-rows')
  })

  it('emits one copy of every restore field and preserves the account/part review boundary', () => {
    const html = renderV2BackupsPage({ ...admitted, activeRoute: '/whm/backups/restore' })
    expect(html.match(/data-backup-section="restore"/g)).toHaveLength(1)
    expect(html.match(/id="backup-layout-restore-acknowledge"/g)).toHaveLength(1)
    expect(html).toContain('data-backup-part-availability')
    expect(html).toContain('data-backup-restore-status')
    expect(html).toContain('role="radiogroup" aria-labelledby="v2-backup-run-choice" data-backup-restore-runs')
    expect(html).toContain('role="radiogroup" aria-labelledby="v2-backup-account-choice" data-backup-restore-accounts')
    expect(html).toContain('id="backup-layout-restore-search" type="search" dir="ltr">')
    expect(html).not.toContain('data-step-status')
    expect(html).toContain('The control-database snapshot is for disaster recovery and upgrade rollback; it must never be restored per account.')
  })
})

describe('v2 upgrade workspace', () => {
  it('cannot claim a release, preflight or accepted upgrade before a host read', () => {
    const html = renderV2UpgradePage(admitted)
    expect(controlTags(html).every(control => /\sdisabled(?:\s|>)/.test(control))).toBe(true)
    expect(html).toContain('No verified staged release has been read')
    expect(html).toContain('No upgrade has been requested from this page.')
    expect(html).not.toContain('Signature verified')
    expect(html.match(/data-upgrade-check="/g)).toHaveLength(5)
    expect(html.match(/data-upgrade-phase="/g)).toHaveLength(7)
  })

  it('retains the native details confirmation and version-specific phrase hook', () => {
    const html = renderV2UpgradePage({ ...admitted, hostname: '<server>' })
    expect(html).toContain('<details class="v2-lifecycle__group" data-upgrade-confirm>')
    expect(html).toContain('data-upgrade-fact="confirm-phrase">upgrade</bdi>')
    expect(html).toContain('data-upgrade-confirm-input disabled')
    expect(html).toContain('&lt;server&gt;')
    expect(renderV2UpgradePage({ ...denied, hostname: 'private.example' })).not.toContain('private.example')
  })
})

describe('v2 backup destination lifecycle', () => {
  it('uses a real form only for an authorized mutation context and accepts credential references only', () => {
    const html = renderV2BackupDestinationsPage(admitted)
    expect(html).toContain('<form data-destination-form')
    expect(html).toContain('data-destination-field="credentialRef"')
    expect(html).toContain('data-destination-public-key hidden')
    expect(html).not.toMatch(/type="password"|data-destination-field="(?:privateKey|password|token)"/)
    expect(renderV2BackupDestinationsPage(denied)).toContain('<div data-destination-form')
    expect(renderV2BackupDestinationsPage(denied)).toContain('data-can-manage="false"')
    expect(controlTags(html).every(control => /\sdisabled(?:\s|>)/.test(control))).toBe(true)
  })

  it('keeps copies, recoveries and retention distinct from unread run history', () => {
    const html = renderV2BackupDestinationsPage(admitted)
    for (const key of ['runs', 'copies', 'recoveries', 'retention']) {
      expect(html).toContain(`data-backup-runs-rows="${key}"`)
      expect(html).toContain(`data-backup-runs-empty="${key}" hidden`)
    }
    for (const key of ['runs-status', 'runs-loading', 'runs-read', 'runs-start', 'retention-destination', 'retention-preview', 'retention-apply', 'retention-status']) expect(html).toContain(`data-backup-${key}`)
    expect(html).toContain('Backup runs have not been read.')
    expect(html).toContain('No verified remote copy is recorded.')
  })
})

describe('v2 lifecycle presentation boundary', () => {
  it('uses only v2 styling classes and renders Arabic with ASCII digits', () => {
    for (const render of [renderV2BackupsPage, renderV2BackupDestinationsPage, renderV2TransferPage, renderV2UpgradePage]) {
      const html = render({ locale: 'ar', canRead: true, canManage: true })
      expect(html).toContain('lang="ar" dir="rtl"')
      expect(html).not.toMatch(/class="[^"]*\bxp-/)
      expect(html).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
    }
  })
})

describe('v2 local account archive scope warning', () => {
  it.each(['en', 'ar'] as const)('scopes the %s exclusion notice to the local archive list on both backup routes', locale => {
    const message = 'This local archive workflow copies home files and excludes the standard mail data and mail settings directories. It does not create database dumps or capture DNS zones. Review a component backup for those parts.'
    for (const activeRoute of ['/whm/backups', '/whm/backups/restore'] as const) {
      const html = renderV2BackupsPage({ locale, canRead: true, canManage: true, activeRoute })
      const nodes = parseMarkup(html)
      const notices = nodes.filter(node => node.namespace === 'html' && node.template === -1 && node.attrs.has('data-local-archive-scope-warning'))
      expect(notices).toHaveLength(1)
      const notice = notices[0]
      if (!notice) throw new Error('missing_local_archive_scope_warning')
      expect(notice.tag).toBe('p')
      const ancestors: (typeof nodes)[number][] = []
      for (let index = notice.parent; index >= 0;) {
        const ancestor = nodes[index]
        if (!ancestor) throw new Error('missing_local_archive_warning_ancestor')
        ancestors.push(ancestor)
        index = ancestor.parent
      }
      expect(ancestors.some(node => node.attrs.has('data-account-backups'))).toBe(true)
      expect(ancestors.some(node => node.attrs.get('data-backup-section') === 'restore')).toBe(false)
      expect(nodes.filter(node => node.attrs.has('data-local-archive-scope-warning'))).toHaveLength(1)
      const paragraphs = [...html.matchAll(/<p\b[^>]*\bdata-local-archive-scope-warning(?=[\s>])[^>]*>([^<]*)<\/p>/g)]
      expect(paragraphs).toHaveLength(1)
      expect(paragraphs[0]?.[1]).toBe(escapeHtml(translator(locale)(message)))
      expect(nodes.filter(node => node.namespace === 'html' && node.template === -1 && node.attrs.has('data-account-backups'))).toHaveLength(1)
      // The local archive client enables these for a manager; the document starts them closed.
      for (const key of ['data-backup-account', 'data-backup-local-read', 'data-backup-create']) {
        const controls = nodes.filter(node => node.namespace === 'html' && node.template === -1 && node.attrs.has(key))
        expect(controls).toHaveLength(1)
        expect(controls[0]?.attrs.has('disabled')).toBe(true)
      }
      const restoreActions = nodes.filter(node => node.namespace === 'html' && node.template === -1 && node.attrs.get('data-backup-action') === 'restore-apply')
      expect(restoreActions).toHaveLength(1)
      expect(restoreActions[0]?.attrs.has('disabled')).toBe(true)
      expect(nodes.filter(node => node.namespace === 'html' && node.template === -1 && node.attrs.get('data-backup-section') === 'restore')).toHaveLength(1)
    }
  })
})


describe('inline destination composition', () => {
  it.each(['en', 'ar'] as const)('keeps the complete real destination editor inside both backup routes in %s', locale => {
    for (const activeRoute of ['/whm/backups', '/whm/backups/restore'] as const) {
      const html = renderV2BackupsPage({ locale, canRead: true, canManage: true, activeRoute })
      const nodes = parseMarkup(html), live = nodes.filter(node => node.namespace === 'html' && node.template === -1)
      expect(live.filter(node => node.attrs.has('data-backup-inline-manager'))).toHaveLength(1)
      expect(live.filter(node => node.attrs.has('data-destination-form') && node.tag === 'form')).toHaveLength(1)
      for (const field of ['name','kind','endpoint','pathPrefix','bucket','region','username','retentionDays','credentialRef']) expect(live.filter(node => node.attrs.get('data-destination-field') === field)).toHaveLength(1)
      expect(live.filter(node => node.attrs.has('data-destination-sftp-projection'))).toHaveLength(1)
      const host = live.find(node => node.attrs.has('data-destination-sftp-host'))!, port = live.find(node => node.attrs.has('data-destination-sftp-port'))!
      expect(host).toBeDefined(); expect(port).toBeDefined(); expect(host.tag).toBe('input'); expect(port.tag).toBe('input')
      expect(host.attrs.get('type')).toBe('text'); expect(port.attrs.get('type')).toBe('number')
      expect(port.attrs.get('min')).toBe('1'); expect(port.attrs.get('max')).toBe('65535'); expect(port.attrs.get('step')).toBe('1')
      for (const field of [host, port]) {
        expect(field.attrs.get('dir')).toBe('ltr'); expect(field.attrs.has('disabled')).toBe(true); expect(field.attrs.has('required')).toBe(true)
        expect(live.filter(node => node.tag === 'label' && node.attrs.get('for') === field.attrs.get('id'))).toHaveLength(1)
      }
      const ids = live.flatMap(node => node.attrs.has('id') ? [node.attrs.get('id')!] : []); expect(new Set(ids).size).toBe(ids.length)
      expect(live.some(node => node.attrs.get('id') === 'backup-layout-destination-enabled')).toBe(false)
      expect(html).toContain('data-xp-action="test" disabled'); expect(html).toContain('data-xp-action="activate" disabled')
      expect(html).toContain('data-backup-destination-editor="manager"'); expect(html).toContain('data-backup-destination-choices')
      expect(html).toContain('data-backup-action="refresh"'); expect(html).toContain('data-backup-workspace-status'); expect(html).not.toContain('type="password"')
    }
  })
})


describe('backup capability source parity', () => {
  for (const locale of ['en','ar'] as const) it('binds destination capability to actual read admission in ' + locale, { tags: ['unit'] }, () => {
    for (const canRead of [false,true]) for (const canManage of [false,true]) {
      const html=renderV2BackupDestinationsPage({locale,canRead,canManage});
      const nodes=parseMarkup(html),owners=nodes.filter(node=>node.attrs.get('data-whm-detail-route')==='/whm/backups/destinations');
      expect(owners).toHaveLength(1);
      const owner=owners[0];if(!owner)throw new Error('Missing destination page root');
      expect(owner.attrs.get('data-capability-state')).toBe(canRead?'authorized':'unavailable');
      const manager=nodes.find(node=>node.attrs.has('data-whm-backup-destinations'));
      const runs=nodes.find(node=>node.attrs.has('data-whm-backup-runs'));
      if(!manager||!runs)throw new Error('Missing real destination/run owners');
      expect(manager.attrs.get('data-can-manage')).toBe(String(canRead&&canManage));
      expect(runs.attrs.get('data-can-manage')).toBe(String(canRead&&canManage));
      expect(html).toContain('data-destination-form');
      expect(html).toContain('data-backup-retention-preview');
      expect(html).toContain('data-backup-runs-status');
    }
  });
});

describe('v2 lifecycle board regions', () => {
  const rulesOf = (html: string): string[] => html.match(/<ul class="v2-lifecycle__rules">.*?<\/ul>/gs) ?? []

  it('links the backup pages to each other and to the audit log from the header', () => {
    const backups = renderV2BackupsPage({ ...admitted, locale: 'ar' })
    expect(backups).toContain('<a class="v2-btn" href="/whm/backups/destinations?lang=ar">')
    expect(backups).toContain('<a class="v2-btn" href="/whm/audit?lang=ar">')
    expect(renderV2BackupDestinationsPage(admitted)).toContain('<a class="v2-btn" href="/whm/backups?lang=en">')
  })

  it('shows the four backup summary tiles unread and the restore rules as a checked list', () => {
    const html = renderV2BackupsPage(admitted)
    expect(html.match(/<dd data-backup-summary="(?:last|next|local|remote)">Not read<\/dd>/g)).toHaveLength(4)
    expect(html.match(/<span class="v2-tile v2-tile--neutral" aria-hidden="true">/g)).toHaveLength(4)
    expect(rulesOf(html)).toHaveLength(1)
    expect(rulesOf(html)[0]!.match(/<li><svg\b/g)).toHaveLength(5)
  })

  it('keeps one destination editor beside the list and the local archives as a strip after them on the backups page, and strips on its own page', () => {
    const inline = renderV2BackupsPage(admitted)
    expect(inline.match(/data-destination-form/g)).toHaveLength(1)
    expect(inline).toContain('class="v2-lifecycle__grid v2-lifecycle__grid--editor"')
    expect(inline.indexOf('data-destination-rows')).toBeLessThan(inline.indexOf('data-destination-form'))
    expect(inline.indexOf('data-destination-form')).toBeLessThan(inline.indexOf('data-account-backups'))
    expect(renderV2BackupDestinationsPage(admitted)).not.toContain('v2-lifecycle__grid')
  })

  it('maps the four transfer steps to their cards and offers the archive import only in the account scope', () => {
    const html = renderV2TransferPage(admitted)
    for (const key of ['transfer-source', 'transfer-selection', 'transfer-plans', 'transfer-run']) {
      expect(html).toContain(`<a href="#v2-lifecycle-${key}">`)
      expect(html).toContain(`id="v2-lifecycle-${key}"`)
    }
    expect(html).not.toContain('aria-current="step"')
    expect(html).toContain('<a class="v2-btn" href="#v2-lifecycle-transfer-import">')
    expect(renderV2TransferPage({ ...admitted, scope: 'server' })).not.toContain('href="#v2-lifecycle-transfer-import"')
  })

  it('states the automatic rollback with an unread snapshot folder and lists the phases without a current step', () => {
    const html = renderV2UpgradePage(admitted)
    const rollback = html.slice(html.indexOf('id="v2-lifecycle-upgrade-rollback"'), html.indexOf('id="v2-lifecycle-upgrade-boundaries"'))
    expect(rollback).toContain('<bdi dir="ltr" data-upgrade-fact="snapshot-dir">Not read</bdi>')
    expect(html.match(/data-upgrade-fact="snapshot-dir"/g)).toHaveLength(1)
    expect(html).toContain('<a class="v2-btn" href="#v2-lifecycle-upgrade-history">')
    expect(html).toContain('id="v2-lifecycle-upgrade-history"')
    const steps = html.match(/<ol class="v2-lifecycle__steps"[^>]*>.*?<\/ol>/s)?.[0] ?? ''
    expect(steps.match(/<li>/g)).toHaveLength(6)
    expect(steps).not.toContain('aria-current')
  })

  it('gives the run controller of the destinations page its four row templates', () => {
    const html = renderV2BackupDestinationsPage(admitted)
    const runs = html.slice(html.indexOf('data-whm-backup-runs'))
    const expected = { runs: ['started', 'trigger', 'state', 'copies', 'mail', 'retention'], copies: ['account', 'destination', 'archive', 'size', 'started', 'action'], recoveries: ['started', 'account', 'archive', 'state'], retention: ['archive', 'account', 'created', 'size', 'plan'] }
    for (const [kind, slots] of Object.entries(expected)) {
      const template = runs.split(`<template data-xp-template="whm-backup-${kind}-row"><tr>`)[1]?.split('</tr></template>')[0] ?? ''
      expect([...template.matchAll(/data-xp-slot="([a-z]+)"/g)].map(match => match[1])).toEqual(slots)
    }
    expect(runs).toContain('<button type="button" class="v2-btn" data-xp-slot="action" disabled></button>')
    expect(html.split('data-xp-template="whm-backup-runs-row"')).toHaveLength(2)
  })

  it('names the phone row cells from the translated headers and keeps transfer templates free of style', () => {
    const saved = renderV2BackupDestinationsPage({ ...admitted, locale: 'ar' }).split('<tbody data-destination-rows')[0]!.split('<table').at(-1)!
    expect(saved).toContain('data-phone-value="4"')
    expect(saved).toMatch(/style="--c1:&#39;\p{Script=Arabic}/u)
    const transfer = renderV2TransferPage(admitted)
    expect(transfer).toContain('<table class="v2-lifecycle__table" style="--c1:&#39;Select&#39;;--c2:&#39;Account&#39;;--c3:&#39;Plan&#39;;--c4:&#39;Disk&#39;;--c5:&#39;Databases&#39;;--c6:&#39;Mailboxes&#39;;--c7:&#39;Conflict&#39;;--c8:&#39;Resolution&#39;" data-phone-value="1" data-phone-name="2">')
    const templates = parseMarkup(transfer).filter(node => node.template >= 0)
    expect(templates.length).toBeGreaterThan(0)
    expect(templates.some(node => node.attrs.has('style'))).toBe(false)
    expect(transfer).toContain('<div data-transfer-review-results style="--c1:&#39;Source account&#39;')
    expect(renderV2UpgradePage(admitted)).toContain('<table class="v2-lifecycle__table" style="--c1:&#39;Check&#39;;--c2:&#39;Result&#39;;--c3:&#39;Observed&#39;" data-phone-value="2">')
  })
})
