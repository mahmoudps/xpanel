/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const formatMailDateTime = formatDisplayDateTime


/**
 * Mailbox identities & signatures browser controller.
 * Uses the real `/api/webmail/identities` family. Stored identity configuration only;
 * no delivery, signature rendering or compose-selection claim beyond what the API returns.
 */

const identityUnsafe = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/
const identityEmailPattern = /^[^\s@/\\]+@[^\s@/\\]+$/

export interface MailIdentity { id: string; mailbox: string; displayName: string; email: string; replyTo: string; textSignature: string; htmlSignature: string; isDefault: boolean; createdAt: string }
export interface IdentityDraft { displayName: string; replyTo: string; textSignature: string; htmlSignature: string; isDefault: boolean }

export function identitiesObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
const identityText = (value: unknown, field: string, maximum: number): string => {
  if (typeof value !== 'string' || !value.isWellFormed() || identityUnsafe.test(value) || new TextEncoder().encode(value).length > maximum) throw new Error('invalid_' + field)
  return value
}
const identityEmail = (value: unknown, field: string): string => {
  const email = identityText(value, field, 254).trim().toLowerCase()
  if (!identityEmailPattern.test(email)) throw new Error('invalid_' + field)
  return email
}

export function readMailIdentity(value: unknown, mailbox: string): MailIdentity {
  if (!identitiesObject(value) || typeof value.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.id)) throw new Error('invalid_identity')
  if (typeof value.mailbox !== 'string' || value.mailbox.toLowerCase() !== mailbox.toLowerCase()) throw new Error('invalid_identity')
  if (typeof value.isDefault !== 'boolean') throw new Error('invalid_identity')
  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) throw new Error('invalid_identity')
  return {
    id: value.id,
    mailbox: value.mailbox.toLowerCase(),
    displayName: identityText(value.displayName, 'display_name', 200),
    email: identityEmail(value.email, 'email'),
    replyTo: identityEmail(value.replyTo, 'reply_to'),
    textSignature: identityText(value.textSignature, 'text_signature', 20000),
    htmlSignature: identityText(value.htmlSignature, 'html_signature', 20000),
    isDefault: value.isDefault,
    createdAt: value.createdAt,
  }
}

/** Reads the identity collection and enforces a single default per mailbox. */
export function readMailIdentities(value: unknown, mailbox: string): MailIdentity[] {
  if (!identitiesObject(value) || !Array.isArray(value.identities)) throw new Error('invalid_identities')
  const identities = value.identities.map(raw => readMailIdentity(raw, mailbox))
  if (identities.filter(identity => identity.isDefault).length > 1) throw new Error('invalid_identities')
  if (new Set(identities.map(identity => identity.id)).size !== identities.length) throw new Error('invalid_identities')
  return identities
}

export function identityDraft(values: { displayName: unknown; replyTo: unknown; textSignature: unknown; htmlSignature: unknown; isDefault: unknown }): IdentityDraft {
  const displayName = identityText(values.displayName, 'display_name', 200).trim()
  if (!displayName) throw new Error('invalid_display_name')
  const replyTo = identityEmail(values.replyTo, 'reply_to')
  if (typeof values.isDefault !== 'boolean') throw new Error('invalid_default')
  return {
    displayName,
    replyTo,
    textSignature: identityText(values.textSignature, 'text_signature', 20000),
    htmlSignature: identityText(values.htmlSignature, 'html_signature', 20000),
    isDefault: values.isDefault,
  }
}

export function identityMatchesDraft(identity: MailIdentity, draft: IdentityDraft): boolean {
  return identity.displayName === draft.displayName && identity.replyTo === draft.replyTo
    && identity.textSignature === draft.textSignature && identity.htmlSignature === draft.htmlSignature
    && identity.isDefault === draft.isDefault
}

