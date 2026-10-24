import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { defaultPlan, type Account, type Reseller } from '@xpanel/core'
import { renderWhmAccountCreate, whmAccountCreateFromProps } from './xwhm-account-create.ts'

const plan = defaultPlan({ id: 'plan-1', name: 'Standard', featureListId: 'features-1' })
const principal = { kind: 'root' as const, id: 'root', username: 'root' }
const account = (ownerId: string | null, planId = plan.id): Account => ({
  id: 'acc-1', username: 'owned', uid: 20001, gid: 20001, home: '/home/owned', primaryDomain: 'owned.example.test',
  planId, ownerId, status: 'active', suspendReason: null, contactEmail: 'owned@example.test', ipv4: '192.0.2.10',
  shell: 'jailed', createdAt: '2026-10-23T00:00:00Z',
})
const reseller = (overrides: Partial<Reseller> = {}): Reseller => ({
  id: 'reseller-1', username: 'shop', acl: ['create-account'], maxAccounts: 'unlimited', totalDiskMb: 100,
  totalBandwidthMb: 'unlimited', oversell: false, nameservers: [], delegatedIps: [], ...overrides,
})

const formOf = (html: string): string => html.slice(html.indexOf('<form'), html.indexOf('</form>'))

describe('xWHM create account', () => {
  it('keeps the seven create controls and the live plan limits', () => {
    const html = renderWhmAccountCreate(whmAccountCreateFromProps({
      principal, plans: [plan], accounts: [], resellers: [], generationId: 7,
    }))
    const form = formOf(html)
    assert.equal([...form.matchAll(/<(input|select)\b/gi)].length, 7)
    assert.match(form, /data-create-account-form="true"/)
    assert.match(form, /action="\/api\/accounts"/)
    assert.doesNotMatch(form, /novalidate/)
    assert.match(form, /minlength="8"/)
    assert.match(form, /pattern="\[a-z\]\[a-z0-9\]\{0,15\}"/)
    assert.match(form, /data-shell-choice="none"[^>]*aria-pressed="true"/)
    assert.match(html, /data-generation-chip="7"/)
    assert.match(html, /5,120 MiB/)
    assert.match(html, /<bdi dir="ltr">features-1<\/bdi>/)
    assert.match(html, /Coming soon/)
    assert.doesNotMatch(html, /role="meter"/)
    assert.doesNotMatch(formOf(html), /data-blocked=/)
    assert.doesNotMatch(html, /salma|10\.0\.0\.12|q7Vt|20017|v1\.4\.2|srv1\.xpanel\.test/)
    assert.equal(html.match(/<h1\b/g)?.length, 1)
  })

  it('distinguishes a missing plan catalog from an empty one', () => {
    const missing = renderWhmAccountCreate(whmAccountCreateFromProps({ principal }))
    const empty = renderWhmAccountCreate(whmAccountCreateFromProps({ principal, plans: [], accounts: [], resellers: [] }))
    assert.match(missing, /The plan list is unavailable/)
    assert.match(empty, /No plans are available/)
    assert.match(formOf(missing), /data-create-submit disabled/)
    assert.match(formOf(empty), /data-create-submit disabled/)
  })

  it('blocks a reseller cap without disabling the submit control', () => {
    const owner = reseller()
    const html = renderWhmAccountCreate(whmAccountCreateFromProps({
      principal: { kind: 'reseller', id: owner.id, username: owner.username },
      activeReseller: owner,
      plans: [plan],
      accounts: [account(owner.id)],
      resellers: [owner],
    }))
    assert.match(formOf(html), /data-create-submit data-blocked="true"/)
    assert.doesNotMatch(formOf(html), /data-create-submit disabled/)
    assert.match(html, /This plan is over the owner cap/)
  })

  it('does not invent a cap when the owned plan is missing', () => {
    const owner = reseller({ oversell: true })
    const html = renderWhmAccountCreate(whmAccountCreateFromProps({
      principal: { kind: 'reseller', id: owner.id, username: owner.username },
      activeReseller: owner,
      plans: [plan],
      accounts: [account(owner.id, 'missing-plan')],
    }))
    assert.match(html, /The capacity check is unavailable/)
    assert.doesNotMatch(formOf(html), /data-blocked=/)
  })

  it('keeps Arabic sentences in the sans class and numbers in isolates', () => {
    const html = renderWhmAccountCreate(whmAccountCreateFromProps({
      locale: 'ar', principal, plans: [plan], accounts: [], resellers: [], generationId: 7,
    }))
    assert.match(html, /class="xp-ar-sentence"/)
    assert.match(html, /قيد التفعيل/)
    assert.match(html, /بريد التواصل/)
    assert.match(html, /<bdi dir="ltr">7<\/bdi>/)
    assert.doesNotMatch(html, /Coming soon/)
    assert.match(html, /class="xp-page-title">إنشاء حساب<\/h1>/)
  })
})
