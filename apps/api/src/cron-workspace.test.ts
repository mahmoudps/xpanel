import { describe, expect, it } from 'vitest'
import { cronWorkspaceRevision, parseCronWorkspaceBody, validateCronWorkspaceDraft } from './cron-workspace.ts'
import type { CronJobState } from '@xpanel/state'

const accountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const draft = { schedule: '*/5 * * * *', command: '  printf "%s" "one two"  ', comment: 'Hourly work', enabled: true, maxRuntimeSec: 300 }
const job = (patch: Partial<CronJobState> = {}): CronJobState => ({ id, accountId, ...draft, ...patch })

describe('account cron validation and revisions', () => {
  it('preserves the exact shell command and supports a bounded runtime or infinity', () => {
    expect(validateCronWorkspaceDraft(draft)).toEqual(draft)
    expect(validateCronWorkspaceDraft({ ...draft, maxRuntimeSec: 1 }).maxRuntimeSec).toBe(1)
    expect(validateCronWorkspaceDraft({ ...draft, maxRuntimeSec: 604800 }).maxRuntimeSec).toBe(604800)
    expect(validateCronWorkspaceDraft({ ...draft, maxRuntimeSec: null })).not.toHaveProperty('maxRuntimeSec')
    expect(validateCronWorkspaceDraft({ enabled: false }, job())).toMatchObject({ ...draft, enabled: false })
  })
  it.each([0, -1, 604801, 1.5, '300', Number.NaN, Number.POSITIVE_INFINITY])('refuses invalid runtime %s', maxRuntimeSec => {
    expect(() => validateCronWorkspaceDraft({ ...draft, maxRuntimeSec })).toThrow()
  })
  it.each(['61 * * * *', '* * * *', '* * * * ?', '@reboot', '0 0 0 0 0'])('uses the real calendar converter to refuse %s', schedule => {
    expect(() => validateCronWorkspaceDraft({ ...draft, schedule })).toThrow()
  })
  it.each([
    { command: '' }, { command: '   ' }, { command: 'echo ok\necho injected' }, { command: 'echo\u0000bad' },
    { command: 'echo \u202ebad' }, { command: 'x'.repeat(4097) }, { comment: 'x'.repeat(256) },
    { enabled: 'true' }, { enabled: null }, { schedule: null }, { command: null }, { comment: null },
  ])('refuses malformed or request-controlled field values %j', patch => {
    expect(() => validateCronWorkspaceDraft({ ...draft, ...patch }, job())).toThrow()
  })
  it('does not permit identity, account, user or environment injection', () => {
    const expectedRevision = 'a'.repeat(64)
    expect(parseCronWorkspaceBody({ ...draft, expectedRevision }, 'create')).toMatchObject(draft)
    for (const key of ['id', 'accountId', 'username', 'uid', 'shell', 'environment', 'home', 'outputEmail']) {
      expect(() => parseCronWorkspaceBody({ ...draft, expectedRevision, [key]: 'injected' }, 'create')).toThrow()
    }
    for (const value of [null, [], 'bad', { expectedRevision: 'bad' }, { expectedRevision: null }]) expect(() => parseCronWorkspaceBody(value, 'edit')).toThrow()
    expect(() => parseCronWorkspaceBody({ expectedRevision, confirmation: draft.command, command: 'other' }, 'delete')).toThrow()
  })
  it('binds revisions to the account and exact saved command independent of collection order', () => {
    const first = job(), second = job({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', command: 'true' })
    const revision = cronWorkspaceRevision(accountId, [first, second])
    expect(revision).toMatch(/^[0-9a-f]{64}$/)
    expect(cronWorkspaceRevision(accountId, [second, first])).toBe(revision)
    expect(cronWorkspaceRevision('dddddddd-dddd-4ddd-8ddd-dddddddddddd', [first, second])).not.toBe(revision)
    expect(cronWorkspaceRevision(accountId, [{ ...first, command: first.command + ' ' }, second])).not.toBe(revision)
    expect(cronWorkspaceRevision(accountId, [{ ...first, enabled: false }, second])).not.toBe(revision)
  })
})
