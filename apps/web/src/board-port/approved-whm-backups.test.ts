import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import type { Account } from '@xpanel/core'
import { renderApprovedWhmBackups } from './approved-whm-backups.ts'

const root = { kind: 'root' as const, id: 'private-root-id', username: 'synthetic-root' }
const account: Account = {
  id: 'private-account-id-must-not-render', username: 'exampleowner', primaryDomain: 'example.test',
  uid: 24001, gid: 24001, home: '/private/home/must-not-render', planId: 'private-plan-id', ownerId: null,
  status: 'active', suspendReason: null, contactEmail: 'private-contact@example.test', ipv4: '192.0.2.44',
  shell: 'none', createdAt: '2026-10-25T09:00:00Z',
}
const controls = (html: string): string[] => [...html.matchAll(/<(?:input|select|textarea|button)\b[^>]*>/g)].map(match => match[0])
const ids = (html: string): string[] => [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]!)
// Only style contents are excluded when checking actual native DOM hook attributes.
// Private account/value guards still inspect the complete HTML, including every style.
const nativeMarkup = (html: string): string => (html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').match(/<[^>]+>/g) ?? []).join('')
const nativeHookAttribute = /\sdata-(?:account-backups|backup-create)(?=[\s=>])/i
const unsafeTransportMarkup = /<form\b|\s(?:action|onsubmit|onclick)\s*=|<script\b|\/api\//i
const native = `<section class="xp-card" data-account-backups="true" aria-labelledby="whm-backup-heading"><div class="xp-card__header"><h1 id="whm-backup-heading">Account archives</h1></div><label for="backup-account">Account</label><select id="backup-account" data-backup-account="true"><option value="exampleowner">exampleowner</option></select><table><tbody data-backup-files="true"></tbody></table><p data-backup-status="true" role="status"></p><button type="button" data-backup-create="true">Create archive</button></section>`

describe('approved administrator backup workspace', () => {
  it('distinguishes inert data hooks from real transport and event attributes', () => {
    assert.doesNotMatch('<button type="button" data-backup-action="refresh">Read</button>', unsafeTransportMarkup)
    assert.doesNotMatch(nativeMarkup('<style>[data-account-backups]{display:flex}</style><section>Unavailable</section>'), nativeHookAttribute)
    for (const markup of ['<section data-account-backups="true"></section>', '<button data-backup-create="true">Create</button>']) assert.match(nativeMarkup(markup), nativeHookAttribute)
    for (const markup of ['<form>', '<button onclick="run()">', "<button ONCLICK = 'run()'>", '<button action=/submit>', '<button onsubmit="run()">', '<script>', '/api/backups']) assert.match(markup, unsafeTransportMarkup)
  })
  it.each(['en', 'ar'] as const)('retains every backup component with unread state in %s', locale => {
    const html = renderApprovedWhmBackups({ locale, principal: root })
    for (const section of ['runs', 'restore', 'restore-rules', 'configuration']) assert.ok(html.includes(`data-backup-section="${section}"`), section)
    for (const id of ['restore-run-label', 'restore-account-label', 'restore-search', 'restore-home', 'restore-databases', 'restore-mail', 'restore-dns', 'restore-acknowledge', 'frequency', 'start-time', 'daily-copies', 'weekly-copies', 'include-home', 'include-databases', 'include-mail', 'include-dns', 'include-control', 'local-enabled', 'local-path', 'sftp-enabled', 'sftp-host', 'sftp-port', 'sftp-user', 'sftp-path', 'sftp-key']) assert.ok(html.includes(`id="backup-layout-${id}"`), id)
    for (const component of ['data-backup-run-failure', 'data-backup-part-availability', 'data-backup-restore-difference', 'data-backup-restore-status', 'data-backup-configuration-status']) assert.ok(html.includes(component), component)
    assert.equal((html.match(/role="radiogroup"/g) ?? []).length, 2)
    assert.equal((html.match(/<h1\b/g) ?? []).length, 1)
    assert.match(html, /data-backup-read-state="unread"/)
    assert.ok(controls(html).length > 40)
    for (const control of controls(html)) {
      assert.match(control, /\bdisabled\b/)
      assert.match(control, /aria-describedby="whm-backup-layout-unavailable"/)
    }
    assert.doesNotMatch(html, unsafeTransportMarkup)
    assert.doesNotMatch(html, /[\u0660-\u0669\u06f0-\u06f9]/)
    assert.doesNotMatch(html, /alice|karim|nour\.dev|41 accounts|3\.6 TB|2026-10-22|7 daily|Configuration saved|Connected\./)
  })

  it('retains the exact run columns, review statistics, actions and recovery boundaries', () => {
    const html = renderApprovedWhmBackups({ principal: root })
    for (const label of ['Started', 'Type', 'Accounts', 'Size', 'Duration', 'Copies', 'Status', 'Actions', 'Files that differ', 'Only in the archive', 'Only on disk', 'Databases', 'View run log', 'Cancel running backup', 'Back up selected account again', 'Continue', 'Review differences', 'Restore selected account', 'Test connection', 'Save configuration', 'Discard changes']) assert.ok(html.includes(`>${label}<`), label)
    assert.match(html, /control-database snapshot is for disaster recovery and upgrade rollback; it must never be restored per account/)
    assert.match(html, /must not touch the home directory/)
    assert.match(html, /No restore has been started/)
    assert.match(html, /No configuration has been saved/)
    assert.match(html, /host-key trust has been verified/)
    assert.match(html, /subsequent run succeeds/)
    assert.match(html, /weight 10\) has not been verified/)
    assert.equal((html.match(/<dd>Not read<\/dd>/g) ?? []).length, 8)
    assert.doesNotMatch(html, /<progress\b|aria-valuenow=|aria-current="step"|<option\b[^>]*\sselected(?:\s|=|>)/)
    for (const control of controls(html)) assert.doesNotMatch(control, /\schecked(?:\s|=|>)|\bvalue="\d/)
  })

  it('renders only authorized current account names without treating them as historical run membership', () => {
    const html = renderApprovedWhmBackups({ principal: root, accounts: [account] })
    assert.match(html, /<bdi[^>]*>exampleowner<\/bdi>/)
    assert.match(html, /<bdi[^>]*>example\.test<\/bdi>/)
    assert.match(html, /The account list and archive sizes for the selected run have not been read/)
    for (const privateValue of [account.id, account.home, account.planId, account.contactEmail, account.ipv4, String(account.uid)]) assert.ok(!html.includes(privateValue), privateValue)
  })

  it('escapes account display values and normalizes digits while isolating technical text', () => {
    const html = renderApprovedWhmBackups({ locale: 'ar', principal: root, accounts: [{ ...account, username: '<owner&١٢>', primaryDomain: '"domain٣.test' }] })
    assert.match(html, /<bdi dir="ltr">&lt;owner&amp;12&gt;<\/bdi>/)
    assert.match(html, /<bdi dir="ltr">&quot;domain3\.test<\/bdi>/)
    assert.doesNotMatch(html, /<owner|[\u0660-\u0669\u06f0-\u06f9]/)
  })

  it('distinguishes unread and authorized empty account lists', () => {
    const unread = renderApprovedWhmBackups({ principal: root })
    const empty = renderApprovedWhmBackups({ principal: root, accounts: [] })
    assert.match(unread, /The account list has not been read/)
    assert.match(empty, /No accounts were returned by the authorized read/)
    assert.doesNotMatch(empty, /id="backup-layout-account-0"/)
  })

  it.each([undefined, { kind: 'reseller' as const, id: 'private-reseller', username: 'root' }, { kind: 'user' as const, id: 'private-user', username: 'root', accountId: 'private-account' }])('never trusts account or native props without an authorized root principal', principal => {
    const html = renderApprovedWhmBackups({ ...(principal ? { principal } : {}), accounts: [account] }, native)
    assert.doesNotMatch(html, /exampleowner|example\.test|private-account-id/)
    assert.doesNotMatch(nativeMarkup(html), nativeHookAttribute)
    for (const control of controls(html)) assert.match(control, /\bdisabled\b/)
    if (principal) {
      assert.match(html, /data-backup-read-state="denied"/)
      assert.equal(controls(html).length, 0)
    } else {
      assert.match(html, /data-backup-section="configuration"/)
    }
  })

  it('retains the full unavailable layout while discarding any supplied DTOs and native operations', () => {
    const html = renderApprovedWhmBackups({ principal: root, capabilityUnavailable: true, accounts: [account] }, native)
    assert.match(html, /data-backup-section="runs"/)
    assert.match(html, /data-backup-section="restore"/)
    assert.match(html, /data-backup-section="configuration"/)
    assert.match(html, /data-backup-native="unavailable"/)
    assert.doesNotMatch(html, /exampleowner|example\.test|private-account-id/)
    assert.doesNotMatch(nativeMarkup(html), nativeHookAttribute)
    for (const control of controls(html)) assert.match(control, /\bdisabled\b/)
  })

  it('preserves the native account-archive controller verbatim once, without duplicating its heading or hooks', () => {
    const html = renderApprovedWhmBackups({ principal: root, accounts: [account] }, native)
    assert.equal(html.split(native).length - 1, 1)
    assert.equal((html.match(/<h1\b/g) ?? []).length, 1)
    for (const hook of ['data-account-backups=', 'data-backup-account=', 'data-backup-files=', 'data-backup-status=', 'data-backup-create=']) assert.equal(html.split(hook).length - 1, 1, hook)
    assert.match(html, /data-backup-native="connected"/)
    for (const control of controls(html).filter(control => control.includes('data-backup-layout-control'))) assert.match(control, /\bdisabled\b/)
    assert.equal(new Set(ids(html)).size, ids(html).length)
    for (const [, id] of html.matchAll(/\bfor="([^"]+)"/g)) assert.ok(ids(html).includes(id!))
    for (const [, refs] of html.matchAll(/\baria-(?:labelledby|describedby)="([^"]+)"/g)) for (const id of refs!.split(' ')) assert.ok(ids(html).includes(id), id)
  })

  it('uses the visibility principal as the authoritative role when both principal sources exist', () => {
    const html = renderApprovedWhmBackups({ principal: root, visibility: { principal: { kind: 'user', id: 'untrusted', username: 'root', accountId: 'untrusted-account' } }, accounts: [account] }, native)
    assert.match(html, /data-backup-read-state="denied"/)
    assert.doesNotMatch(html, /exampleowner/)
    assert.doesNotMatch(nativeMarkup(html), nativeHookAttribute)
  })
})