function bindMailIdentities(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const copy = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-mail-identities]').forEach(root => {
    if (root.dataset.identitiesBound === 'true') return
    root.dataset.identitiesBound = 'true'
    const mailbox = root.dataset.identitiesMailbox ?? ''
    const manageable = root.dataset.identitiesManage === 'true'
    const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const rows = root.querySelector<HTMLElement>('[data-identities-rows]')
    const status = root.querySelector<HTMLElement>('[data-identities-status]')
    const formTitle = root.querySelector<HTMLElement>('[data-identities-form-title]')
    const displayName = root.querySelector<HTMLInputElement>('[data-identities-display-name]')
    const replyTo = root.querySelector<HTMLInputElement>('[data-identities-reply-to]')
    const textSignature = root.querySelector<HTMLTextAreaElement>('[data-identities-text-signature]')
    const htmlSignature = root.querySelector<HTMLTextAreaElement>('[data-identities-html-signature]')
    const isDefault = root.querySelector<HTMLInputElement>('[data-identities-default]')
    const saveButton = root.querySelector<HTMLButtonElement>('[data-identities-save]')
    const resetButton = root.querySelector<HTMLButtonElement>('[data-identities-reset]')
    if (!rows || !status || !displayName || !replyTo || !textSignature || !htmlSignature || !isDefault || !saveButton) return
    const denied = '[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const eligible = (): boolean => root.isConnected && manageable && !root.closest(denied) && identityEmailPattern.test(mailbox)
    let identities: MailIdentity[] = []
    let editingId: string | null = null
    let busy = false, uncertain = false
    const setStatus = (message: string, kind: string): void => {
      status.hidden = !message
      status.dataset.state = kind
      status.setAttribute('role', kind === 'failed' || kind === 'uncertain' ? 'alert' : 'status')
      status.textContent = message
    }
    const controls = (): (HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement)[] => [...root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement>('button,input,textarea')]
    const lock = (): void => {
      const blocked = busy || uncertain || !eligible()
      controls().forEach(control => { control.disabled = blocked })
      if (root.querySelector<HTMLInputElement>('#identities-email')) root.querySelector<HTMLInputElement>('#identities-email')!.readOnly = true
    }
    const request = (method: string, path: string, body?: unknown): Promise<unknown> => {
      if (!transport) return Promise.reject(Object.assign(new Error('transport_unavailable'), { stateChanged: false }))
      return transport(method, path, body)
    }
    const resetForm = (): void => {
      editingId = null
      displayName.value = ''
      replyTo.value = mailbox
      textSignature.value = ''
      htmlSignature.value = ''
      isDefault.checked = identities.length === 0
      if (formTitle) formTitle.textContent = copy('Add identity')
      lock()
    }
    const beginEdit = (identity: MailIdentity): void => {
      if (busy || uncertain || !eligible()) return
      editingId = identity.id
      displayName.value = identity.displayName
      replyTo.value = identity.replyTo
      textSignature.value = identity.textSignature
      htmlSignature.value = identity.htmlSignature
      isDefault.checked = identity.isDefault
      if (formTitle) formTitle.textContent = copy('Edit identity: {name}', { name: identity.displayName })
      displayName.focus()
      lock()
    }
    const paint = (): void => {
      rows.textContent = ''
      if (!identities.length) {
        const empty = document.createElement('p'); empty.className = 'xp-help'
        empty.textContent = copy('No identity with verified mailbox ownership is available. The authenticated mailbox address can still be used. Older metadata may need review.')
        rows.appendChild(empty)
        return
      }
      for (const identity of identities) {
        const card = document.createElement('article'); card.className = 'xp-mail-identities__row'; card.dataset.identityId = identity.id
        const header = document.createElement('header')
        const title = document.createElement('strong'); title.textContent = identity.displayName
        const badge = document.createElement('span'); badge.className = 'xp-help'
        badge.textContent = identity.isDefault ? copy('Default identity') : copy('Stored identity')
        header.append(title, badge); card.appendChild(header)
        const list = document.createElement('dl')
        const entry = (field: string, label: string, value: string) => {
          const pair = document.createElement('div'); pair.className = 'xp-mail-identities__datum'; pair.dataset.identityField = field
          const dt = document.createElement('dt'); dt.textContent = label
          const dd = document.createElement('dd'), bdi = document.createElement('bdi')
          bdi.dir = 'ltr'; bdi.textContent = value; bdi.style.overflowWrap = 'anywhere'; bdi.style.maxInlineSize = '100%'; bdi.style.whiteSpace = 'normal'
          if (field === 'created') bdi.dataset.identityCreatedAt = ''
          dd.appendChild(bdi); pair.append(dt, dd); list.appendChild(pair)
        }
        entry('email', copy(msgctxt('mail-identities-client', 'Email')), identity.email)
        entry('reply-to', copy('Reply-to'), identity.replyTo)
        entry('signature', copy('Plain signature'), identity.textSignature || copy('None'))
        entry('created', copy(msgctxt('mail-identities-client', 'Created')), formatMailDateTime(identity.createdAt))
        card.appendChild(list)
        const actions = document.createElement('div'); actions.className = 'xp-mail-identities__actions'
        const button = (label: string, kind: string, onClick: () => void) => { const node = document.createElement('button'); node.type = 'button'; node.className = 'xp-btn'; node.dataset.identitiesAction = kind; node.textContent = label; node.addEventListener('click', () => { if (!node.disabled && eligible()) onClick() }); actions.appendChild(node); return node }
        button(copy(msgctxt('mail-identities-client', 'Edit')), 'edit', () => beginEdit(identity))
        if (!identity.isDefault) button(copy('Set as default'), 'default', () => { void setDefault(identity) })
        button(copy('Delete'), 'delete', () => { void deleteIdentity(identity) })
        card.appendChild(actions)
        rows.appendChild(card)
      }
      lock()
    }
    const runWrite = async (work: () => Promise<void>): Promise<void> => {
      if (busy || uncertain || !eligible()) return
      busy = true; lock()
      try { await work() } catch (error) {
        const detail = identitiesObject(error) && identitiesObject(error.details) ? error.details : {}
        const certain = identitiesObject(error) && (error.stateChanged === false || detail.stateChanged === false) && detail.unknownOutcome !== true && detail.verificationRequired !== true
        if (!certain) {
          uncertain = true
          setStatus(copy('The outcome is uncertain. Reload the page and inspect stored identities before retrying; no automatic retry was sent.'), 'uncertain')
        } else {
          setStatus(copy('The identity action was refused or its result did not verify. Nothing was retried.'), 'failed')
        }
      } finally { busy = false; lock() }
    }
    const load = async (): Promise<void> => {
      identities = readMailIdentities(await request('GET', '/api/webmail/identities'), mailbox)
      paint()
    }
    const save = async (): Promise<void> => {
      if (!eligible() || busy || uncertain) return
      let draft: IdentityDraft
      try {
        draft = identityDraft({ displayName: displayName.value, replyTo: replyTo.value, textSignature: textSignature.value, htmlSignature: htmlSignature.value, isDefault: isDefault.checked })
      } catch {
        setStatus(copy('Display name, a valid reply-to address, bounded signatures and the default choice are required. Nothing was sent.'), 'failed')
        return
      }
      await runWrite(async () => {
        const targetId = editingId
        const reply = targetId
          ? await request('PATCH', '/api/webmail/identities/' + encodeURIComponent(targetId), draft)
          : await request('POST', '/api/webmail/identities', { email: mailbox, ...draft })
        if (!identitiesObject(reply) || !identitiesObject(reply.identity)) throw new Error('invalid_identity_ack')
        const ack = readMailIdentity(reply.identity, mailbox)
        if (!identityMatchesDraft(ack, draft)) throw new Error('identity_readback_mismatch')
        await load()
        const stored = identities.find(identity => identity.id === ack.id)
        if (!stored || !identityMatchesDraft(stored, draft)) throw new Error('identity_not_observed')
        if (draft.isDefault) {
          const defaults = identities.filter(identity => identity.isDefault)
          if (defaults.length !== 1 || defaults[0]!.id !== ack.id) throw new Error('default_not_exclusive')
        }
        resetForm()
        setStatus(copy('Identity configuration was stored and read back. Sending and delivery are not verified here.'), 'saved')
      })
    }
    const setDefault = async (identity: MailIdentity): Promise<void> => {
      await runWrite(async () => {
        const reply = await request('PATCH', '/api/webmail/identities/' + encodeURIComponent(identity.id), { isDefault: true })
        if (!identitiesObject(reply) || !identitiesObject(reply.identity) || reply.identity.isDefault !== true) throw new Error('invalid_identity_ack')
        await load()
        const defaults = identities.filter(item => item.isDefault)
        if (defaults.length !== 1 || defaults[0]!.id !== identity.id) throw new Error('default_not_exclusive')
        setStatus(copy('Default identity stored and verified as exclusive.'), 'saved')
      })
    }
    const deleteIdentity = async (identity: MailIdentity): Promise<void> => {
      if (typeof askDialog !== 'function') { setStatus(copy('Deleting an identity needs confirmation; nothing was sent.'), 'failed'); return }
      const confirmed = await askDialog({ title: copy('Delete identity'), body: identity.displayName + ' — ' + identity.email, confirm: copy('Delete identity'), danger: true })
      if (confirmed !== true) { setStatus(copy('Deletion was cancelled. Nothing was sent.'), 'cancelled'); return }
      await runWrite(async () => {
        const reply = await request('DELETE', '/api/webmail/identities/' + encodeURIComponent(identity.id))
        if (!identitiesObject(reply) || reply.ok !== true) throw new Error('invalid_identity_ack')
        await load()
        if (identities.some(item => item.id === identity.id)) throw new Error('identity_not_removed')
        if (editingId === identity.id) resetForm()
        setStatus(copy('The identity was deleted and verified absent.'), 'saved')
      })
    }
    if (!transport || !eligible()) {
      controls().forEach(control => { control.disabled = true })
      setStatus(copy('Identity editing is unavailable here. No identities were read or changed.'), 'unavailable')
      return
    }
    saveButton.addEventListener('click', event => { event.preventDefault(); void save() })
    resetButton?.addEventListener('click', event => { event.preventDefault(); if (eligible() && !busy && !uncertain) resetForm() })
    resetForm()
    void load().catch(() => setStatus(copy('Stored identities could not be read. Editing stays unavailable.'), 'failed'))
  })
}

/** Reuses the same mailbox-bound validators in the identity editor and compose selector. */
export const mailIdentitiesClientBinding = (bind: (...args: never[]) => void, withRuntime = false): string => `(function(askDialog){const identityUnsafe=${identityUnsafe.toString()};const identityEmailPattern=${identityEmailPattern.toString()};const identitiesObject=${identitiesObject.toString()};const identityText=${identityText.toString()};const identityEmail=${identityEmail.toString()};const readMailIdentity=${readMailIdentity.toString()};const readMailIdentities=${readMailIdentities.toString()};const identityDraft=${identityDraft.toString()};const identityMatchesDraft=${identityMatchesDraft.toString()};(${bind.toString()})(askDialog${withRuntime ? ',{readMailIdentities,identitiesObject}' : ''});})`

export const MAIL_IDENTITIES_CLIENT_BINDING = `(()=>{const formatMailDateTime=${DISPLAY_DATETIME_BINDING};return ${mailIdentitiesClientBinding(bindMailIdentities)};})()`
