/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const formatMailDateTime = formatDisplayDateTime

export interface MailboxPreferenceFields { density: 'comfortable' | 'compact'; messagesPerPage: 25 | 50 | 100; replyIdentityId: string | null; dateFormat: 'utc' | 'local' }
export interface MailboxPreferencesSnapshot {
  mailbox: string
  revision: string
  preferences: (MailboxPreferenceFields & { updatedAt: string }) | null
  identities: { id: string; displayName: string; email: string }[]
  plusAddressing: { state: 'supported' | 'not-supported' | 'unknown'; delimiter: string | null }
  review: 'mailbox_metadata_binding_unverified' | null
}

export function preferenceFields(value: unknown): MailboxPreferenceFields {
  const record = value as Record<string, unknown> | null
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  if (!record || typeof record !== 'object' || !['comfortable', 'compact'].includes(record.density as string) || ![25, 50, 100].includes(record.messagesPerPage as number)
    || !['utc', 'local'].includes(record.dateFormat as string) || !(record.replyIdentityId === null || (typeof record.replyIdentityId === 'string' && uuid.test(record.replyIdentityId)))) throw new Error('invalid_mailbox_preferences')
  return { density: record.density as MailboxPreferenceFields['density'], messagesPerPage: record.messagesPerPage as MailboxPreferenceFields['messagesPerPage'], replyIdentityId: record.replyIdentityId as string | null, dateFormat: record.dateFormat as MailboxPreferenceFields['dateFormat'] }
}

/** Strict reader: the sealed mailbox's own record without ownership internals, saved-only application. */
export function readMailboxPreferences(value: unknown, mailbox: string): MailboxPreferencesSnapshot {
  const bad = (): never => { throw new Error('invalid_mailbox_preferences') }
  const object = (item: unknown, keys: string[]): Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === keys.length && keys.every(key => key in item) ? item as Record<string, unknown> : bad()
  const record = object(value, Object.keys(value ?? {}).includes('stateChanged') ? ['context', 'preferences', 'revision', 'identities', 'plusAddressing', 'application', 'review', 'stateChanged'] : ['context', 'preferences', 'revision', 'identities', 'plusAddressing', 'application', 'review'])
  const context = object(record.context, ['mailbox']), application = object(record.application, ['status', 'applied']), plus = object(record.plusAddressing, ['state', 'delimiter', 'source'])
  if (context.mailbox !== mailbox || typeof record.revision !== 'string' || !/^[0-9a-f]{64}$/.test(record.revision) || application.status !== 'saved_only' || application.applied !== false
    || !(record.review === null || record.review === 'mailbox_metadata_binding_unverified') || !Array.isArray(record.identities) || record.identities.length > 200
    || plus.source !== 'rendered-postfix-local-delivery' || !['supported', 'not-supported', 'unknown'].includes(plus.state as string)
    || (plus.state === 'supported' ? typeof plus.delimiter !== 'string' || !/^[!-~]{1,8}$/.test(plus.delimiter) : plus.delimiter !== null)) return bad()
  let preferences: MailboxPreferencesSnapshot['preferences'] = null
  if (record.preferences !== null) {
    const raw = object(record.preferences, ['mailbox', 'density', 'messagesPerPage', 'replyIdentityId', 'dateFormat', 'updatedAt'])
    if (record.review !== null || raw.mailbox !== mailbox || typeof raw.updatedAt !== 'string' || !Number.isFinite(Date.parse(raw.updatedAt)) || new Date(raw.updatedAt).toISOString() !== raw.updatedAt) return bad()
    preferences = { ...preferenceFields(raw), updatedAt: raw.updatedAt }
  }
  const identities = record.identities.map(item => {
    const entry = object(item, ['id', 'displayName', 'email'])
    return typeof entry.id === 'string' && /^[0-9a-f-]{36}$/.test(entry.id) && typeof entry.displayName === 'string' && entry.displayName.length <= 256 && typeof entry.email === 'string' && entry.email.length <= 254 && entry.email.includes('@')
      ? { id: entry.id, displayName: entry.displayName, email: entry.email } : bad()
  })
  if (new Set(identities.map(item => item.id)).size !== identities.length) return bad()
  return { mailbox, revision: record.revision, preferences, identities, plusAddressing: { state: plus.state as MailboxPreferencesSnapshot['plusAddressing']['state'], delimiter: plus.delimiter as string | null }, review: record.review as MailboxPreferencesSnapshot['review'] }
}

