/// <reference lib="dom" />
import { mailIdentitiesClientBinding } from './mail-identities-client.ts'
import type { MailIdentity } from './mail-identities-client.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
type ComposeIdentity = MailIdentity & { revision: string }
type IdentityRuntime = Pick<typeof import('./mail-identities-client.ts'), 'readMailIdentities' | 'identitiesObject'>
type Transport = (method: string, path: string, body?: unknown) => Promise<unknown>

/** Saved identity selection and a managed plain signature; existing rich body nodes remain intact. */
function bindComposeIdentities(_askDialog: unknown, runtime: IdentityRuntime): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-compose-identities]').forEach(root => {
    if (root.dataset.composeIdentitiesBound === 'true') return
    root.dataset.composeIdentitiesBound = 'true'
    const mailbox = root.dataset.composeMailbox ?? ''
    const select = root.querySelector<HTMLSelectElement>('#compose-from')
    const editor = root.querySelector<HTMLElement>('#compose-body')
    const status = root.querySelector<HTMLElement>('[data-compose-identities-status]')
    const refresh = root.querySelector<HTMLButtonElement>('[data-compose-identities-refresh]')
    const signature = root.querySelector<HTMLButtonElement>('[data-compose-signature-insert]')
    const send = root.querySelector<HTMLButtonElement>('[data-mail-send="true"]')
    if (!select || !editor || !status || !refresh || !signature || !send) return
    const transport = (window as Window & { xpanelSessionRequest?: Transport }).xpanelSessionRequest
    const denied = '[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],fieldset:disabled,[aria-disabled="true"]'
    const eligible = (): boolean => root.isConnected && !root.closest(denied) && /^[^\s<>@]+@[^\s<>@]+$/.test(mailbox)
    let identities: ComposeIdentity[] = [], selected: ComposeIdentity | null = null, busy = false, loaded = false, knownCollection = false, ownershipReview = false
    let managed: HTMLElement | null = null, managedText = '', plainTail = ''
    const plain = (): boolean => editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement
    const setStatus = (state: string, message: string): void => {
      root.dataset.composeIdentitiesState = state
      status.dataset.state = state
      status.textContent = message
      status.setAttribute('role', state === 'failed' || state === 'stale' ? 'alert' : 'status')
      root.dispatchEvent(new CustomEvent('xpanel:compose-identities-state', { bubbles: true }))
    }
    const controls = (): void => {
      const blocked = !eligible() || busy || root.dataset.composeDraftBusy === 'true' || send.dataset.mailSendBusy === 'true' || send.dataset.mailSendReview === 'true'
      let attachmentsReady = true
      if (root.querySelector('[data-compose-attachments]')) {
        const getter = (root as HTMLElement & { xpanelReadComposeAttachments?: () => unknown }).xpanelReadComposeAttachments
        try { attachmentsReady = typeof getter === 'function' && Array.isArray(getter()) } catch { attachmentsReady = false }
      }
      select.disabled = blocked || root.dataset.composeIdentitiesState === 'stale' && selected !== null
      refresh.disabled = blocked
      signature.disabled = blocked || !loaded || !selected?.textSignature || root.dataset.composeIdentitiesState !== 'ready'
      send.disabled = blocked || root.dataset.composeSendEnabled === 'false' || !attachmentsReady || root.dataset.composeIdentitiesState !== 'ready'
    }
    const paintSender = (): void => {
      const name = document.querySelector<HTMLElement>('[data-compose-identity-label]')
      const reply = document.querySelector<HTMLElement>('[data-compose-reply-to]')
      if (name) name.textContent = selected?.displayName ?? t(msgctxt('mail-compose-identities-client', 'Mailbox address'))
      if (reply) { reply.textContent = ''; const isolated = document.createElement('bdi'); isolated.dir = 'ltr'; isolated.textContent = selected?.replyTo ?? mailbox; reply.appendChild(isolated) }
      const address = document.querySelector<HTMLElement>('[data-mail-from-addr]')
      if (address) { address.textContent = ''; const isolated = document.createElement('bdi'); isolated.dir = 'ltr'; isolated.textContent = mailbox; address.appendChild(isolated) }
    }
    const applySignature = (force = false): boolean => {
      const text = selected?.textSignature ? '\n-- \n' + selected.textSignature : ''
      if (plain()) {
        const input = editor as HTMLTextAreaElement | HTMLInputElement
        if (plainTail && !input.value.endsWith(plainTail) && !force) return false
        if (plainTail && input.value.endsWith(plainTail)) input.value = input.value.slice(0, -plainTail.length)
        plainTail = text
        input.value += text
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      }
      if (managed) {
        const unchanged = managed.parentElement === editor && managed.textContent === managedText
        if (!unchanged && !force) return false
        if (unchanged) managed.remove()
      }
      managed = null; managedText = ''
      if (text) {
        managed = document.createElement('div')
        managed.dataset.composeManagedSignature = 'true'
        managed.dir = 'auto'
        managed.style.whiteSpace = 'pre-wrap'
        managed.style.margin = '0'
        managed.textContent = text
        managedText = text
        editor.appendChild(managed)
      }
      editor.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    }
    const choose = (identity: ComposeIdentity | null): void => {
      selected = identity
      select.value = identity?.id ?? ''
      paintSender()
      const applied = applySignature()
      setStatus('ready', !selected
        ? knownCollection ? ownershipReview
          ? t('Authenticated mailbox address selected. Only identities with verified mailbox ownership are available. Older metadata may need review.')
          : t('Authenticated mailbox address selected.')
          : t('Authenticated mailbox address selected. Saved identities were not read.')
        : applied
          ? selected.textSignature ? t('Saved sender selected. Its plain signature is ready to send.')
            : t('Saved sender selected. No plain signature is configured.')
          : t('Saved sender selected. Your edited signature was kept; insert the selected signature if needed.'))
      controls()
    }
    const mailboxFallback = (): void => {
      select.textContent = ''
      const unread = document.createElement('option'); unread.value = 'unread'; unread.disabled = true
      unread.textContent = t('Saved identities unread — read or choose mailbox')
      const fallback = document.createElement('option'); fallback.value = ''; fallback.dataset.addr = mailbox
      fallback.textContent = t('Mailbox address <{address}>', { address: mailbox })
      select.append(unread, fallback); select.value = unread.value
    }
    const read = async (): Promise<void> => {
      if (!transport || busy || !eligible() || root.dataset.composeDraftBusy === 'true' || send.dataset.mailSendBusy === 'true' || send.dataset.mailSendReview === 'true') return
      busy = true; setStatus('reading', t('Reading saved sender identities…')); controls()
      const previous = selected?.id ?? null
      try {
        const value = await transport('GET', '/api/webmail/identities')
        const parsed = runtime.readMailIdentities(value, mailbox)
        const review = runtime.identitiesObject(value) ? value.metadataReview : undefined
        ownershipReview = runtime.identitiesObject(review) && review.status === 'review_required' && review.reason === 'mailbox_metadata_binding_unverified'
        const raw = (value as { identities: Record<string, unknown>[] }).identities
        identities = parsed.map((identity, index) => {
          const revision = raw[index]?.revision
          if (identity.email !== mailbox.toLowerCase() || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identity.id)
            || typeof revision !== 'string' || !/^[0-9a-f]{64}$/.test(revision)
            || /[\r\n\u2028-\u202e\u2066-\u2069]/.test(identity.displayName)) throw new Error('invalid_compose_identity')
          return { ...identity, revision }
        })
        select.textContent = ''
        const fallback = document.createElement('option'); fallback.value = ''; fallback.dataset.addr = mailbox
        fallback.textContent = t('Mailbox address <{address}>', { address: mailbox }); select.appendChild(fallback)
        for (const identity of identities) {
          const option = document.createElement('option'); option.value = identity.id; option.dataset.addr = identity.email
          option.dataset.identityId = identity.id; option.dataset.identityRevision = identity.revision
          option.textContent = identity.displayName + ' <' + identity.email + '>'; select.appendChild(option)
        }
        knownCollection = true
        if (loaded && previous && !identities.some(identity => identity.id === previous)) {
          const missing = document.createElement('option'); missing.value = 'unavailable'; missing.disabled = true
          missing.textContent = t('Saved identity unavailable — choose a sender'); select.prepend(missing); select.value = missing.value
          selected = null
          setStatus('stale', t('The selected identity is no longer available. Your message is kept. Choose a sender before sending.'))
        } else choose(identities.find(identity => identity.id === previous) ?? (!loaded ? identities.find(identity => identity.isDefault) : undefined) ?? null)
        loaded = true
      } catch {
        knownCollection = false; ownershipReview = false; identities = []; mailboxFallback()
        setStatus('failed', t('Saved sender identities could not be read. Your message is kept. Read them again before sending.'))
      } finally { busy = false; controls() }
    }
    if (!transport || !eligible()) {
      setStatus('unavailable', t('Sender identities are unavailable here. Your message is kept.'))
      select.disabled = true; refresh.disabled = true; signature.disabled = true; send.disabled = true
      return
    }
    select.addEventListener('change', () => {
      if (select.disabled || !eligible()) return
      if (select.value === '') { loaded = true; choose(null) }
      else { const identity = identities.find(item => item.id === select.value); if (identity) choose(identity) }
    })
    refresh.addEventListener('click', () => { void read() })
    signature.addEventListener('click', () => {
      if (signature.disabled || !eligible()) return
      applySignature(true); setStatus('ready', t('Selected plain signature inserted. Existing message text was kept.')); controls()
    })
    root.addEventListener('xpanel:compose-identity-stale', () => { setStatus('stale', t('The saved identity changed. Read sender identities and review your draft before sending.')); controls() })
    root.addEventListener('xpanel:mail-send-state', controls)
    root.addEventListener('xpanel:compose-draft-state', controls)
    root.addEventListener('xpanel:compose-attachments-state', controls)
    root.addEventListener('xpanel:mail-send-accepted', event => { if ((event as CustomEvent<{ draftCleared?: boolean }>).detail?.draftCleared === false) return; managed = null; managedText = ''; plainTail = ''; applySignature() })
    mailboxFallback()
    void read()
  })
}

export const MAIL_COMPOSE_IDENTITIES_CLIENT_BINDING = mailIdentitiesClientBinding(bindComposeIdentities, true)
