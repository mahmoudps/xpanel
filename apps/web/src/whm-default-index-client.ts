import type { MessageValues } from './i18n.ts'
import './i18n.ts'
interface IndexView { name: string; engine: string; indexFiles: string[]; revision: string; preview: boolean; save: boolean; reset: boolean; application: string }
const indexObject = (raw: unknown): raw is Record<string, unknown> => !!raw && typeof raw === 'object' && !Array.isArray(raw)
export function parseIndexDraft(raw: unknown): string[] | null {
  if (typeof raw !== 'string' || raw.length > 1055) return null
  const names = raw.split(',').map(name => name.trim())
  return names.length >= 1 && names.length <= 16 && new Set(names).size === names.length && names.every(name => name.length <= 64 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes('..') && name.toLowerCase() !== 'disabled') ? names : null
}
export function readDefaultIndex(raw: unknown, expectedName: string): IndexView | null {
  if (!indexObject(raw) || !indexObject(raw.configuration) || !indexObject(raw.actions) || !indexObject(raw.application)) return null
  const view = raw.configuration, actions = raw.actions
  if (view.state !== 'read' || view.source !== 'saved-domain-configuration' || !indexObject(view.domain) || view.domain.name !== expectedName || !['apache', 'openlitespeed'].includes(String(view.engine))
    || !Array.isArray(view.indexFiles) || view.indexFiles.some(name => typeof name !== 'string') || typeof view.explicit !== 'boolean' || typeof view.revision !== 'string' || !/^[0-9a-f]{64}$/.test(view.revision)
    || ['preview', 'save', 'reset'].some(key => typeof actions[key] !== 'boolean') || raw.application.targetVerified !== false || !['unverified', 'not_requested', 'global_configuration_applied'].includes(String(raw.application.status))) return null
  const names = parseIndexDraft(view.indexFiles.join(','))
  if (!names || JSON.stringify(names) !== JSON.stringify(view.indexFiles)) return null
  return { name: expectedName, engine: String(view.engine), indexFiles: names, revision: view.revision, preview: actions.preview as boolean, save: actions.save as boolean, reset: actions.reset as boolean, application: String(raw.application.status) }
}
function bindWhmDefaultIndex(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues) => xpT(message, values)
  const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
  document.querySelectorAll<HTMLElement>('[data-default-index-workspace]').forEach(root => {
    if (root.dataset.defaultIndexBound === 'true') return
    root.dataset.defaultIndexBound = 'true'
    const domain = root.querySelector<HTMLSelectElement>('[data-default-index-domain]')!, input = root.querySelector<HTMLInputElement>('[data-default-index-files]')!
    const refresh = root.querySelector<HTMLButtonElement>('[data-default-index-refresh]')!, preview = root.querySelector<HTMLButtonElement>('[data-default-index-preview]')!, save = root.querySelector<HTMLButtonElement>('[data-default-index-save]')!, reset = root.querySelector<HTMLButtonElement>('[data-default-index-reset]')!
    const status = root.querySelector<HTMLElement>('[data-default-index-status]')!, output = root.querySelector<HTMLElement>('[data-default-index-output]')!
    // Human status text in the directive slot leaves the technical mono font.
    const show = (text: string, human: boolean): void => { output.textContent = text; output.toggleAttribute('data-human', human) }
    if (![domain, input, refresh, preview, save, reset, status, output].every(Boolean)) return
    const admitted = () => root.isConnected && root.dataset.defaultIndexEnabled === 'true' && !!request && !root.closest('[data-capability-state="unavailable"],[data-capability-state="soon"],[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[aria-disabled="true"],fieldset:disabled')
    let view: IndexView | null = null, busy = false, locked = false
    const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
    const dirty = () => !!view && !equal(parseIndexDraft(input.value), view.indexFiles)
    const message = (state: string, text: string) => { status.dataset.state = state; status.textContent = text }
    const controls = () => {
      const disabled = !admitted() || busy
      domain.disabled = disabled || !domain.options.length || !domain.options[0]?.value
      refresh.disabled = disabled
      input.disabled = disabled || locked || !view?.save
      preview.disabled = disabled || locked || !view?.preview || !parseIndexDraft(input.value)
      save.disabled = disabled || locked || !view?.save || !dirty() || !parseIndexDraft(input.value) || !askDialog
      reset.disabled = disabled || locked || !view?.reset || !askDialog
    }
    const endpoint = (name: string) => '/api/server/default-index/' + encodeURIComponent(name)
    const load = async (name?: string) => {
      if (!admitted() || busy) return
      busy = true; controls(); message('loading', t('Reading saved index configuration…'))
      try {
        if (!name) {
          const raw = await request!('GET', '/api/server/default-index')
          if (!indexObject(raw) || raw.source !== 'saved-domain-configuration' || !Array.isArray(raw.domains) || raw.domains.length > 10000 || raw.domains.some(item => !indexObject(item) || typeof item.name !== 'string' || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(item.name) || item.name.length > 253) || new Set(raw.domains.map(item => (item as Record<string, unknown>).name)).size !== raw.domains.length) throw new Error('invalid_index_domains')
          if (!admitted()) return
          domain.replaceChildren()
          for (const item of raw.domains as { name: string }[]) { const option = document.createElement('option'); option.value = item.name; option.textContent = item.name; domain.append(option) }
          if (!domain.options.length) { view = null; message('empty', t('No saved domains are available.')); return }
          name = domain.value
        }
        const next = readDefaultIndex(await request!('GET', endpoint(name)), name)
        if (!next) throw new Error('invalid_index_readback')
        if (!admitted()) return
        view = next; locked = false; domain.value = next.name; input.value = next.indexFiles.join(','); show(t('No preview has been requested.'), true)
        message(next.save ? 'read' : 'unavailable', next.save ? t('Saved index configuration read. External serving remains unverified.') : t('Configuration read. Changes are unavailable for this domain or the host has not qualified them.'))
      } catch { locked = true; message('failed', t('Saved configuration could not be read. The current draft is retained; explicitly reload.')) }
      finally { busy = false; controls() }
    }
    input.addEventListener('input', () => { show(t('Preview needs refreshing.'), true); controls() })
    refresh.addEventListener('click', async () => {
      if (!admitted() || busy) return
      if (dirty() && (!askDialog || await askDialog({ title: t('Reload saved configuration?'), body: t('This replaces the current draft.'), confirm: t(msgctxt('whm-default-index-client', 'Reload')) }) !== true)) return
      await load(domain.value || undefined)
    })
    domain.addEventListener('change', async () => {
      const selected = domain.value, before = view
      if (!admitted() || busy) { if (before) domain.value = before.name; return }
      if (dirty() && (!askDialog || await askDialog({ title: t('Change selected domain?'), body: t('This replaces the current draft.'), confirm: t('Change domain') }) !== true)) { if (before) domain.value = before.name; return }
      await load(selected)
    })
    preview.addEventListener('click', async () => {
      if (!admitted() || busy || locked || !view?.preview) return
      const before = view, draft = parseIndexDraft(input.value)
      if (!draft) return
      busy = true; controls()
      try {
        const raw = await request!('POST', endpoint(before.name) + '/preview', { expectedRevision: before.revision, indexFiles: draft.join(',') })
        if (!indexObject(raw) || !indexObject(raw.preview) || raw.preview.revision !== before.revision || raw.preview.engine !== before.engine || raw.preview.syntaxChecked !== false || !equal(raw.preview.indexFiles, draft) || !Array.isArray(raw.preview.lines) || raw.preview.lines.length !== 2 || raw.preview.lines.some(line => typeof line !== 'string' || line.length > 1200 || /[\r\n\u0000]/.test(line))) throw new Error('invalid_index_preview')
        if (!admitted() || view !== before || !equal(parseIndexDraft(input.value), draft)) return
        show((raw.preview.lines as string[]).join('\n'), false); message('previewed', t('Directive preview ready. Native syntax and external serving have not been checked.'))
      } catch { locked = true; message('stale', t('Preview could not be verified. Keep the draft and explicitly reload before continuing.')) }
      finally { busy = false; controls() }
    })
    const mutate = async (resetting: boolean) => {
      if (!admitted() || busy || locked || !view || !askDialog || !(resetting ? view.reset : view.save)) return
      const before = view, draft = resetting ? ['index.php', 'index.html', 'index.htm'] : parseIndexDraft(input.value)
      if (!draft || !resetting && !dirty()) return
      const confirmed = await askDialog({ title: resetting ? t('Reset index order?') : t('Save index order?'), body: before.name + '\n' + draft.join(', '), confirm: resetting ? t('Reset') : t('Save') })
      if (confirmed !== true || !admitted() || busy || locked || view !== before || !resetting && !equal(parseIndexDraft(input.value), draft) || domain.value !== before.name) return
      busy = true; controls(); message('saving', t('Saving index configuration…'))
      try {
        const raw = await request!(resetting ? 'POST' : 'PUT', endpoint(before.name) + (resetting ? '/reset' : ''), { expectedRevision: before.revision, confirmation: before.name, ...(!resetting ? { indexFiles: draft.join(',') } : {}) })
        const ack = readDefaultIndex(raw, before.name)
        if (!indexObject(raw) || raw.stateChanged !== true || !ack || !equal(ack.indexFiles, draft) || !['not_requested', 'global_configuration_applied'].includes(ack.application)) throw new Error('invalid_index_ack')
        const readback = readDefaultIndex(await request!('GET', endpoint(before.name)), before.name)
        if (!readback || readback.revision !== ack.revision || !equal(readback.indexFiles, draft)) throw new Error('index_readback_mismatch')
        if (!admitted()) return
        view = readback; input.value = draft.join(','); locked = false
        message('saved', ack.application === 'global_configuration_applied' ? t('Index order saved and host configuration applied. External serving remains unverified.') : t('Index order saved. Native application was not requested; external serving remains unverified.'))
      } catch (error) {
        locked = true
        const details = indexObject(error) && indexObject(error.details) ? error.details : indexObject(error) && indexObject(error.detail) ? error.detail : {}
        const stale = details.stateChanged === false && details.unknownOutcome !== true && details.verificationRequired !== true
        message(stale ? 'stale' : 'uncertain', stale ? t('The change was refused. Keep the draft and explicitly reload before retrying.') : t('The write outcome is uncertain. Keep the draft and explicitly read saved configuration before retrying.'))
      } finally { busy = false; controls() }
    }
    save.addEventListener('click', () => { void mutate(false) }); reset.addEventListener('click', () => { void mutate(true) })
    window.addEventListener('beforeunload', event => { if (admitted() && (dirty() || busy)) { event.preventDefault(); event.returnValue = '' } })
    controls(); if (admitted()) void load()
  })
}
export const WHM_DEFAULT_INDEX_CLIENT_BINDING = `function(askDialog){const indexObject=${indexObject.toString()};const parseIndexDraft=${parseIndexDraft.toString()};const readDefaultIndex=${readDefaultIndex.toString()};(${bindWhmDefaultIndex.toString()})(askDialog);}`
