import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fail } from '@xpanel/core'
import { services } from '@xpanel/render'
import { BOXTRAPPER_PLUGIN } from '../../../packages/os/src/boxtrapper-command.ts'

/**
 * Posting policy of one mailing list, as Mailman keeps it per list. It lives on the saved list record, so members, posting
 * mode and policy change and roll back together. The queue belongs to the account, because the delivery program writes it.
 */
export type ListPosting = services.ListGateRules['posting']
export type ListPolicy = Pick<services.ListGateRules, 'moderators' | 'moderatedMembers' | 'nonMemberAction' | 'memberAction' | 'acceptSenders' | 'holdSenders' | 'rejectSenders' | 'discardSenders' | 'maxMessageKb' | 'notifyModerators' | 'notifySender' | 'retentionDays'>
export const LIST_POLICY_FIELDS = ['moderators', 'moderatedMembers', 'nonMemberAction', 'memberAction', 'acceptSenders', 'holdSenders', 'rejectSenders', 'discardSenders', 'maxMessageKb', 'notifyModerators', 'notifySender', 'retentionDays'] as const
export const LIST_POLICY_DEFAULTS: ListPolicy = { moderators: [], moderatedMembers: [], nonMemberAction: 'hold', memberAction: 'hold', acceptSenders: [], holdSenders: [], rejectSenders: [], discardSenders: [], maxMessageKb: 0, notifyModerators: true, notifySender: true, retentionDays: 14 }
const MAX_MODERATORS = 20
const MAX_FILTER = 500
const MAX_SIZE_KB = 1024 * 1024
const unchanged = { stateChanged: false }
const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?\.[a-z]{2,63}$/
const PATTERN = /^[\x21-\x7e]{1,254}$/
const bad = (field: string): never => fail('VALIDATION', 'the list posting policy is invalid', { ...unchanged, field })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

const entries = (value: unknown, field: string, max: number, shape: RegExp): string[] => {
  if (!Array.isArray(value) || value.length > max) return bad(field)
  const rows = value.map(item => typeof item === 'string' ? item.trim().toLowerCase() : '')
  return rows.every(item => shape.test(item)) && new Set(rows).size === rows.length ? rows : bad(field)
}
const action = (value: unknown, field: string): services.ListPostingAction => (services.LIST_POSTING_ACTIONS as readonly unknown[]).includes(value) ? value as services.ListPostingAction : bad(field)
const whole = (value: unknown, field: string, max: number): number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= max ? value as number : bad(field)
const flag = (value: unknown, field: string): boolean => typeof value === 'boolean' ? value : bad(field)

export function parseListPolicy(value: unknown): ListPolicy {
  if (!object(value) || Object.keys(value).sort().join() !== [...LIST_POLICY_FIELDS].sort().join()) return bad('policy')
  return {
    moderators: entries(value.moderators, 'moderators', MAX_MODERATORS, EMAIL), moderatedMembers: entries(value.moderatedMembers, 'moderatedMembers', services.MAX_LIST_MEMBERS, EMAIL),
    nonMemberAction: action(value.nonMemberAction, 'nonMemberAction'), memberAction: action(value.memberAction, 'memberAction'),
    acceptSenders: entries(value.acceptSenders, 'acceptSenders', MAX_FILTER, PATTERN), holdSenders: entries(value.holdSenders, 'holdSenders', MAX_FILTER, PATTERN),
    rejectSenders: entries(value.rejectSenders, 'rejectSenders', MAX_FILTER, PATTERN), discardSenders: entries(value.discardSenders, 'discardSenders', MAX_FILTER, PATTERN),
    maxMessageKb: whole(value.maxMessageKb, 'maxMessageKb', MAX_SIZE_KB), notifyModerators: flag(value.notifyModerators, 'notifyModerators'), notifySender: flag(value.notifySender, 'notifySender'),
    retentionDays: whole(value.retentionDays, 'retentionDays', 365),
  }
}

/** An open list with no rule stays a plain alias and pays nothing at delivery. */
export const listGated = (moderation: string, policy: ListPolicy): boolean => moderation !== 'open' || policy.moderatedMembers.length > 0 || policy.maxMessageKb > 0
  || policy.holdSenders.length > 0 || policy.rejectSenders.length > 0 || policy.discardSenders.length > 0

export const listGateRules = (list: { address: string; members: readonly string[]; moderation: ListPosting; policy: ListPolicy }, home: string): services.ListGateRules => ({
  ...list.policy, address: list.address.toLowerCase(), store: services.listGateStore(home, list.address), members: services.mailingListTargets(list.members), posting: list.moderation,
})

/** Sieve `execute` needs the same module as BoxTrapper; the plugin path differs by family, and no other family exists. */
export const listGateHostReady = (): boolean => Object.values(BOXTRAPPER_PLUGIN).some(path => existsSync(path))
export const listGateProgram = async (node = process.execPath): Promise<string> => `#!${node} --jitless\n${await readFile(new URL('./list-gate-program.cjs', import.meta.url), 'utf8')}`
