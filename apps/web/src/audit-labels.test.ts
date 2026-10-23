import { readFileSync } from 'node:fs'
import { describe, it } from 'vitest'
import assert from 'node:assert/strict'
import { AUDIT_LABELS, auditActionHtml, auditActionLabel } from './audit-labels.ts'

const SOURCES = [
  'apps/api/src/server.ts',
  'apps/api/src/extended-routes.ts',
  'apps/api/src/cli.ts',
  'apps/api/src/use-cases/account-lifecycle.ts',
  'apps/agent/src/server.ts',
  'apps/agent/src/reconciler.ts',
  'apps/agent/src/lifecycle/cpanel-import.ts',
  'apps/agent/src/lifecycle/restore-runner.ts',
  'apps/agent/src/lifecycle/step-executor.ts',
  'apps/agent/src/lifecycle/transfer-runner.ts',
  'packages/db/src/identity-recovery.ts',
  'packages/lifecycle/src/upgrade/machine.ts',
]

/** Templates whose concrete actions are written at runtime. */
const EXPANSIONS = [
  'account.create.configuration_failed',
  'account.suspend.configuration_failed',
  'account.unsuspend.configuration_failed',
  'account.update.configuration_failed',
  'account.desired.suspended',
  'account.desired.unsuspended',
  'database.trashed',
  'database.restored',
  'database.maintenance.check',
  'database.maintenance.repair',
  'database.maintenance.optimize',
  'upgrade.succeeded',
  'upgrade.failed',
  'upgrade.rolled_back',
  'upgrade.rollback_failed',
  'service_user.deleted',
]

const literalsIn = (text: string): string[] => {
  const found = new Set<string>()
  for (const match of text.matchAll(/action:\s*'([a-z][a-z0-9_.]*)'/g)) found.add(match[1]!)
  for (const match of text.matchAll(/auditEntry\((?:(?!auditEntry\()[\s\S]){0,240}?'([a-z][a-z0-9_.]+)'/g)) found.add(match[1]!)
  for (const match of text.matchAll(/audit\(\s*c\s*,\s*'([a-z][a-z0-9_.]+)'/g)) found.add(match[1]!)
  for (const match of text.matchAll(/'(file\.[a-z0-9_]+)'/g)) found.add(match[1]!)
  return [...found].filter(action => action.includes('.') && !action.endsWith('.'))
}

describe('audit action copy', () => {
  it('names every recorded action in English and Arabic', () => {
    const root = new URL('../../../', import.meta.url)
    const seen = new Set<string>()
    for (const file of SOURCES) {
      for (const action of literalsIn(readFileSync(new URL(file, root), 'utf8'))) seen.add(action)
    }
    for (const action of EXPANSIONS) seen.add(action)
    const missing = [...seen].filter(action => !AUDIT_LABELS[action]).sort()
    assert.deepEqual(missing, [])
    for (const [action, copy] of Object.entries(AUDIT_LABELS)) {
      assert.equal(copy.en.includes(action), false, action)
      assert.equal(copy.ar.includes(action), false, action)
      assert.match(copy.ar, /[\u0600-\u06FF]/, action)
      assert.equal(auditActionLabel(action, 'en'), copy.en)
      assert.equal(auditActionLabel(action, 'ar'), copy.ar)
    }
    assert.equal(auditActionLabel('service_user.deleted', 'en'), 'Deleted service user')
    assert.equal(auditActionLabel('service_user.deleted', 'ar'), 'حذف مستخدم خدمة')
    assert.equal(auditActionLabel('service_user.created', 'en'), 'Created service user')
    assert.equal(auditActionLabel('service_user.created', 'ar'), 'أنشأ مستخدم خدمة')
    assert.equal(auditActionLabel('not.a.real.code', 'en'), 'Recorded event')
    assert.equal(auditActionLabel('not.a.real.code', 'ar'), 'حدث مسجّل')
    assert.equal(auditActionHtml('dns.zone.saved', 'ar').includes('dns.zone.saved'), false)
    assert.match(auditActionHtml('dns.zone.saved', 'ar'), /<bdi dir="ltr">DNS<\/bdi>/)
  })
})
