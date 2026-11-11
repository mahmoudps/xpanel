import '../../web/src/i18n.ts'
import { fail } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import { translator } from '../../web/src/i18n.ts'
import type { Locale } from '../../web/src/i18n.ts'
import type { AuthenticatedCaller } from './auth.ts'
import { workspaceJson } from './account-ssh-workspace.ts'
import type { EmailSender } from './alert-delivery.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { readSecRaw, secBody, secRevisionOf, writeSecRecord } from './sec-workspace.ts'
import { readSecRecord, secRevision } from '../../agent/src/sec-policy.ts'
import { NOTIFICATION_TEMPLATE_LOCALES, NOTIFICATION_TEMPLATE_VARS, parseNotificationTemplate } from '../../agent/src/mail-cert-policy.ts'
import type { NotificationLocale, NotificationTemplate, NotificationTemplatesPolicy, NotificationText } from '../../agent/src/mail-cert-policy.ts'

const BASE = '/api/server/notification-templates'
const unchanged = { stateChanged: false }
const invalid = (message: string): never => fail('VALIDATION', message, unchanged)
const EVENT_LABELS: Readonly<Record<string, string>> = {
  'account.provisioned': msgid('Account created'), 'account.suspended': msgid('Account suspended'), 'account.unsuspended': msgid('Account unsuspended'),
  'quota.warning': msgid('Disk quota warning'), 'ssl.renewal': msgid('Certificate renewal report'), 'mail.outbound_hold': msgid('Outgoing mail held'),
}
const DEFAULTS: Readonly<Record<string, NotificationText>> = {
  'account.provisioned': { subject: msgid('Your hosting account {account} is ready'), body: msgid('The hosting account {account} for {domain} is ready on {server}.') },
  'account.suspended': { subject: msgid('Your hosting account {account} is suspended'), body: msgid('The hosting account {account} for {domain} on {server} is suspended. Contact your provider for details.') },
  'account.unsuspended': { subject: msgid('Your hosting account {account} is active again'), body: msgid('The hosting account {account} for {domain} on {server} is active again.') },
  'quota.warning': { subject: msgid('Disk quota warning for {account}'), body: msgid('The account {account} on {server} uses {usedMb} MiB of its {limitMb} MiB disk quota ({percent}%).') },
  'ssl.renewal': { subject: msgid('Certificate report for {server}'), body: msgid('Automatic certificate results for {account}:\n\n{summary}') },
  'mail.outbound_hold': { subject: msgid('Outgoing mail from {target} is held'), body: msgid('{target} delivered {count} messages this {window}, over its limit of {limit}. Further messages stay on hold on {server} until an administrator releases them.') },
}
const SAMPLE: Readonly<Record<string, string>> = { account: 'alice', domain: 'example.com', server: 'server.example.com', usedMb: '4500', limitMb: '5000', percent: '90', summary: 'example.com: renewed', target: 'sales@example.com', count: '250', limit: '200', window: 'hour' }

export const notificationEvents = (): string[] => Object.keys(NOTIFICATION_TEMPLATE_VARS)
const defaultText = (event: string, locale: NotificationLocale): NotificationText => { const t = translator(locale as Locale), item = DEFAULTS[event]!; return { subject: t(item.subject), body: t(item.body) } }
const defaultTemplate = (event: string): NotificationTemplate => ({ en: defaultText(event, 'en'), ar: defaultText(event, 'ar') })
/** Values fill a template as text; a header line never takes a line break from them. */
export const fillNotification = (text: NotificationText, values: Readonly<Record<string, string>>): NotificationText => {
  const fill = (source: string): string => source.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_, name: string) => values[name] ?? '')
  return { subject: fill(text.subject).replace(/[\r\n]+/g, ' ').slice(0, 300), body: fill(text.body) }
}
const readPolicy = async (store: Pick<StateStore, 'rootDir'>): Promise<{ raw: unknown; policy: NotificationTemplatesPolicy | null }> => {
  const raw = await readSecRaw(store, 'notification-templates')
  return { raw, policy: raw === null ? { templates: {} } : readSecRecord('notification-templates', raw)?.policy ?? null }
}
/** The saved template of an event, or the product default when none is saved or the saved file does not parse. */
export async function notificationText(store: Pick<StateStore, 'rootDir'>, event: string, locale: NotificationLocale, values: Readonly<Record<string, string>>): Promise<NotificationText> {
  const { policy } = await readPolicy(store).catch(() => ({ policy: null }))
  return fillNotification(policy?.templates[event]?.[locale] ?? defaultText(event, locale), values)
}
export interface NotificationDelivery { store: Pick<StateStore, 'rootDir'>; email: EmailSender }
/** One notice to one address; a recipient never learns another's address. */
export async function sendNotification(delivery: NotificationDelivery, input: { event: string; to: string; locale: NotificationLocale; values: Readonly<Record<string, string>> }): Promise<void> {
  const text = await notificationText(delivery.store, input.event, input.locale, input.values)
  await delivery.email({ to: [input.to], subject: text.subject, text: text.body })
}

