import { fail } from '@xpanel/core'
import { services } from '@xpanel/render'

/**
 * Saved BoxTrapper settings of one mailbox, as cPanel keeps them per mailbox. The allow, ignore and deny lists, the queue
 * and the log live with the mailbox and belong to the account, because the delivery program writes them as it decides.
 */
export const BOXTRAPPER_TEMPLATES = ['verify', 'released', 'failed', 'deny'] as const
export type BoxTrapperTemplateName = (typeof BOXTRAPPER_TEMPLATES)[number]
export interface BoxTrapperTemplate { subject: string; body: string }
export interface BoxTrapperConfig {
  enabled: boolean
  /** other addresses that deliver into this mailbox */
  extraAddresses: string[]
  displayName: string
  /** days to keep the log and the queue */
  retentionDays: number
  /** mail scoring below this bypasses verification */
  spamBypass: number
  autoAllowSent: boolean
  allowByAssociation: boolean
  /** addresses that receive a copy of allowed mail */
  forward: string[]
  /** null keeps the default text */
  templates: Record<BoxTrapperTemplateName, BoxTrapperTemplate | null>
}
export const BOXTRAPPER_FIELDS = ['enabled', 'extraAddresses', 'displayName', 'retentionDays', 'spamBypass', 'autoAllowSent', 'allowByAssociation', 'forward', 'templates'] as const
export const BOXTRAPPER_MAX_FORWARD = services.MAX_SIEVE_REDIRECTS
const MAX_EXTRA = 50
export const BOXTRAPPER_DEFAULT_TEMPLATES: Record<BoxTrapperTemplateName, BoxTrapperTemplate> = {
  verify: { subject: 'Please verify your message to {mailbox}: verify#{token}', body: 'Your message to {mailbox} with the subject "{subject}" is being held until you confirm that you sent it.\n\nTo release it, reply to this message and keep the subject unchanged. Do this once; you will not be asked again.\n\nIf you did not send a message to {mailbox}, ignore this notice.\n' },
  released: { subject: 'Your message to {mailbox} was delivered', body: 'Thank you. Your message with the subject "{subject}" was delivered to {mailbox}, and your future messages will arrive without verification.\n' },
  failed: { subject: 'Your verification for {mailbox} could not be matched', body: 'We could not match your reply to a held message. The message may have expired or been released already. Send your message again if it is still needed.\n' },
  deny: { subject: 'Your message to {mailbox} was not delivered', body: 'Your message with the subject "{subject}" was not delivered, because {mailbox} does not accept mail from your address.\n' },
}
export const BOXTRAPPER_DEFAULTS: BoxTrapperConfig = { enabled: false, extraAddresses: [], displayName: '', retentionDays: 15, spamBypass: -2.5, autoAllowSent: true, allowByAssociation: true, forward: [], templates: { verify: null, released: null, failed: null, deny: null } }

const bad = (field: string): never => fail('VALIDATION', 'BoxTrapper settings are invalid', { stateChanged: false, field })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const CONTROL = /[\u0000-\u001f\u007f]/
const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?\.[a-z]{2,63}$/
const addressList = (value: unknown, field: string, max: number): string[] => {
  if (!Array.isArray(value) || value.length > max) return bad(field)
  const list = value.map(item => typeof item === 'string' ? item.trim().toLowerCase() : '')
  return list.every(item => EMAIL.test(item)) && new Set(list).size === list.length ? list : bad(field)
}
function template(value: unknown, name: BoxTrapperTemplateName): BoxTrapperTemplate | null {
  if (value === null) return null
  if (!object(value) || Object.keys(value).sort().join() !== 'body,subject' || typeof value.subject !== 'string' || typeof value.body !== 'string') return bad('templates.' + name)
  if (!value.subject.trim() || value.subject.length > 200 || CONTROL.test(value.subject) || !value.body.trim() || value.body.length > 4000 || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(value.body.replaceAll('\r', ''))) return bad('templates.' + name)
  // A reply is recognised by this token alone.
  if (name === 'verify' && !value.subject.includes('verify#{token}')) return fail('VALIDATION', 'the verify subject must keep verify#{token}', { stateChanged: false, field: 'templates.verify', reason: 'boxtrapper_token_required' })
  return { subject: value.subject, body: value.body.replaceAll('\r\n', '\n') }
}
export function parseBoxTrapperConfig(value: unknown): BoxTrapperConfig {
  if (!object(value) || BOXTRAPPER_FIELDS.some(key => !Object.hasOwn(value, key))) return bad('config')
  if (typeof value.enabled !== 'boolean') return bad('enabled')
  if (typeof value.autoAllowSent !== 'boolean') return bad('autoAllowSent')
  if (typeof value.allowByAssociation !== 'boolean') return bad('allowByAssociation')
  if (typeof value.displayName !== 'string' || value.displayName.length > 100 || CONTROL.test(value.displayName) || /["<>\\]/.test(value.displayName)) return bad('displayName')
  if (!Number.isInteger(value.retentionDays) || (value.retentionDays as number) < 1 || (value.retentionDays as number) > 365) return bad('retentionDays')
  if (typeof value.spamBypass !== 'number' || !Number.isFinite(value.spamBypass) || value.spamBypass < -100 || value.spamBypass > 100) return bad('spamBypass')
  const templates = value.templates
  if (!object(templates) || Object.keys(templates).sort().join() !== [...BOXTRAPPER_TEMPLATES].sort().join()) return bad('templates')
  return {
    enabled: value.enabled, extraAddresses: addressList(value.extraAddresses, 'extraAddresses', MAX_EXTRA), displayName: value.displayName.trim(), retentionDays: value.retentionDays as number, spamBypass: value.spamBypass,
    autoAllowSent: value.autoAllowSent, allowByAssociation: value.allowByAssociation, forward: addressList(value.forward, 'forward', BOXTRAPPER_MAX_FORWARD),
    templates: Object.fromEntries(BOXTRAPPER_TEMPLATES.map(name => [name, template(templates[name], name)])) as BoxTrapperConfig['templates'],
  }
}

/** The rule file the delivery program reads. The score bypass needs a filter that rewrites its own header, or a sender could forge it. */
export const boxTrapperRules = (config: BoxTrapperConfig, mailbox: string, store: string, spamFilterWired: boolean): services.BoxTrapperRules => ({
  mailbox, store, extraAddresses: config.extraAddresses, displayName: config.displayName, retentionDays: config.retentionDays, spamBypass: spamFilterWired ? config.spamBypass : null,
  autoAllowSent: config.autoAllowSent, allowByAssociation: config.allowByAssociation, dailyNotices: 100,
  templates: Object.fromEntries(BOXTRAPPER_TEMPLATES.map(name => [name, config.templates[name] ?? BOXTRAPPER_DEFAULT_TEMPLATES[name]])) as services.BoxTrapperRules['templates'],
})
