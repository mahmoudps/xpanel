import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { arabicFileCount, xmailComposeFromProps } from './board-port/xmail-compose.ts'
import { xmailInboxFromProps, renderInbox } from './board-port/xmail-inbox.ts'
import { whmDashboardFromProps } from './board-port/xwhm-dashboard.ts'
import { xpanelHomeFromProps } from './board-port/xpanel-home.ts'
import { auditOutcomeLabel, auditTargetLabel } from './audit-labels.ts'
import { formatAsciiBytes } from './tokens.ts'
import { certificateFromPem, readHostIdentity, sslCertificateForListen } from '../../agent/src/host-identity.ts'
import { parseVersionFile } from '../../agent/src/host-info.ts'

const message = {
  uid: 4,
  folder: 'INBOX',
  from: 'lina@example.test',
  fromName: 'Lina Saleh',
  to: 'info@example.test',
  cc: 'sam@example.test',
  subject: 'Hello مرحبا',
  preview: 'see you. 1.',
  body: 'see you. 1.',
  receivedAt: '2026-10-22T14:30:00.000Z',
  unread: true,
  attachments: [{ name: 'plan.pdf', sizeBytes: 2048 }],
}

describe('live truth surfaces', () => {
  it('wires delete and move to the server and updates the unread badge', () => {
    const model = xmailInboxFromProps({
      mailbox: 'info@example.test',
      messages: [message, { ...message, uid: 5, unread: false, fromName: 'Sam', attachments: [] }],
      folderCounts: [
        { folder: 'INBOX', total: 2, unread: 1 },
        { folder: 'Drafts', total: 1, unread: 0 },
      ],
      vacationEnabled: false,
    })
    const html = renderInbox(model)
    assert.match(html, /data-product="true"/)
    assert.match(html, /data-mail-count="Drafts"/)
    assert.match(html, />1</)
    assert.match(html, /href="\/mail\/inbox\?folder=Drafts"/)
    assert.match(html, /href="\/mail\/inbox\?folder=Sent"/)
    assert.match(html, /Lina Saleh/)
    assert.match(html, /sam@example.test/)
    assert.match(html, /plan\.pdf/)
    assert.match(html, /2,048 B/)
    const decoded = renderInbox(xmailInboxFromProps({
      mailbox: 'info@example.test',
      messages: [{ ...message, attachments: [{ name: 'note.txt', sizeBytes: 1240 }] }],
    }))
    assert.match(decoded, /1,240 B/)
    assert.equal(decoded.includes('1.70 KB'), false)
    assert.match(html, /mode=reply/)
    assert.match(html, /<bdi dir="auto">/)
    assert.match(html, /DKIM: not checked/)
    assert.match(html, /Off/)
    assert.match(html, /xpanelSessionRequest\('DELETE'/)
    assert.match(html, /\/move/)
    assert.match(html, /data-mail-count="INBOX"/)
    assert.equal(html.includes('TLS ServerName'), false)
    const script = html.slice(html.indexOf('xmail-inbox-client'))
    assert.match(script, /pending\.then/)
    assert.match(script, /removeAttribute\('data-removed'\)/)
  })

  it('uses Arabic pager and file plurals', () => {
    assert.equal(arabicFileCount(0), 'لا ملفات')
    assert.equal(arabicFileCount(1), 'ملف واحد')
    assert.equal(arabicFileCount(2), 'ملفان')
    assert.equal(arabicFileCount(3), '3 ملفات')
    assert.equal(arabicFileCount(11), '11 ملفاً')
    const html = renderInbox(xmailInboxFromProps({
      locale: 'ar',
      mailbox: 'info@example.test',
      messages: [message],
      vacationEnabled: false,
    }))
    assert.match(html, /من/)
    assert.match(html, /غير مقروءة/)
    assert.equal(html.includes(' of '), false)
    assert.equal(html.includes('Unread.'), false)
  })

  it('fills a reply draft and shows the size limit that was read', () => {
    const html = xmailComposeFromProps({
      mailbox: 'info@example.test',
      identitySize: '10 MB',
      identityDkim: 'not signed',
      identitySpf: 'SPF record missing · DMARC record missing',
      vacationEnabled: false,
      folderCounts: [{ folder: 'Drafts', total: 1, unread: 0 }],
      draft: { to: 'lina@example.test', cc: 'sam@example.test', subject: 'Re: Hello', body: '\n\n> See you' },
    })
    const rendered = html.subject
    assert.equal(rendered, 'Re: Hello')
    assert.equal(html.chips.map(chip => chip.addr).join(','), 'lina@example.test,sam@example.test')
    const named = xmailComposeFromProps({
      mailbox: 'info@example.test',
      draft: { to: 'Lina Saleh <lina@example.test>', cc: 'Sam Idris <sam@example.test>' },
    })
    assert.equal(named.chips[0]?.name, 'Lina Saleh')
    assert.equal(named.chips[1]?.name, 'Sam Idris')
    assert.equal(named.chips[1]?.addr, 'sam@example.test')
    assert.match(html.bodyHtml, /&gt; See you/)
    assert.match(html.identitySize, /10 MB/)
    assert.match(html.identityDkim, /not signed/)
    assert.equal(html.vacationStatus, 'Off')
    assert.equal(html.folders.find(folder => folder.label === 'Drafts')?.count?.text, '1')
  })

  it('lists certificate days, the disk percent, and a human audit row', () => {
    const model = whmDashboardFromProps({
      locale: 'en',
      principal: { username: 'root' },
      hostname: 'host.example.test',
      generationId: 142,
      generationActivatedAt: '2026-10-23T10:00:00.000Z',
      now: Date.parse('2026-10-23T00:00:00.000Z'),
      certificates: [{ names: ['panel.example.test'], notAfter: '2026-10-29T10:30:00.000Z' }],
      nearLimits: [],
      hostSample: {
        hostname: 'host.example.test',
        panelDomain: 'panel.example.test',
        system: 'Ubuntu 24.04.3 LTS',
        panelVersion: '0.1.0-xmail.20261024.1',
        disk: { mount: '/', totalBytes: 161_000_000_000, usedBytes: 40_000_000_000, availableBytes: 121_000_000_000 },
      },
      auditEntries: [{
        id: '1', at: '2026-10-23T10:00:00.000Z', actor: 'root', action: 'auth.login',
        target: 'principal:11111111-1111-1111-1111-111111111111', detail: {}, outcome: 'ok',
      }],
      accounts: [{ status: 'active' }] as never,
      plans: [{ id: 'p' }] as never,
    })
    assert.equal(model.hostRows.find(row => row.label === 'System')?.value, 'Ubuntu 24.04.3 LTS')
    assert.equal(model.hostRows.find(row => row.label === 'xPanel')?.value, '0.1.0-xmail.20261024.1')
    assert.equal(model.hostRows.find(row => row.label === 'Panel domain')?.value, 'panel.example.test')
    assert.equal(model.meters[2]?.note, '25%')
    assert.match(model.reconcilerTiles.find(tile => tile.label === 'Active generation')?.note ?? '', /Activated/)
    assert.equal(model.near[0]?.name, 'None')
    assert.equal(model.audit[0]?.result.label, 'Signed in')
    assert.equal(model.audit[0]?.target, 'An internal record')
    assert.equal(model.audit[0]?.target.includes('principal:'), false)
    assert.match(model.notices[0]?.html ?? '', /panel\.example\.test/)
    assert.match(model.notices[0]?.html ?? '', /7 days/)
    assert.equal(model.notices[0]?.tone, 'warn')
    assert.match(model.accountsSentence, /1 account/)
    const arabic = whmDashboardFromProps({
      locale: 'ar',
      accounts: [{ status: 'active' }, { status: 'active' }] as never,
      plans: [{ id: 'p' }, { id: 'q' }, { id: 'r' }] as never,
    })
    assert.match(arabic.accountsSentence, /حسابان/)
    assert.match(arabic.accountsSentence, /خطط/)
    assert.equal(arabic.accountsSentence.includes('حساباً'), false)
  })

  it('formats the IO cap in decimal units and shows the last sign-in', () => {
    assert.equal(formatAsciiBytes(50_000_000), '50.0 MB')
    const home = xpanelHomeFromProps({
      account: { username: 'demohost', uid: 1001, home: '/home/demohost', primaryDomain: 'demo.example.test', ipv4: '192.0.2.10' },
      plan: { name: 'Demo', resources: { diskMb: 1000, bandwidthMbMonth: 1000, memoryMb: 512, maxProcesses: 20, ioWriteBps: 50_000_000 }, caps: { addonDomains: 5, mailboxes: 20, databases: 5 } },
      serviceUsers: [{ services: { email: true, ftp: false } }],
      lastSignInAt: '2026-10-23T18:04:00.000Z',
      recentChanges: [{ pill: 'Audit', pillBg: '#EEF0F3', pillFg: '#344054', titleHtml: 'Signed in', detailHtml: 'demohost' }],
    }).desktop
    assert.match(home.meters.find(meter => meter.label === 'IO write cap')?.value ?? '', /50\.0 MB\/s/)
    assert.equal(home.meters.find(meter => meter.label === 'Mailboxes')?.value, '1 / 20')
    assert.match(home.info.map(row => row.valueHtml).join(' '), /18:04 UTC/)
    assert.equal(home.changes.length, 1)
    assert.match(home.changes[0]?.titleHtml ?? '', /Signed in/)
    assert.equal(auditOutcomeLabel('auth.login', 'ok', 'en'), 'Signed in')
    assert.equal(auditTargetLabel('generation:142', 'en'), 'Generation 142')
    assert.equal(auditTargetLabel('mbx:abc', 'en'), 'Mailbox')
  })

  it('reads a version file and a certificate PEM without baking a host name into the parser', async () => {
    assert.equal(parseVersionFile('0.1.0-xmail.20261024.1\n'), '0.1.0-xmail.20261024.1')
    const { spawnSync } = await import('node:child_process')
    const pem = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', '/tmp/xpanel-truth-key.pem', '-out', '/dev/stdout', '-days', '6', '-nodes', '-subj', '/CN=panel.example.test', '-addext', 'subjectAltName=DNS:panel.example.test'], { encoding: 'utf8' })
    const certificate = pem.status === 0 && pem.stdout.includes('BEGIN CERTIFICATE') ? pem.stdout : null
    if (certificate) {
      const parsed = certificateFromPem(certificate, Date.now())
      assert.ok(parsed)
      assert.equal(parsed?.names.includes('panel.example.test'), true)
      assert.ok((parsed?.daysLeft ?? 99) < 30)
    }
    const stale = certificate
      ? certificate.replaceAll('panel.example.test', 'panel.xpanel-lab.test')
      : null
    const nginx = `
server {
  listen 80;
  ssl_certificate /etc/xpanel/ssl/default/fullchain.pem;
  ssl_certificate_key /etc/xpanel/ssl/default/privkey.pem;
}
server {
  listen 127.0.0.1:8443 ssl;
  ssl_certificate /etc/xpanel/ssl/panel/fullchain.pem;
  ssl_certificate_key /etc/xpanel/ssl/panel/privkey.pem;
}
`
    assert.equal(sslCertificateForListen(nginx, 8443), '/etc/xpanel/ssl/panel/fullchain.pem')
    const identity = await readHostIdentity({
      readFile: async (path) => {
        if (path === '/etc/os-release') return null
        if (path === '/usr/lib/os-release') return 'PRETTY_NAME="Ubuntu 24.04.3 LTS"\n'
        if (path === '/opt/xpanel/VERSION') return '0.1.0-xmail.20261024.1\n'
        if (path === '/etc/xpanel/ssl/default/fullchain.pem') return stale
        if (path === '/etc/xpanel/ssl/panel/fullchain.pem') return certificate
        return null
      },
      runCommand: async (argv) => argv[0]?.endsWith('/nginx') && argv[1] === '-T'
        ? { ok: true, stdout: nginx, stderr: '' }
        : { ok: false, stdout: '', stderr: '' },
    })
    assert.equal(identity.system, 'Ubuntu 24.04.3 LTS')
    assert.equal(identity.version, '0.1.0-xmail.20261024.1')
    if (certificate) {
      assert.equal(identity.panelDomain, 'panel.example.test')
      assert.equal(identity.panelDomain?.includes('xpanel-lab.test'), false)
    }
    const served = await readHostIdentity({
      readFile: async () => stale,
      runCommand: async () => ({ ok: false, stdout: '', stderr: '' }),
      readServedCertificate: async () => certificate,
    })
    if (certificate) assert.equal(served.panelDomain, 'panel.example.test')
  })
})
