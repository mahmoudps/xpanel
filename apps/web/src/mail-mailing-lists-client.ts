import { MAIL_CLIENT_TEMPLATE_KIT, mailTemplate as canonicalMailTemplate, mailSlot as canonicalMailSlot, mailRequireTemplates as canonicalMailRequireTemplates } from './mail-client-template-kit.ts'
const mailTemplate = canonicalMailTemplate
const mailSlot = canonicalMailSlot
const mailRequireTemplates = canonicalMailRequireTemplates
/// <reference lib="dom" />
import { mailToolsExact as importedMailToolsExact, mailToolsObject as importedMailToolsObject, mailToolsUncertain as importedMailToolsUncertain } from './mail-spam-client.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
// Local bindings survive function-source serialization when SSR rewrites module imports.
const mailToolsExact = importedMailToolsExact, mailToolsObject = importedMailToolsObject, mailToolsUncertain = importedMailToolsUncertain
export interface MailListRow { id: string; address: string; name: string; revision: string; subscriptionPolicy: 'open' | 'closed'; postingPolicy: 'open' | 'members' | 'moderated'; membership: 'subscribed' | 'not_subscribed' | 'review_required'; canSubscribe: boolean; canUnsubscribe: boolean }
export interface MailListsSnapshot { mailbox: string; revision: string; lists: MailListRow[] }
export function readMailMailingLists(raw: unknown, mailbox: string): MailListsSnapshot {
  const bad = (): never => { throw new Error('invalid_mailing_lists') }, optional = mailToolsObject(raw) && Object.hasOwn(raw, 'stateChanged')
  if (!mailToolsExact(raw, ['context', 'revision', 'lists', 'metadataReview', 'capabilities', 'application', ...(optional ? ['stateChanged'] : [])]) || !mailToolsExact(raw.context, ['mailbox']) || raw.context.mailbox !== mailbox || typeof raw.revision !== 'string' || !/^[0-9a-f]{64}$/.test(raw.revision) || optional && typeof raw.stateChanged !== 'boolean' || !Array.isArray(raw.lists) || raw.lists.length > 10_000) return bad()
  if (!mailToolsExact(raw.metadataReview, ['status', 'reason']) || raw.metadataReview.status !== 'review_required' || raw.metadataReview.reason !== 'mailbox_metadata_binding_unverified' || !mailToolsExact(raw.capabilities, ['moderation', 'archive', 'delivery']) || raw.capabilities.moderation !== false || raw.capabilities.archive !== false || raw.capabilities.delivery !== 'unverified' || !mailToolsExact(raw.application, ['status', 'nativeApplied']) || raw.application.status !== 'configuration_only' || raw.application.nativeApplied !== false) return bad()
  const lists = raw.lists.map(item => {
    if (!mailToolsExact(item, ['id', 'address', 'name', 'revision', 'subscriptionPolicy', 'postingPolicy', 'membership', 'canSubscribe', 'canUnsubscribe']) || typeof item.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item.id) || typeof item.address !== 'string' || item.address.length > 254 || !/^[^\s@/\\\u0000-\u001f\u007f]+@[^\s@/\\\u0000-\u001f\u007f]+$/.test(item.address) || typeof item.name !== 'string' || item.name.length > 128 || /[\u0000-\u001f\u007f]/.test(item.name) || typeof item.revision !== 'string' || !/^[0-9a-f]{64}$/.test(item.revision) || !['open', 'closed'].includes(String(item.subscriptionPolicy)) || !['open', 'members', 'moderated'].includes(String(item.postingPolicy)) || !['subscribed', 'not_subscribed', 'review_required'].includes(String(item.membership)) || typeof item.canSubscribe !== 'boolean' || typeof item.canUnsubscribe !== 'boolean') return bad()
    if (item.canSubscribe && (item.subscriptionPolicy !== 'open' || item.membership !== 'not_subscribed') || item.canUnsubscribe !== (item.membership === 'subscribed') || item.subscriptionPolicy === 'closed' && item.membership !== 'subscribed') return bad()
    return item as unknown as MailListRow
  })
  if (new Set(lists.map(item => item.id)).size !== lists.length || new Set(lists.map(item => item.address.toLowerCase())).size !== lists.length) return bad()
  return { mailbox, revision: raw.revision, lists }
}
function bindMailMailingLists(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-mail-mailing-lists]').forEach(root => {
    if (root.dataset.listsBound === 'true') return; root.dataset.listsBound = 'true'
    const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest, mailbox = root.dataset.listsMailbox ?? ''
    const status = root.querySelector<HTMLElement>('[data-lists-status]')!, rows = root.querySelector<HTMLTableSectionElement>('[data-lists-rows]')!, refresh = root.querySelector<HTMLButtonElement>('[data-lists-refresh]')!
    if (!status || !rows || !refresh) return
    try { mailRequireTemplates(root, [['mail-membership-row', 'tr', ['address', 'name', 'observed', 'subscription', 'posting', 'membership', 'action']], ['mail-membership-empty', 'tr', ['message']]]) }
    catch { refresh.disabled = true; status.dataset.state = 'unavailable'; status.textContent = t('Mailing lists are unavailable for this mailbox session. Nothing was read.'); return }
    const admitted = (): boolean => root.isConnected && root.dataset.listsManage === 'true' && root.dataset.listsMailbox === mailbox && !!mailbox && !!send && !root.closest('[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled')
    let snapshot: MailListsSnapshot | null = null, busy = false, locked = false
    const note = (state: string, text: string): void => { status.dataset.state = state; status.textContent = text; status.setAttribute('role', ['failed', 'stale', 'uncertain'].includes(state) ? 'alert' : 'status') }
    const sync = (): void => { refresh.disabled = !admitted() || busy; for (const button of rows.querySelectorAll<HTMLButtonElement>('button[data-list-action]')) { const list = snapshot?.lists.find(item => item.id === button.dataset.listId); button.disabled = !admitted() || busy || locked || !list || !(button.dataset.listAction === 'subscribe' ? list.canSubscribe : list.canUnsubscribe) } root.setAttribute('aria-busy', String(busy)) }
    const paint = (): void => {
      rows.textContent = ''
      if (!snapshot?.lists.length) { const row = mailTemplate(root, 'mail-membership-empty', 'tr', ['message']); mailSlot(row, 'message').textContent = snapshot ? t('No public lists or verified memberships are available for this mailbox.') : t('The mailing lists have not been read.'); rows.append(row) }
      for (const list of snapshot?.lists ?? []) {
        const row = mailTemplate(root, 'mail-membership-row', 'tr', ['address', 'name', 'observed', 'subscription', 'posting', 'membership', 'action'])
        for (const [key, value] of [['address', list.address], ['name', list.name], ['observed', t(msgctxt('mail-mailing-lists-client', 'Not observed'))], ['subscription', list.subscriptionPolicy === 'open' ? t('Public subscription') : t('Private list')], ['posting', t('Not exposed')], ['membership', list.membership === 'subscribed' ? t('Subscribed (saved)') : list.membership === 'review_required' ? t('Provider review required') : t('Not subscribed')]] as const) mailSlot(row, key).textContent = value
        const button = mailSlot<HTMLButtonElement>(row, 'action', 'button'); button.dataset.listId = list.id; button.dataset.listAction = list.membership === 'subscribed' ? 'unsubscribe' : 'subscribe'; button.textContent = list.membership === 'subscribed' ? t('Unsubscribe') : t('Subscribe'); button.addEventListener('click', () => { void mutate(list) }); rows.append(row)
      }
      sync()
    }
    const read = async (): Promise<MailListsSnapshot> => readMailMailingLists(await send!('GET', '/api/webmail/mailing-lists'), mailbox)
    const load = async (): Promise<void> => { if (!admitted() || busy) return; busy = true; sync(); note('reading', t('Reading your list memberships…')); try { const next = await read(); if (!admitted()) throw new Error('mailbox_changed'); snapshot = next; locked = false; paint(); note('read', t('Membership configuration read. Native list delivery remains unverified.')) } catch { snapshot = null; locked = true; paint(); note('failed', t('The list memberships could not be verified. Read them again.')) } finally { busy = false; sync() } }
    const mutate = async (selected: MailListRow): Promise<void> => {
      const subscribed = selected.membership !== 'subscribed'
      if (!admitted() || !snapshot || busy || locked || !(subscribed ? selected.canSubscribe : selected.canUnsubscribe) || !askDialog) return
      const before = snapshot; let submitted = false; busy = true; sync()
      try {
        const confirmed = await askDialog({ title: subscribed ? t('Subscribe this mailbox?') : t('Unsubscribe this mailbox?'), body: subscribed ? t('Save a subscription for {mailbox} in {list}. Mail delivery is not verified.', { mailbox, list: selected.address }) : t('Remove the saved membership of {mailbox} in {list}. Mail delivery is not verified.', { mailbox, list: selected.address }), confirm: subscribed ? t('Subscribe') : t('Unsubscribe'), danger: !subscribed })
        if (confirmed !== true || !admitted() || snapshot !== before) return
        note('saving', t('Saving your membership…'))
        submitted = true
        const ack = readMailMailingLists(await send!('PUT', '/api/webmail/mailing-lists/' + selected.id + '/subscription', { subscribed, expectedRevision: selected.revision }), mailbox), changed = ack.lists.find(item => item.id === selected.id)
        if (subscribed ? changed?.membership !== 'subscribed' : changed !== undefined && changed.membership !== 'not_subscribed') throw new Error('invalid_subscription_ack')
        const observed = await read(); if (observed.revision !== ack.revision || JSON.stringify(observed.lists) !== JSON.stringify(ack.lists) || !admitted()) throw new Error('invalid_subscription_readback')
        snapshot = observed; locked = false; paint(); note('saved', t('Your membership was saved and read back. Native delivery remains unverified.'))
      } catch (error) { if (!submitted) { note('failed', t('Confirmation was unavailable. Nothing was sent.')); return } const raw = mailToolsObject(error) ? error : {}, stale = raw.status === 409 || raw.code === 'CONFLICT'; locked = stale || mailToolsUncertain(error); note(stale ? 'stale' : locked ? 'uncertain' : 'failed', stale ? t('The list changed. Read current memberships before another action.') : locked ? t('The result is uncertain. Read saved memberships before another action.') : t('The request was refused. No membership change was confirmed.')) }
      finally { busy = false; sync() }
    }
    refresh.addEventListener('click', () => { void load() })
    if (!admitted()) { sync(); note('unavailable', t('Mailing lists are unavailable for this mailbox session. Nothing was read.')); return } void load()
  })
}
export const MAIL_MAILING_LISTS_CLIENT_BINDING = `(()=>{${MAIL_CLIENT_TEMPLATE_KIT}const mailToolsObject=${mailToolsObject.toString()};const mailToolsExact=${mailToolsExact.toString()};const mailToolsUncertain=${mailToolsUncertain.toString()};const readMailMailingLists=${readMailMailingLists.toString()};return ${bindMailMailingLists.toString()};})()`
