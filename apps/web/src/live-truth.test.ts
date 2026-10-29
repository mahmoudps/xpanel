import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { arabicFileCount, xmailComposeFromProps } from './board-port/xmail-compose.ts'
import { xmailInboxFromProps, renderInbox } from './board-port/xmail-inbox.ts'
import { whmDashboardFromProps } from './board-port/xwhm-dashboard.ts'
import { xpanelHomeFromProps } from './board-port/xpanel-home.ts'
import { auditActionHtml, auditActionLabel, auditActorLabel, auditOutcomeLabel, auditTargetLabel } from './audit-labels.ts'
import { formatAsciiBytes } from './tokens.ts'
import { certificateFromPem, readHostIdentity, serverNamesForListen, sslCertificateForListen } from '../../agent/src/host-identity.ts'
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
    // Product attachments are read from native MIME on selection; summary metadata is never offered as a file.
    assert.match(html, /data-mail-attachments\b[^>]*data-attachment-can-read="false"/)
    assert.equal(html.includes('plan.pdf'), false)
    assert.equal(html.includes('data-mail-attachment-download'), false)
    const decoded = renderInbox(xmailInboxFromProps({
      mailbox: 'info@example.test',
      messages: [{ ...message, attachments: [{ name: 'note.txt', sizeBytes: 1240 }] }],
    }))
    assert.equal(decoded.includes('note.txt'), false)
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
    // Inlined parser source (`for (const k of ...)`) is not page copy.
    const markup = html.replace(/<script\b[\s\S]*?<\/script>/g, '')
    assert.equal(markup.includes(' of '), false)
    assert.equal(markup.includes('Unread.'), false)
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
    assert.equal(model.audit[0]?.target, '')
    assert.equal(model.audit[0]?.detail, '')
    assert.equal(model.audit[0]?.action, 'Signed in')
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
    assert.equal(home.meters.find(meter => meter.label === 'IO write cap')?.value, '—')
    assert.equal(home.meters.find(meter => meter.label === 'Mailboxes')?.value, '1 / 20')
    const sampled = xpanelHomeFromProps({
      account: { username: 'demohost', uid: 20000, home: '/home/demohost', primaryDomain: 'demo.example.test', ipv4: '192.0.2.10' },
      plan: { name: 'Demo', resources: { diskMb: 5120, bandwidthMbMonth: 1024, memoryMb: 512, maxProcesses: 20, ioWriteBps: 50_000_000 }, caps: { addonDomains: 5, mailboxes: 20, databases: 5 } },
      usage: { phpVersion: '8.3', diskBytes: 1_500_000_000, memoryBytes: 120_000_000, processCount: 4, bandwidth: 'unmeasured', ioEnforced: false },
    }).desktop
    assert.match(sampled.info.map(row => row.valueHtml).join(' '), /8\.3 · PHP-FPM/)
    assert.match(sampled.meters.find(meter => meter.label === 'Disk')?.value ?? '', /1\.50 GB \/ 5 GB/)
    assert.match(sampled.meters.find(meter => meter.label === 'Memory')?.value ?? '', /120 MB \/ 537 MB/)
    assert.equal(sampled.meters.find(meter => meter.label === 'IO write cap')?.value, 'not enforced')
    const capped = xpanelHomeFromProps({
      account: { username: 'demohost', uid: 20000, home: '/home/demohost', primaryDomain: 'demo.example.test', ipv4: '192.0.2.10' },
      plan: { name: 'Demo', resources: { diskMb: 5120, bandwidthMbMonth: 1024, memoryMb: 1024, maxProcesses: 20, ioWriteBps: 50_000_000 }, caps: { addonDomains: 5, mailboxes: 20, databases: 5 } },
      usage: { phpVersion: '8.3', diskBytes: 1_500_000_000, memoryBytes: 120_000_000, processCount: 4, bandwidth: 'unmeasured', ioEnforced: true },
    }).desktop
    assert.equal(capped.meters.find(meter => meter.label === 'IO write cap')?.value, '50.0 MB/s')
    assert.match(capped.meters.find(meter => meter.label === 'Memory')?.value ?? '', /120 MB \/ 1\.07 GB/)
    assert.equal(sampled.meters.find(meter => meter.label === 'Processes')?.value, '4 / 20')
    assert.match(sampled.meters.find(meter => meter.label === 'Monthly bandwidth')?.value ?? '', /not measured yet/)
    assert.equal(sampled.metricsUnavailable, false)
    const quiet = whmDashboardFromProps({ driftCount: 0, driftCheckedAt: '2026-10-24T14:04:00.000Z', generationId: 3 })
    assert.equal(quiet.reconcilerTiles.find(tile => tile.label === 'Drift')?.note, 'Checked 14:04 UTC')
    const moved = whmDashboardFromProps({ locale: 'ar', driftCount: 2, driftCheckedAt: '2026-10-24T14:04:00.000Z' })
    assert.match(moved.reconcilerTiles.find(tile => tile.label === 'الانحراف')?.note ?? '', /انحراف/)
    assert.match(moved.reconcilerTiles.find(tile => tile.label === 'الانحراف')?.note ?? '', /14:04 UTC/)
    assert.equal(whmDashboardFromProps({}).reconcilerTiles.find(tile => tile.label === 'Drift')?.note, '—')
    assert.equal(whmDashboardFromProps({}).controllersNote, 'Plan-limit verification is unavailable.')
    assert.equal(whmDashboardFromProps({ hostSample: { enforcedLimits: { cpu: true, memory: true, io: true, pids: true } } }).controllersNote, 'Plan-limit verification is unavailable.')
    assert.equal(whmDashboardFromProps({ hostSample: { observedLimits: { status: 'gaps', checkedAccounts: 1, unavailableAccounts: 0, gaps: ['io'] } } }).controllersNote, 'Observed account caps do not match all assigned plan limits.')
    assert.equal(whmDashboardFromProps({ locale: 'ar', hostSample: { observedLimits: { status: 'unavailable', checkedAccounts: 1, unavailableAccounts: 1, gaps: [] } } }).controllersNote, 'التحقق من حدود الخطط غير متاح.')
    const arabicHome = xpanelHomeFromProps({
      locale: 'ar',
      account: { username: 'demohost', uid: 20000, home: '/home/demohost', primaryDomain: 'demo.example.test', ipv4: '192.0.2.10' },
      plan: { name: 'Demo', resources: { diskMb: 1024, bandwidthMbMonth: 1024, memoryMb: 1024, maxProcesses: 20, ioWriteBps: 50_000_000 }, caps: { addonDomains: 5, mailboxes: 20, databases: 5 } },
      domains: [
        { kind: 'primary', name: 'demo.example.test' },
        { kind: 'addon', name: 'a.example.test' },
        { kind: 'addon', name: 'b.example.test' },
      ],
    })
    const addonHints = [...arabicHome.desktop.groups, ...arabicHome.phone.groups].flatMap(group => group.tools.map(tool => tool.hint))
    assert.equal(addonHints.filter(hint => hint.includes('2 / 5 الإضافية')).length, 2)
    assert.match(home.info.map(row => row.valueHtml).join(' '), /18:04 UTC/)
    assert.equal(home.changes.length, 1)
    assert.match(home.changes[0]?.titleHtml ?? '', /Signed in/)
    assert.equal(auditOutcomeLabel('auth.login', 'ok', 'en'), 'Signed in')
    assert.equal(auditOutcomeLabel('auth.logout', 'ok', 'en'), 'Done')
    assert.equal(auditOutcomeLabel('auth.logout', 'ok', 'ar'), 'تم')
    assert.equal(auditOutcomeLabel('dns.zone.saved', 'ok', 'en'), 'Applied')
    assert.equal(auditTargetLabel('generation:142', 'en'), 'Generation 142')
    assert.equal(auditTargetLabel('mbx:abc', 'en'), '')
    assert.equal(auditTargetLabel('/health', 'en'), '/health')
    assert.equal(auditTargetLabel('principal:alice', 'en'), 'alice')
    assert.equal(auditActorLabel('info@example.test'), 'info@example.test')
    assert.equal(auditActorLabel(`mbx${'a'.repeat(28)}`), '')
    const peer = { actor: 'uid:0', detail: { peerUid: 0 } }
    assert.equal(auditActionLabel('agent.peer_denied', 'en', peer), 'Agent refused a request from an unauthorized local user (uid 0)')
    assert.match(auditActionHtml('agent.peer_denied', 'ar', peer), /<bdi dir="ltr">\(uid 0\)<\/bdi>/)
  })

  it('reads a version file and a certificate PEM without baking a host name into the parser', async () => {
    assert.equal(parseVersionFile('0.1.0-xmail.20261024.1\n'), '0.1.0-xmail.20261024.1')
    assert.equal(parseVersionFile('0.1.0-audit-ar.20261024.1\n'), '0.1.0-audit-ar.20261024.1')
    assert.equal(parseVersionFile('0.1.0 audit\n'), null)
    assert.equal(parseVersionFile('../etc\n'), null)
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
      ? certificate.replaceAll('panel.example.test', 'other.example.test')
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
      assert.equal(identity.panelDomain?.includes('other.example.test'), false)
    }
    const served = await readHostIdentity({
      readFile: async () => stale,
      runCommand: async () => ({ ok: false, stdout: '', stderr: '' }),
      readServedCertificate: async () => certificate,
    })
    if (certificate) assert.equal(served.panelDomain, 'panel.example.test')
    const named = await readHostIdentity({
      readFile: async () => null,
      runCommand: async (argv) => argv[0]?.endsWith('/nginx') && argv[1] === '-T'
        ? { ok: true, stdout: 'server { listen 127.0.0.1:8443 ssl; server_name panel.example.test; ssl_certificate /etc/xpanel/ssl/panel/fullchain.pem; }\n', stderr: '' }
        : { ok: false, stdout: '', stderr: '' },
      readServedCertificate: async (servername) => servername ? certificate : stale,
      publicOrigin: () => 'https://panel.example.test',
    })
    if (certificate && stale) {
      assert.equal(named.panelDomain, 'panel.example.test')
      assert.equal(named.certificates?.length, 2)
      assert.equal(named.certificates?.some(row => row.names.includes('other.example.test')), true)
      assert.equal(named.certificates?.some(row => row.names.includes('panel.example.test')), true)
      const notice = whmDashboardFromProps({ certificates: named.certificates, now: Date.parse('2026-10-24T00:00:00.000Z') })
      const noticeText = notice.notices.map(item => item.html).join(' ')
      assert.match(noticeText, /panel\.example\.test/)
      assert.match(noticeText, /other\.example\.test/)
      assert.match(noticeText, /days/)
    }
    const layered = `
server { listen 127.0.0.1:8443 ssl; server_name _; }
server { listen 127.0.0.1:8443 ssl; server_name panel.example.test; }
`
    assert.deepEqual(serverNamesForListen(layered, 8443), ['panel.example.test'])
    const both = await readHostIdentity({
      readFile: async (path) => path === '/sys/fs/cgroup/xpanel.slice/cgroup.subtree_control' ? 'cpu memory pids\n' : null,
      runCommand: async (argv) => argv[0]?.endsWith('/nginx') && argv[1] === '-T'
        ? { ok: true, stdout: layered, stderr: '' }
        : { ok: false, stdout: '', stderr: '' },
      readServedCertificate: async (servername) => servername === 'panel.example.test' ? certificate : stale,
    })
    if (certificate && stale) {
      assert.equal(both.panelDomain, 'panel.example.test')
      assert.equal(both.certificates?.length, 2)
      assert.deepEqual(both.enforcedLimits, { cpu: true, memory: true, io: false, pids: true })
    }
  })
})
