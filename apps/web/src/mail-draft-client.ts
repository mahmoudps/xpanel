import type { MessageValues } from './i18n.ts'
/// <reference lib="dom" />
import { MAIL_COMPOSE_PAYLOAD_RUNTIME } from './mail-send-client.ts'
import type { MailSendPayload } from './mail-send-client.ts'

type DraftReference = { uid: number; uidValidity: number; revision: string }
type DraftRuntime = { readMailSendPayload: (root?: Document, metadata?: Pick<MailSendPayload, 'expectedDraft'>) => MailSendPayload }

function bindMailDraft(runtime: DraftRuntime): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const uid = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 4294967295
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  document.querySelectorAll<HTMLElement>('[data-compose-identities]').forEach(root => {
    if (root.dataset.composeDraftBound === 'true') return
    root.dataset.composeDraftBound = 'true'
    const button = root.querySelector<HTMLButtonElement>('[data-mail-action="save-draft"]')
    const status = root.querySelector<HTMLElement>('[data-mail-draft-status]')
    const send = root.querySelector<HTMLButtonElement>('[data-mail-send="true"]')
    if (!button || !status || !send) return
    const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const mailbox = root.dataset.composeMailbox ?? ''
    const denied = '[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],fieldset:disabled,[aria-disabled="true"]'
    const eligible = (): boolean => root.isConnected && root.dataset.composeDraftEnabled === 'true' && !root.closest(denied)
    let busy = false, review = false, last: DraftReference | null = null, savedSnapshot: string | null = null
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', ['failed', 'stale', 'uncertain', 'partial'].includes(state) ? 'alert' : 'status') }
    const current = (): MailSendPayload | null => { try { return runtime.readMailSendPayload(document, last ? { expectedDraft: last } : undefined) } catch { return null } }
    const contentSnapshot = (payload: MailSendPayload | null): string | null => { if (!payload) return null; const content = { ...payload }; delete content.expectedDraft; return JSON.stringify(content) }
    const meaningful = (value: MailSendPayload): boolean => !!(value.to.trim() || value.cc.trim() || value.bcc.trim() || value.subject.trim() || value.text.trim() || (value as MailSendPayload & { attachments?: unknown[] }).attachments?.length)
    const controls = (): void => {
      const payload = current()
      button.disabled = !eligible() || busy || review || send.dataset.mailSendBusy === 'true' || !payload || !meaningful(payload) || contentSnapshot(payload) === savedSnapshot
    }
    const signal = (): void => {
      root.dataset.composeDraftBusy = String(busy)
      send.disabled = busy || root.dataset.composeSendEnabled === 'false' || send.dataset.mailSendBusy === 'true' || send.dataset.mailSendReview === 'true' || root.dataset.composeIdentitiesState !== 'ready'
      root.dispatchEvent(new CustomEvent('xpanel:compose-draft-state', { bubbles: true }))
    }
    const save = async (): Promise<void> => {
      if (!transport || !eligible() || busy || review || send.dataset.mailSendBusy === 'true') return
      const payload = current()
      if (!payload || !meaningful(payload)) { controls(); return }
      const snapshot = contentSnapshot(payload)
      if (snapshot === savedSnapshot) return
      const previous = last ? { ...last } : null
      busy = true; signal(); controls(); note('saving', t('Saving the draft in your mailbox…'))
      try {
        const reply = await transport('POST', '/api/webmail/drafts', payload)
        if (!object(reply) || typeof reply.mailbox !== 'string' || reply.mailbox.toLowerCase() !== mailbox.toLowerCase() || reply.folder !== 'Drafts' || !object(reply.draft)
          || !uid(reply.draft.uid) || !uid(reply.draft.uidValidity) || typeof reply.draft.revision !== 'string' || !/^[0-9a-f]{64}$/.test(reply.draft.revision)
          || typeof reply.draft.messageId !== 'string' || !/^<[^<>\s@]+@[^<>\s@]+>$/.test(reply.draft.messageId)
          || payload.identityId && (reply.identityId !== payload.identityId || reply.identityRevision !== payload.expectedIdentityRevision)
          || !['saved', 'partial'].includes(String(reply.status)) || typeof reply.reviewRequired !== 'boolean'
          || reply.status === 'saved' && (reply.reviewRequired !== false || reply.previousDraft !== (previous ? 'retired' : 'none'))
          || reply.status === 'partial' && (!previous || reply.reviewRequired !== true || reply.previousDraft !== 'review_required')
          || previous && reply.draft.uidValidity === previous.uidValidity && reply.draft.uid <= previous.uid) throw new Error('invalid_draft_ack')
        last = { uid: reply.draft.uid, uidValidity: reply.draft.uidValidity, revision: reply.draft.revision }
        savedSnapshot = snapshot
        review = reply.reviewRequired
        note(review ? 'partial' : 'saved', review
          ? t('A new draft was saved. The previous copy needs review. Inspect Drafts before saving again; nothing was retried.')
          : contentSnapshot(current()) === snapshot
            ? t('Draft saved and read back from your mailbox. Your editor was kept.')
            : t('That draft version was saved. Your newer edits are still in the editor.'))
      } catch (error) {
        const value = object(error) ? error : {}, details = object(value.details) ? value.details : {}
        if (details.identitySelectionRequired === true && details.stateChanged === false) root.dispatchEvent(new CustomEvent('xpanel:compose-identity-stale'))
        const uncertain = [value, details].some(part => part.unknownOutcome === true || part.verificationRequired === true || part.stateChanged === true)
        const refused = !uncertain && (details.stateChanged === false || typeof value.status === 'number' && value.status >= 400 && value.status < 500 && value.status !== 408)
        review = details.draftConflict === true || details.draftVerificationRequired === true || !refused
        note(review ? details.draftConflict === true ? 'stale' : 'uncertain' : 'failed', review
          ? t('The draft outcome needs review. Your edits are kept. Inspect Drafts before retrying; no retry was sent.')
          : t('The draft request was refused. Your edits are kept and nothing was retried.'))
      } finally { busy = false; signal(); controls() }
    }
    if (!transport || !eligible()) { button.disabled = true; note('unavailable', t('Mailbox draft saving is unavailable here. Your editor is kept.')); return }
    button.addEventListener('click', event => { event.preventDefault(); void save() })
    root.addEventListener('input', controls); root.addEventListener('change', controls)
    for (const name of ['xpanel:compose-identities-state', 'xpanel:mail-send-state', 'xpanel:compose-attachments-state']) root.addEventListener(name, controls)
    root.addEventListener('xpanel:mail-send-accepted', event => { if ((event as CustomEvent<{ draftCleared?: boolean }>).detail?.draftCleared === false) return; last = null; savedSnapshot = null; controls() })
    controls()
  })
}

export const MAIL_DRAFT_CLIENT_BINDING = `(function(){${MAIL_COMPOSE_PAYLOAD_RUNTIME}(${bindMailDraft.toString()})({readMailSendPayload});})`
