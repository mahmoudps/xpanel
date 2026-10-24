import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { defaultPlan, type Account } from '@xpanel/core'
import type { ComposedContext } from '../composed/context.ts'
import { renderResourcesBoard, type ResourcesBoardReading } from './resources-board.ts'

const account: Account = { id: 'resource-owner', username: 'owner', uid: 20042, gid: 20042, home: '/home/owner', primaryDomain: 'owner.example.test', planId: 'resource-plan', ownerId: null, status: 'active', suspendReason: null, contactEmail: 'owner@example.test', ipv4: '192.0.2.42', ipv6: null, shell: 'none', createdAt: '2026-10-24T00:00:00Z' }
const context: ComposedContext = { locale: 'en', route: '/resources', account, principal: { kind: 'user', id: 'resource-principal', username: account.username, accountId: account.id }, plan: defaultPlan({ id: account.planId, name: 'Synthetic plan', featureListId: 'synthetic-features' }) }
const reading = (): ResourcesBoardReading => ({ accountId: account.id, available: true, observedAt: '2026-10-24T00:00:00.000Z', snapshot: { diskBytes: 0, memoryBytes: 1048576, processCount: 0, phpVersion: null, bandwidth: 'unmeasured', ioEnforced: null } })
const metric = (html: string, key: string): string => html.match(new RegExp(`<section[^>]*data-resource-metric="${key}"[\\s\\S]*?</section>`))?.[0] ?? ''

describe('account resources presentation', () => {
  it('distinguishes measured zero, binary MiB, unlimited and unsupported measurements', () => {
    const input = { ...context, plan: { ...context.plan!, resources: { ...context.plan!.resources, diskMb: 'unlimited' as const, maxProcesses: 0 } } }
    const html = renderResourcesBoard({ context: input, reading: reading() })
    assert.match(metric(html, 'disk'), /data-resource-state="measured"/)
    assert.match(metric(html, 'disk'), />Unlimited</)
    assert.match(metric(html, 'disk'), />0 MiB</)
    assert.match(metric(html, 'memory'), />1 MiB</)
    assert.match(metric(html, 'processes'), /<bdi[^>]*>0<\/bdi>/)
    assert.match(metric(html, 'bandwidth'), /Not measured/)
    assert.match(metric(html, 'io-await'), /data-resource-state="unmeasured"/)
    assert.match(metric(html, 'io-await'), /Not measured/)
    assert.doesNotMatch(metric(html, 'io-read'), /data-resource-state="measured"/)
  })
  it('does not convert unread, null, negative or nonfinite observations to zero', () => {
    const unread = renderResourcesBoard({ context })
    assert.match(unread, /data-resource-reading="unread"/)
    assert.match(metric(unread, 'disk'), /data-resource-value>Not read/)
    for (const value of [null, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.5]) {
      const sample = reading()
      if (sample.available) sample.snapshot.diskBytes = value
      const html = renderResourcesBoard({ context, reading: sample })
      assert.match(metric(html, 'disk'), /data-resource-state="unavailable"/)
      assert.doesNotMatch(metric(html, 'disk'), /data-resource-value><bdi[^>]*>0 MiB/)
    }
    const small = reading()
    if (small.available) small.snapshot.diskBytes = 1
    assert.match(metric(renderResourcesBoard({ context, reading: small }), 'disk'), />1 B</)
  })
  it('keeps canonical unavailable reasons and original observation time without rendering field keys', () => {
    const unavailable: ResourcesBoardReading = { accountId: account.id, available: false, snapshot: null, reason: 'incomplete', fieldReasons: { awaitMs: 'unsupported', 'accounts.other-owner.cpuPercent': 'private-synthetic-detail' }, observedAt: '2026-10-24T00:00:00.000Z' }
    const html = renderResourcesBoard({ context, reading: unavailable })
    assert.match(html, /data-resource-reading="unavailable"/)
    assert.match(html, /The sample is incomplete/)
    assert.match(html, /2026-10-24/)
    assert.doesNotMatch(html, /private-synthetic-detail|other-owner|awaitMs/)
    assert.match(metric(html, 'disk'), /data-resource-value>Unavailable/)
  })
  it('rejects neighbor account samples and does not reveal their timestamp or measurements', () => {
    const other = reading()
    const html = renderResourcesBoard({ context, reading: { ...other, accountId: 'neighbor' } })
    assert.match(html, /data-resource-reading="unavailable"/)
    assert.doesNotMatch(html, /2026-10-24|>1 MiB<|>0 MiB</)
    assert.match(metric(html, 'memory'), /data-resource-value>Unavailable/)
  })
  it('does not disclose a plan or reading outside authorized owner context', () => {
    const denied = renderResourcesBoard({ context: { ...context, principal: { kind: 'user', id: 'neighbor', username: 'neighbor', accountId: 'neighbor' } }, reading: reading() })
    assert.match(denied, /data-resource-reading="denied"/)
    assert.doesNotMatch(denied, /MiB|20042|Resource readings/)
    const wrongPlan = renderResourcesBoard({ context: { ...context, plan: { ...context.plan!, id: 'neighbor-plan', resources: { ...context.plan!.resources, diskMb: 987654 } } }, reading: reading() })
    assert.doesNotMatch(wrongPlan, /987654/)
    assert.match(metric(wrongPlan, 'disk'), />Not read</)
  })
  it('keeps Arabic labels human, values isolated beneath labels and all digits ASCII', () => {
    const html = renderResourcesBoard({ context: { ...context, locale: 'ar' }, reading: reading() })
    assert.match(html, /lang="ar" dir="rtl"/)
    assert.match(metric(html, 'memory'), /<dt>القراءة الحالية<\/dt><dd data-resource-value><bdi dir="ltr" class="xp-mono">1 MiB<\/bdi>/)
    assert.match(metric(html, 'bandwidth'), /غير مقاس/)
    assert.doesNotMatch(html, /[\u0660-\u0669\u06f0-\u06f9]/)
    assert.doesNotMatch(html, /<form|<button|<script|fetch\(/)
  })
})
