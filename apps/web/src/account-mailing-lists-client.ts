import type { MessageValues } from './i18n.ts'
import './i18n.ts'
/// <reference lib="dom" />

/**
 * Account mailing lists browser controller.
 * Reads/writes the real `/api/mail/mailing-lists` route. Stored list configuration only;
 * no delivery, subscription confirmation or archive behaviour is claimed.
 */

const mailingUnsafe = /[\u0000-\u001f\u007f-\u009f]/
const mailingEmail = /^[^\s@/\\]+@[^\s@/\\]+$/
const mailingName = /^[a-z0-9](?:[a-z0-9._-]{0,63})$/
const MODERATION = ['open', 'members', 'moderated'] as const

export interface MailingListRecordView {
  id: string; accountId: string; name: string; domain: string; address: string; members: string[]
  moderation: 'open' | 'members' | 'moderated'; archiveEnabled: boolean; createdAt: string
}
export interface MailingListDraft {
  name: string; domain: string; members: string[]; moderation: 'open' | 'members' | 'moderated'; archiveEnabled: boolean
}

export function mailingObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
export function readMailingList(value: unknown, accountId: string): MailingListRecordView {
  if (!mailingObject(value)) throw new Error('invalid_mailing_list')
  if (typeof value.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.id) || value.accountId !== accountId) throw new Error('invalid_mailing_list')
  if (typeof value.name !== 'string' || !value.name.isWellFormed() || value.name.length > 128 || mailingUnsafe.test(value.name)) throw new Error('invalid_mailing_list')
  if (typeof value.domain !== 'string' || !/^[a-z0-9.-]{1,253}$/i.test(value.domain)) throw new Error('invalid_mailing_list')
  if (typeof value.address !== 'string' || value.address.length > 254 || !mailingEmail.test(value.address)) throw new Error('invalid_mailing_list')
  if (!Array.isArray(value.members) || value.members.length > 1000 || value.members.some(member => typeof member !== 'string' || !mailingEmail.test(member))) throw new Error('invalid_mailing_list')
  if (new Set(value.members as string[]).size !== (value.members as string[]).length) throw new Error('invalid_mailing_list')
  if (typeof value.moderation !== 'string' || !MODERATION.includes(value.moderation as never)) throw new Error('invalid_mailing_list')
  if (typeof value.archiveEnabled !== 'boolean') throw new Error('invalid_mailing_list')
  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) throw new Error('invalid_mailing_list')
  return { id: value.id, accountId: value.accountId, name: value.name, domain: value.domain, address: value.address, members: value.members as string[], moderation: value.moderation as MailingListRecordView['moderation'], archiveEnabled: value.archiveEnabled, createdAt: value.createdAt }
}
export function readMailingLists(value: unknown, accountId: string): MailingListRecordView[] {
  if (!mailingObject(value) || !Array.isArray(value.mailingLists)) throw new Error('invalid_mailing_lists')
  const lists = value.mailingLists.map(raw => readMailingList(raw, accountId))
  if (new Set(lists.map(list => list.id)).size !== lists.length) throw new Error('invalid_mailing_lists')
  if (new Set(lists.map(list => list.address.toLowerCase())).size !== lists.length) throw new Error('invalid_mailing_lists')
  return lists
}

export function mailingListDraft(values: { name: unknown; domain: unknown; members: unknown; moderation: unknown; archiveEnabled: unknown }): MailingListDraft {
  if (typeof values.name !== 'string') throw new Error('invalid_list_name')
  const name = values.name.trim().toLowerCase()
  if (!mailingName.test(name)) throw new Error('invalid_list_name')
  if (typeof values.domain !== 'string' || !/^[a-z0-9.-]{1,253}$/i.test(values.domain.trim())) throw new Error('invalid_list_domain')
  const domain = values.domain.trim().toLowerCase()
  if (typeof values.members !== 'string') throw new Error('invalid_list_members')
  const members: string[] = []
  for (const raw of values.members.split(/[\n,]/)) {
    const member = raw.trim().toLowerCase()
    if (!member) continue
    if (!mailingEmail.test(member) || member.length > 254 || mailingUnsafe.test(member)) throw new Error('invalid_list_member')
    if (members.includes(member)) throw new Error('duplicate_list_member')
    members.push(member)
  }
  if (members.length > 1000) throw new Error('too_many_list_members')
  if (typeof values.moderation !== 'string' || !MODERATION.includes(values.moderation as never)) throw new Error('invalid_list_moderation')
  if (typeof values.archiveEnabled !== 'boolean') throw new Error('invalid_list_archive')
  return { name, domain, members, moderation: values.moderation as MailingListDraft['moderation'], archiveEnabled: values.archiveEnabled }
}

