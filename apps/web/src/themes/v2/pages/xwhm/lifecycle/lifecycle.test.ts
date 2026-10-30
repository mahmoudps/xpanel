import { describe, expect, it } from 'vitest'
import { renderV2BackupDestinationsPage, renderV2BackupsPage, renderV2TransferPage, renderV2UpgradePage } from './index.ts'

const admitted = { locale: 'en', canRead: true, canManage: true } as const
const denied = { locale: 'en', canRead: false, canManage: false } as const
const credentials = [{ id: 'credential-internal-id', label: 'Offsite <key>', kind: 'ssh-key' }] as const

function controlTags(html: string): string[] {
  return html.match(/<(?:input|select|button)\b[^>]*>/g) ?? []
}

describe('v2 transfer workspace', () => {
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
  it('preserves unread versus an authorized empty account list', () => {
    expect(renderV2BackupsPage(admitted)).toContain('The account list has not been read.')
    expect(renderV2BackupsPage({ ...admitted, accounts: [] })).toContain('No accounts were returned by the authorized read.')
  })

  it('does not mount the legacy local archive client before restore gains a preview and confirmation boundary', () => {
    const account = { username: 'alice', primaryDomain: 'alice.example' }
    const unread = renderV2BackupsPage({ ...admitted, accounts: [account] })
    expect(unread).not.toContain(' data-account-backups>')
    expect(unread).toContain('data-backup-native="unavailable"')
    expect(unread).toContain('data-backup-create disabled>Create backup</button>')
    expect(unread).toContain('Local archive actions require the guarded preview and confirmation workflow')
    const forbidden = renderV2BackupsPage({ ...denied, accounts: [account] })
    expect(forbidden).not.toContain('alice')
    expect(forbidden).not.toContain(' data-account-backups>')
    expect(forbidden).toContain('data-backup-read-state="denied"')
  })

  it('keeps retention bounds and required policy/destination fields on the client-owned IDs', () => {
    const html = renderV2BackupsPage(admitted)
    for (const key of ['policy-enabled', 'policy-cron', 'daily-copies', 'weekly-copies', 'monthly-copies', 'include-databases', 'include-mail', 'include-dns', 'include-control', 'start-time', 'frequency', 'policy-compress', 'destination-name', 'destination-endpoint', 'destination-prefix', 'destination-bucket', 'destination-region', 'destination-user', 'destination-retention', 'destination-enabled', 'destination-kind']) {
      expect(html, key).toContain(`id="backup-layout-${key}"`)
    }
    expect(html).toContain('id="backup-layout-monthly-copies" type="number" dir="ltr" min="0" max="240" step="1" disabled')
    expect(html).toContain('data-backup-destination-rows')
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
