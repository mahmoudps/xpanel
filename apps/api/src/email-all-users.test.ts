import { describe, expect, it, vi } from 'vitest'
import type { Account } from '@xpanel/core'
import { DeliveryFailure } from './alert-delivery.ts'
import { handleEmailAllUsersRoute, parseUsersEmail, usersEmailAudience } from './email-all-users.ts'
import type { AuthenticatedCaller } from './auth.ts'

type Row = Pick<Account, 'username' | 'contactEmail' | 'ownerId' | 'status'>
const row = (username: string, over: Partial<Row> = {}): Row => ({ username, contactEmail: username + '@example.test', ownerId: null, status: 'active', ...over })
const accounts = [row('alice'), row('bob', { ownerId: 'r1' }), row('carol', { contactEmail: '' }), row('gone', { status: 'terminating' })]
const message = { fromName: 'Host', fromAddress: 'host@example.test', subject: 'Maintenance', body: 'Tonight.' }
const post = async (body: Record<string, unknown>, email = vi.fn(async () => undefined)) => {
  const audit = vi.fn(async () => undefined), request = new Request('http://x/api/server/announcements/email', { method: 'POST' })
  const response = await handleEmailAllUsersRoute(request, new URL(request.url), 'POST', { requireCaller: async () => ({ principal: { kind: 'root', username: 'root', id: 'r' } }) as AuthenticatedCaller, assertRoot: async () => undefined, emitAudit: audit, listAccounts: async () => accounts, readJsonBody: async () => body, email })
  return { status: response!.status, reply: await response!.json() as Record<string, unknown>, email, audit }
}

describe('Email All Users', () => {
  it('reaches only root accounts by default and skips accounts without a contact', () => {
    expect(usersEmailAudience(accounts, false)).toEqual({ recipients: [{ username: 'alice', address: 'alice@example.test' }], skipped: ['carol'] })
    expect(usersEmailAudience(accounts, true).recipients.map(item => item.username)).toEqual(['alice', 'bob'])
  })
  it('sends nothing on the first post and one message per account on the confirmation', async () => {
    const first = await post(message)
    expect(first.reply).toMatchObject({ recipients: 1, skipped: ['carol'] })
    expect(first.email).not.toHaveBeenCalled()
    const second = await post({ ...message, confirm: first.reply.review })
    expect(second.reply).toEqual({ sent: [{ username: 'alice', address: 'alice@example.test' }], failed: [], skipped: ['carol'] })
    expect(second.email).toHaveBeenCalledExactlyOnceWith({ to: ['alice@example.test'], subject: 'Maintenance', text: 'Tonight.', from: { address: 'host@example.test', name: 'Host' } })
    expect(second.audit).toHaveBeenCalledOnce()
  })
  it('refuses a confirmation of a different message', async () => {
    const first = await post(message)
    await expect(post({ ...message, subject: 'Changed', confirm: first.reply.review })).rejects.toMatchObject({ code: 'CONFLICT', detail: { reason: 'review_stale' } })
  })
  it('reports every failed delivery and 503 when none went out', async () => {
    const first = await post(message), second = await post({ ...message, confirm: first.reply.review }, vi.fn(async () => { throw new DeliveryFailure('refused') }))
    expect(second.status).toBe(503)
    expect(second.reply).toMatchObject({ sent: [], failed: [{ username: 'alice', error: 'refused' }] })
  })
  it('keeps headers to one line and addresses to the reviewed shape', () => {
    for (const body of [{ ...message, subject: 'a\r\nBcc: x@y' }, { ...message, fromName: 'a\nb' }, { ...message, fromAddress: 'a@b>\r\nX: y' }, { ...message, fromAddress: 'nope' }, { ...message, body: ' ' }, { ...message, includeResellerCustomers: 'yes' }, { ...message, other: 1 }]) expect(() => parseUsersEmail(body as Record<string, unknown>)).toThrow()
  })
})