function bindMailPreferences(askDialog: (options: Record<string, unknown>) => Promise<unknown>): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const denied = '[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
  const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
  const defaults = (): MailboxPreferenceFields => ({ density: 'comfortable', messagesPerPage: 50, replyIdentityId: null, dateFormat: 'utc' })
  const same = (left: MailboxPreferenceFields, right: MailboxPreferenceFields): boolean => left.density === right.density && left.messagesPerPage === right.messagesPerPage && left.replyIdentityId === right.replyIdentityId && left.dateFormat === right.dateFormat
  document.querySelectorAll<HTMLElement>('[data-mail-preferences]').forEach(root => {
    if (root.dataset.preferencesBound === 'true') return
    root.dataset.preferencesBound = 'true'
    const mailbox = root.dataset.preferencesMailbox ?? ''
    const status = root.querySelector<HTMLElement>('[data-preferences-status]'), recordLine = root.querySelector<HTMLElement>('[data-preferences-record]'), plusLine = root.querySelector<HTMLElement>('[data-preferences-plus]')
    const control = (name: string) => root.querySelector<HTMLSelectElement>(`select[name="${name}"]`)
    const density = control('density'), perPage = control('messagesPerPage'), identity = control('replyIdentityId'), dateFormat = control('dateFormat')
    const save = root.querySelector<HTMLButtonElement>('[data-preferences-save]'), discard = root.querySelector<HTMLButtonElement>('[data-preferences-discard]'), refresh = root.querySelector<HTMLButtonElement>('[data-preferences-refresh]')
    if (!status || !recordLine || !plusLine || !density || !perPage || !identity || !dateFormat || !save || !discard || !refresh) return
    const admitted = (): boolean => root.isConnected && root.dataset.preferencesCanManage === 'true' && root.dataset.preferencesMailbox === mailbox && !!mailbox && !root.closest(denied) && !!send
    let snapshot: MailboxPreferencesSnapshot | null = null, draft = defaults(), busy = false, lock = ''
    const baseline = (): MailboxPreferenceFields => snapshot?.preferences ? { density: snapshot.preferences.density, messagesPerPage: snapshot.preferences.messagesPerPage, replyIdentityId: snapshot.preferences.replyIdentityId, dateFormat: snapshot.preferences.dateFormat } : defaults()
    const dirty = (): boolean => !!snapshot && !same(draft, baseline())
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' || state === 'uncertain' ? 'alert' : 'status') }
    const sync = (): void => {
      const editable = admitted() && !!snapshot && !busy && !lock && snapshot.review === null
      for (const item of [density, perPage, identity, dateFormat]) item.disabled = !editable
      save.disabled = !editable || !dirty(); discard.disabled = !editable || !dirty(); refresh.disabled = busy || !admitted()
      root.setAttribute('aria-busy', String(busy))
    }
    const paint = (): void => {
      if (!snapshot) return
      identity.textContent = ''
      const option = (value: string, label: string, disabled = false): void => { const item = document.createElement('option'); item.value = value; item.textContent = label; item.disabled = disabled; identity.append(item) }
      option('', t('This mailbox address ({address})', { address: mailbox }))
      for (const item of snapshot.identities) option(item.id, item.displayName ? item.displayName + ' <' + item.email + '>' : item.email)
      if (draft.replyIdentityId && !snapshot.identities.some(item => item.id === draft.replyIdentityId)) option(draft.replyIdentityId, t('Saved identity is no longer available'), true)
      density.value = draft.density; perPage.value = String(draft.messagesPerPage); identity.value = draft.replyIdentityId ?? ''; dateFormat.value = draft.dateFormat
      recordLine.textContent = ''
      if (snapshot.review) recordLine.textContent = t('Saved preferences belong to an earlier mailbox with this address and need review by your provider. Saving is unavailable.')
      else if (snapshot.preferences) {
        const updatedAt = document.createElement('bdi')
        updatedAt.dir = 'ltr'; updatedAt.className = 'xp-mono'; updatedAt.textContent = formatMailDateTime(snapshot.preferences.updatedAt)
        const [before = '', after = ''] = t('Saved for this mailbox at {time}').split('{time}')
        recordLine.append(before, updatedAt, after)
      } else recordLine.textContent = t('No saved preferences. The defaults are shown and nothing is saved until you choose Save.')
      const plus = snapshot.plusAddressing, local = mailbox.slice(0, mailbox.indexOf('@')), domain = mailbox.slice(mailbox.indexOf('@') + 1)
      plusLine.dataset.state = plus.state; plusLine.textContent = ''
      if (plus.state === 'supported') {
        const example = document.createElement('bdi'); example.dir = 'ltr'; example.textContent = local + plus.delimiter + 'news@' + domain
        const [before = '', after = ''] = t('Supported by the mail server configuration. Mail to an address with a tag, for example {example}, is delivered to this mailbox. This page only explains it; nothing here changes delivery.').split('{example}')
        plusLine.append(before, example, after)
      } else plusLine.textContent = plus.state === 'not-supported'
        ? t('Not supported: the mail server configuration sets no recipient delimiter, so mail to name+tag@domain is not delivered to this mailbox.')
        : t('Unknown: the mail server configuration could not be read for this server.')
    }
    const read = async (): Promise<MailboxPreferencesSnapshot> => readMailboxPreferences(await send!('GET', '/api/webmail/preferences'), mailbox)
    const load = async (): Promise<void> => {
      if (!admitted() || busy) return
      busy = true; sync(); note('reading', t('Reading saved preferences…'))
      try {
        const view = await read()
        if (!admitted()) { snapshot = null; note('unavailable', t('Preferences are unavailable for this mailbox session. Nothing is shown.')); return }
        snapshot = view; draft = baseline(); lock = ''; paint()
        note(view.review ? 'review' : 'read', view.review ? t('Saved preferences need review by your provider.') : t('Saved preferences read.'))
      } catch (error) {
        snapshot = null
        note('failed', (error as { status?: unknown })?.status === 403 ? t('Preferences are not available for this mailbox. Nothing is shown.') : t('Preferences could not be read or verified. Nothing is shown.'))
      } finally { busy = false; sync() }
    }
    const edit = (): void => {
      if (!admitted() || !snapshot || busy || lock) return
      const value = identity.value
      draft = { density: density.value === 'compact' ? 'compact' : 'comfortable', messagesPerPage: perPage.value === '25' ? 25 : perPage.value === '100' ? 100 : 50, replyIdentityId: value ? value : null, dateFormat: dateFormat.value === 'local' ? 'local' : 'utc' }
      sync()
    }
    for (const item of [density, perPage, identity, dateFormat]) item.addEventListener('change', edit)
    save.addEventListener('click', async () => {
      if (!admitted() || !snapshot || busy || lock || !dirty()) return
      const captured = snapshot, desired = { ...draft }
      busy = true; sync(); note('saving', t('Saving preferences and verifying the saved result…'))
      try {
        const ack = await send!('PUT', '/api/webmail/preferences', { ...desired, expectedRevision: captured.revision }) as Record<string, unknown> | null
        if (!ack || ack.stateChanged !== true) throw new Error('invalid_preferences_acknowledgement')
        const accepted = readMailboxPreferences(ack, mailbox), verified = await read()
        if (!accepted.preferences || !same(accepted.preferences, desired) || verified.revision !== accepted.revision || !verified.preferences || !same(verified.preferences, desired)) throw new Error('preferences_readback_mismatch')
        snapshot = verified; draft = baseline(); paint(); note('saved', t('Preferences saved and read back.'))
      } catch (error) {
        const failure = error as { status?: unknown; details?: Record<string, unknown> } | null, details = failure && typeof failure.details === 'object' && failure.details ? failure.details : null
        if (!details || details.stateChanged !== false || details.verificationRequired === true || details.unknownOutcome === true) {
          lock = 'uncertain'; note('uncertain', t('The save outcome requires review. Do not retry; reload the saved preferences to continue.'))
        } else if (failure!.status === 409) {
          lock = 'stale'; note('stale', t('Saved preferences changed since they were read. Reload them before saving again.'))
        } else note('failed', details.reason === 'identity_unavailable' ? t('That identity is no longer saved for this mailbox. Choose another one. Your draft is kept.') : t('The preferences were refused. Your draft is kept.'))
      } finally { busy = false; sync() }
    })
    discard.addEventListener('click', () => { if (!admitted() || !snapshot || busy || lock) return; draft = baseline(); paint(); sync(); note('read', t('Changes discarded.')) })
    refresh.addEventListener('click', async () => {
      if (!admitted() || busy) return
      if ((dirty() || lock) && await askDialog({ title: t('Discard changes?'), body: t('Unsaved preference changes will be discarded and the saved preferences read again. No previous request is retried.'), confirm: t(msgctxt('mail-mailbox-preferences-client', 'Discard and reload')), danger: true }) !== true) return
      await load()
    })
    if (!admitted()) { sync(); note('unavailable', t('Preferences are unavailable for this mailbox session. Nothing was read.')); return }
    void load()
  })
}

export const MAIL_MAILBOX_PREFERENCES_CLIENT_BINDING = `(()=>{const formatMailDateTime=${DISPLAY_DATETIME_BINDING};const preferenceFields=${preferenceFields.toString()};const readMailboxPreferences=${readMailboxPreferences.toString()};return ${bindMailPreferences.toString()};})()`
