import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { defaultPlan, type Account } from '@xpanel/core'
import { renderWhmAccounts, whmAccountsFromProps } from './xwhm-accounts.ts'

const plan = defaultPlan({ id: 'plan-1', name: 'Synthetic plan', featureListId: 'features' })
const account = (patch: Partial<Account> = {}): Account => ({
  id: 'acc-1',
  username: 'department.with.a.very.long.name',
  uid: 20001,
  gid: 20001,
  home: '/home/department.with.a.very.long.name',
  primaryDomain: 'department.with.a.very.long.name.example.test',
  planId: plan.id,
  ownerId: null,
  status: 'active',
  suspendReason: null,
  contactEmail: 'owner@example.test',
  ipv4: '192.0.2.10',
  extraIps: ['192.0.2.11'],
  shell: 'jailed',
  createdAt: '2026-10-22T14:05:00Z',
  ...patch,
})

describe('xWHM accounts list', () => {
  it('shows the plan limit and leaves unmeasured disk use unmarked', () => {
    const model = whmAccountsFromProps({
      locale: 'en',
      principal: { kind: 'root', username: 'operator' },
      isRoot: true,
      hostname: 'panel.example.test',
      version: '1.0.0',
      generationId: 7,
      accounts: [account()],
      plans: [plan],
    })
    const row = model.rows[0]
    assert.equal(row?.pct, '')
    assert.match(row?.disk ?? '', /— \/ [\d,]+ MiB/)
    assert.doesNotMatch(row?.disk ?? '', /%|\bGB\b/)
    assert.equal(row?.diskSoon, 'Coming soon')
    assert.equal(row?.ioNote, 'From plan')
    assert.match(row?.io ?? '', /\/s$/)
    assert.equal(row?.owner, 'root')
    assert.equal(row?.plan, 'Synthetic plan')
    assert.equal(model.art, false)
    assert.equal(model.bulkVisible, false)
    assert.equal(model.versionLabel, '1.0.0')
    assert.equal(model.generationLabel, 'Generation 7 · active')
    const html = renderWhmAccounts(model)
    assert.match(html, /<bdi dir="ltr">xpanel-20001\.slice<\/bdi>/)
    assert.match(html, /data-action="suspend-account"/)
    assert.match(html, /data-action="terminate-account"/)
    assert.match(html, /disabled title="Coming soon"/)
    assert.match(html, /safe\.replace\(\/\(\\d\+\(\?:\[\.\,\]\\d\+\)\*\)\/g/)
    assert.doesNotMatch(html, /alice-shop\.com|Generation 142|lina and tarek|omar-clinic/)
  })

  it('keeps an omitted list distinct from an empty list', () => {
    const missing = whmAccountsFromProps({ locale: 'en', principal: { kind: 'root', username: 'operator' }, isRoot: true })
    assert.equal(missing.filtersDisabled, true)
    assert.equal(missing.showTable, false)
    assert.equal(missing.showEmpty, true)
    assert.equal(missing.countText, 'List unavailable')
    assert.equal(missing.rows.length, 0)
    const empty = whmAccountsFromProps({ locale: 'en', principal: { kind: 'root', username: 'operator' }, isRoot: true, accounts: [] })
    assert.equal(empty.filtersDisabled, false)
    assert.equal(empty.countText, 'No accounts match')
    assert.equal(empty.emptyTitle, 'No accounts')
  })

  it('names a missing reseller and keeps Arabic sentences out of mono', () => {
    const html = renderWhmAccounts(whmAccountsFromProps({
      locale: 'ar',
      principal: { kind: 'root', username: 'operator' },
      isRoot: true,
      hostname: 'الخادم',
      generationId: 7,
      accounts: [account({ ownerId: 'missing-reseller' })],
      plans: [{ ...plan, resources: { ...plan.resources, ioWriteBps: 'unlimited', diskMb: 'unlimited' } }],
    }))
    assert.match(html, /حسابًا على <span class="xp-ar-sentence">الخادم<\/span>/)
    assert.match(html, /<span class="xp-ar-sentence">من الخطة<\/span>/)
    assert.match(html, /<span class="xp-ar-sentence">قيد التفعيل<\/span>/)
    assert.match(html, /<span class="xp-ar-sentence">غير متاح<\/span>/)
    assert.match(html, /<span class="xp-ar-sentence">غير محدود<\/span>/)
    assert.match(html, /الجيل <bdi dir="ltr">7<\/bdi>/)
    assert.match(html, /<bdi dir="ltr">—<\/bdi> \/ <span class="xp-ar-sentence">غير محدود<\/span>/)
    assert.doesNotMatch(html, /Coming soon|From plan|Unavailable/)
  })
})