export interface NotificationTemplateHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  store: StateStore
  email: () => Promise<EmailSender>
  adminEmail: () => Promise<string | null>
}

/** WHM notification templates. A save replaces one event's English and Arabic versions; reset returns the event to the product text. */
export async function handleNotificationTemplateRoute(request: Request, url: URL, method: string, helpers: NotificationTemplateHelpers): Promise<Response | null> {
  const p = url.pathname
  if (p !== BASE && !p.startsWith(BASE + '/')) return null
  const op = p.slice(BASE.length + 1), action = 'server.notification-templates.' + (op || 'read')
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, action)
  const expected = op ? 'POST' : 'GET'
  if (!['', 'save', 'reset', 'preview', 'test'].includes(op)) return null
  if (method !== expected) return new Response(null, { status: 405, headers: { allow: expected } })
  if (url.search) return invalid('this route takes no selectors')
  const fresh = async (): Promise<AuthenticatedCaller> => { const current = await helpers.requireCaller(request); await helpers.assertRoot(current, action); return current }
  const view = async () => {
    const { raw, policy } = await readPolicy(helpers.store)
    if (!policy) return fail('PRECONDITION_FAILED', 'saved templates require review', unchanged)
    return { revision: secRevision('notification-templates', raw), events: notificationEvents().map(event => { const saved = policy.templates[event], item = saved ?? defaultTemplate(event)
      return { event, label: EVENT_LABELS[event]!, state: saved ? 'custom' : 'default', variables: NOTIFICATION_TEMPLATE_VARS[event]!.map(name => '{' + name + '}').join(' '), en: item.en, ar: item.ar } }) }
  }
  if (!op) return workspaceJson(await view())
  const body = await secBody(request, 64 * 1024)
  const event = typeof body.event === 'string' && Object.hasOwn(NOTIFICATION_TEMPLATE_VARS, body.event) ? body.event : invalid('choose a notification event')
  if (op === 'save' || op === 'reset') {
    if (Object.keys(body).filter(key => op === 'save' || key !== 'locale').sort().join() !== (op === 'save' ? 'ar,en,event,expectedRevision' : 'event,expectedRevision')) return invalid('unsupported template fields')
    const template = op === 'save' ? parseNotificationTemplate(event, { en: body.en, ar: body.ar }) : null
    await writeSecRecord(helpers, 'notification-templates', secRevisionOf(body.expectedRevision), raw => {
      const templates = { ...(raw === null ? {} : readSecRecord('notification-templates', raw)!.policy.templates) }
      if (template) templates[event] = template; else delete templates[event]
      return { templates }
    }, fresh)
    const actor = await fresh()
    await helpers.emitAudit({ actor: actor.principal.username, action: 'server.notification-templates.' + (op === 'save' ? 'saved' : 'reset'), target: 'notification:' + event, principalId: actor.principal.id, outcome: 'ok', detail: {} }).catch(() => fail('SERVICE_UNAVAILABLE', 'the template was saved but its audit record requires review', { stateChanged: true, verificationRequired: true }))
    return workspaceJson(await view())
  }
  const locale = (body.locale ?? 'en') as NotificationLocale
  if (!NOTIFICATION_TEMPLATE_LOCALES.includes(locale)) return invalid('choose English or Arabic')
  const rendered = await notificationText(helpers.store, event, locale, SAMPLE)
  if (op === 'preview') return workspaceJson({ event, locale, ...rendered })
  const to = await helpers.adminEmail()
  if (!to) return fail('PRECONDITION_FAILED', 'the server has no administrator address', { ...unchanged, reason: 'contact_unavailable' })
  const actor = await fresh()
  try { await (await helpers.email())({ to: [to], subject: rendered.subject, text: rendered.body }) }
  catch { return fail('SERVICE_UNAVAILABLE', 'the local mail server did not accept the test message', { ...unchanged, reason: 'mail_refused' }) }
  await helpers.emitAudit({ actor: actor.principal.username, action: 'server.notification-templates.tested', target: 'notification:' + event, principalId: actor.principal.id, outcome: 'ok', detail: { locale } }).catch(() => undefined)
  return workspaceJson({ event, locale, sentTo: to })
}