export function mailingListMatches(record: MailingListRecordView, draft: MailingListDraft): boolean {
  return record.name === draft.name && record.domain === draft.domain && record.address === draft.name + '@' + draft.domain
    && record.members.length === draft.members.length && record.members.every((member, index) => member === draft.members[index])
    && record.moderation === draft.moderation && record.archiveEnabled === draft.archiveEnabled
}

function bindMailingLists(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const copy = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-mailing-lists]').forEach(root => {
    if (root.dataset.mailingListsBound === 'true') return
    root.dataset.mailingListsBound = 'true'
    const accountId = root.dataset.account ?? ''
    const manageable = root.dataset.mailingCanManage === 'true'
    const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const rows = root.querySelector<HTMLTableSectionElement>('[data-mailing-lists-rows]')
    const status = root.querySelector<HTMLElement>('[data-mailing-list-status]')
    const nameInput = root.querySelector<HTMLInputElement>('[data-ml-name]')
    const domainInput = root.querySelector<HTMLSelectElement>('[data-ml-domain]')
    const membersInput = root.querySelector<HTMLTextAreaElement>('[data-ml-members]')
    const moderationInput = root.querySelector<HTMLSelectElement>('[data-ml-moderation]')
    const archiveInput = root.querySelector<HTMLInputElement>('[data-ml-archive]')
    const createButton = root.querySelector<HTMLButtonElement>('[data-ml-create]')
    if (!rows || !status) return
    const denied = '[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const eligible = (): boolean => root.isConnected && manageable && !root.closest(denied) && /^[0-9a-f-]{36}$/i.test(accountId)
    let lists: MailingListRecordView[] = []
    let busy = false, uncertain = false
    const controls = (): (HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)[] => [...root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('button,input,textarea,select')]
    const setStatus = (message: string, kind: string): void => {
      status.hidden = !message
      status.dataset.state = kind
      status.setAttribute('role', kind === 'failed' || kind === 'uncertain' ? 'alert' : 'status')
      status.textContent = message
    }
    const lock = (): void => { const blocked = busy || uncertain || !eligible(); controls().forEach(control => { control.disabled = blocked }) }
    const request = (method: string, path: string, body?: unknown): Promise<unknown> => {
      if (!transport) return Promise.reject(Object.assign(new Error('transport_unavailable'), { stateChanged: false }))
      return transport(method, path, body)
    }
    const paint = (): void => {
      rows.textContent = ''
      if (!lists.length) {
        const row = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = 5
        cell.textContent = copy('No mailing lists have been saved for this account.')
        row.appendChild(cell); rows.appendChild(row); lock(); return
      }
      for (const list of lists) {
        const row = document.createElement('tr'); row.dataset.mailingListId = list.id
        const cell = (value: string, technical = false) => { const node = document.createElement('td'); if (technical) { const bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.className = 'xp-mono'; bdi.textContent = value; node.replaceChildren(bdi) } else node.textContent = value; row.appendChild(node) }
        cell(list.address, true)
        cell(String(list.members.length), true)
        cell(list.moderation === 'open' ? copy('Open') : list.moderation === 'moderated' ? copy('Moderated') : copy('Members'))
        cell(list.archiveEnabled ? copy(msgctxt('account-mailing-lists-client', 'Kept')) : copy('Not kept'))
        const action = document.createElement('td')
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'xp-btn xp-btn--danger'; remove.textContent = copy('Delete list')
        remove.addEventListener('click', () => { if (remove.disabled || !eligible()) return; void deleteList(list) })
        action.appendChild(remove); row.appendChild(action); rows.appendChild(row)
      }
      lock()
    }
    const load = async (): Promise<void> => {
      lists = readMailingLists(await request('GET', '/api/mail/mailing-lists'), accountId)
      paint()
    }
    const runWrite = async (work: () => Promise<void>): Promise<void> => {
      if (busy || uncertain || !eligible()) return
      busy = true; lock()
      try { await work() } catch (error) {
        const detail = mailingObject(error) && mailingObject(error.details) ? error.details : {}
        const certain = mailingObject(error) && (error.stateChanged === false || detail.stateChanged === false) && detail.unknownOutcome !== true && detail.verificationRequired !== true
        if (!certain) {
          uncertain = true
          setStatus(copy('The outcome is uncertain. Reload the page and inspect stored mailing lists before retrying; no automatic retry was sent.'), 'uncertain')
        } else {
          setStatus(copy('The mailing list action was refused or did not verify. Nothing was retried.'), 'failed')
        }
      } finally { busy = false; lock() }
    }
    const createList = async (): Promise<void> => {
      if (!eligible() || busy || uncertain) return
      let draft: MailingListDraft
      try {
        draft = mailingListDraft({ name: nameInput?.value ?? '', domain: domainInput?.value ?? '', members: membersInput?.value ?? '', moderation: moderationInput?.value ?? 'members', archiveEnabled: archiveInput?.checked ?? true })
      } catch {
        setStatus(copy('List name (up to 64 lowercase characters), an account domain, unique member addresses and a moderation choice are required. Nothing was sent.'), 'failed')
        return
      }
      await runWrite(async () => {
        const reply = await request('POST', '/api/mail/mailing-lists', { accountId, name: draft.name, domain: draft.domain, members: draft.members, moderation: draft.moderation, archiveEnabled: draft.archiveEnabled })
        if (!mailingObject(reply) || !mailingObject(reply.mailingList)) throw new Error('invalid_mailing_list_ack')
        const created = readMailingList(reply.mailingList, accountId)
        if (!mailingListMatches(created, draft)) throw new Error('mailing_list_readback_mismatch')
        await load()
        const observed = lists.find(list => list.id === created.id)
        if (!observed || !mailingListMatches(observed, draft)) throw new Error('mailing_list_not_observed')
        if (nameInput) nameInput.value = ''
        if (membersInput) membersInput.value = ''
        setStatus(copy('Mailing list configuration was stored and read back. Delivery to the list is not verified here.'), 'saved')
      })
    }
    const deleteList = async (list: MailingListRecordView): Promise<void> => {
      if (typeof askDialog !== 'function') { setStatus(copy('Deleting a mailing list needs confirmation; nothing was sent.'), 'failed'); return }
      const confirmed = await askDialog({ title: copy('Delete mailing list'), body: list.address, confirm: copy('Delete list'), danger: true })
      if (confirmed !== true) { setStatus(copy('Deletion was cancelled. Nothing was sent.'), 'cancelled'); return }
      await runWrite(async () => {
        const reply = await request('DELETE', '/api/mail/mailing-lists/' + encodeURIComponent(list.id))
        if (!mailingObject(reply) || reply.ok !== true) throw new Error('invalid_mailing_list_ack')
        await load()
        if (lists.some(item => item.id === list.id)) throw new Error('mailing_list_not_removed')
        setStatus(copy('The mailing list was deleted and verified absent.'), 'saved')
      })
    }
    if (!transport || !eligible()) {
      controls().forEach(control => { control.disabled = true })
      setStatus(copy('Mailing list editing is unavailable here. No lists were read or changed.'), 'unavailable')
      return
    }
    createButton?.addEventListener('click', event => { event.preventDefault(); void createList() })
    // Clear only the initial "Reading" text; a faster action's outcome message stays.
    void load().then(() => { if (!status.dataset.state) setStatus('', 'loaded') }, () => setStatus(copy('Stored mailing lists could not be read. Editing stays unavailable.'), 'failed'))
  })
}

export const ACCOUNT_MAILING_LISTS_CLIENT_BINDING = `(function(askDialog){const mailingUnsafe=${mailingUnsafe.toString()};const mailingEmail=${mailingEmail.toString()};const mailingName=${mailingName.toString()};const MODERATION=${JSON.stringify([...MODERATION])};const mailingObject=${mailingObject.toString()};const readMailingList=${readMailingList.toString()};const readMailingLists=${readMailingLists.toString()};const mailingListDraft=${mailingListDraft.toString()};const mailingListMatches=${mailingListMatches.toString()};(${bindMailingLists.toString()})(askDialog);})`
