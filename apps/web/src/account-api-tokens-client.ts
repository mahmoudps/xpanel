/// <reference lib="dom" />
import './i18n.ts'
import { clientTemplateSlot as canonicalClientTemplateSlot } from './client-templates.ts'
import { ACCOUNT_API_TOKEN_TEMPLATE_BINDING, accountApiTokenNode as canonicalAccountApiTokenNode, assertAccountApiTokenTemplates as canonicalAssertAccountApiTokenTemplates } from './account-api-tokens-templates.ts'
const clientTemplateSlot = canonicalClientTemplateSlot, accountApiTokenNode = canonicalAccountApiTokenNode, assertAccountApiTokenTemplates = canonicalAssertAccountApiTokenTemplates

export interface AccountApiTokenView {
  id: string; name: string; scopes: string[]; allowedIps: string[]; createdAt: string; expiresAt: string
  lastUsedAt: string | null; lastUsedIp: string | null; revokedAt: string | null; state: 'active' | 'expired' | 'revoked'
}

export function readAccountApiTokenView(value: unknown): AccountApiTokenView {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  const time = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v))
  const network = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f.:]{2,45}(?:\/[0-9]{1,3})?$/.test(v)
  if (!object(value) || Object.keys(value).sort().join() !== 'allowedIps,createdAt,expiresAt,id,lastUsedAt,lastUsedIp,name,revokedAt,scopes,state'
    || typeof value.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.id)
    // Metadata can include an existing SDK-issued owner token. Displaying or revoking it never grants its scopes.
    || typeof value.name !== 'string' || value.name.length < 1 || value.name.length > 128 || /[\u0000-\u001f\u007f]/.test(value.name)
    || !Array.isArray(value.scopes) || !value.scopes.length || value.scopes.length > 128 || new Set(value.scopes).size !== value.scopes.length
    || !value.scopes.every((scope): scope is string => typeof scope === 'string' && /^[a-z*][a-z0-9_.:*-]{0,63}$/.test(scope))
    || !Array.isArray(value.allowedIps) || value.allowedIps.length > 16 || !value.allowedIps.every(network)
    || !time(value.createdAt) || !time(value.expiresAt) || (value.lastUsedAt !== null && !time(value.lastUsedAt))
    || (value.lastUsedIp !== null && !network(value.lastUsedIp)) || (value.revokedAt !== null && !time(value.revokedAt))
    || !['active', 'expired', 'revoked'].includes(String(value.state)) || (value.revokedAt !== null) !== (value.state === 'revoked')) throw new Error('invalid_account_api_token')
  if (value.state !== 'active' && value.state !== 'expired' && value.state !== 'revoked') throw new Error('invalid_account_api_token')
  return { id: value.id, name: value.name, scopes: [...value.scopes], allowedIps: [...value.allowedIps], createdAt: value.createdAt, expiresAt: value.expiresAt,
    lastUsedAt: value.lastUsedAt, lastUsedIp: value.lastUsedIp, revokedAt: value.revokedAt, state: value.state }
}

export function readAccountApiTokenList(value: unknown): AccountApiTokenView[] {
  if (!value || typeof value !== 'object' || !('tokens' in value) || !Array.isArray(value.tokens)
    || !('usageRecorded' in value) || value.usageRecorded !== true || Object.keys(value).sort().join() !== 'tokens,usageRecorded') throw new Error('invalid_account_api_token_list')
  const tokens = value.tokens.map(readAccountApiTokenView)
  if (new Set(tokens.map(token => token.id)).size !== tokens.length) throw new Error('invalid_account_api_token_list')
  return tokens
}

export function readAccountApiTokenCreated(value: unknown): { token: AccountApiTokenView; secret: string } {
  if (!value || typeof value !== 'object' || !('token' in value) || !('secret' in value) || typeof value.secret !== 'string'
    || !/^xp_[A-Za-z0-9_-]{43}$/.test(value.secret) || Object.keys(value).sort().join() !== 'secret,token') throw new Error('invalid_account_api_token_created')
  const token = readAccountApiTokenView(value.token)
  if (token.state !== 'active') throw new Error('invalid_account_api_token_created')
  return { token, secret: value.secret }
}

export function bindAccountApiTokens(askDialog?: (options: Record<string, unknown>) => Promise<unknown>): void {
  const t = (message: string): string => xpT(message)
  const BASE = '/api/auth/api-tokens'
  const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  for (const root of document.querySelectorAll<HTMLElement>('[data-account-api-tokens]')) {
    if (root.dataset.accountTokensBound === 'true') continue
    root.dataset.accountTokensBound = 'true'
    const owned = (selector: string): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(selector)].filter(node => node.closest('[data-account-api-tokens]') === root)
    const one = (name: string): HTMLElement => {
      const nodes = owned('[data-account-tokens-' + name + ']')
      if (nodes.length !== 1 || !nodes[0]) throw new Error('account_token_control_unavailable')
      return nodes[0]
    }
    let contractIntact = true, domDirty = true
    const observedFragments = new WeakSet<DocumentFragment>()
    const observeOpts = { subtree: true, childList: true, attributes: true, characterData: true } as const
    const domObserver = new MutationObserver(() => {
      if (!root.isConnected) { domObserver.disconnect(); return }
      domDirty = true
    })
    domObserver.observe(document, observeOpts)
    const syncClean = <T>(fn: () => T): T => {
      const wasDirty = domDirty || domObserver.takeRecords().length > 0
      try { return fn() } finally {
        if (!wasDirty) { domObserver.takeRecords(); domDirty = false }
        else domDirty = true
      }
    }
    const note = (node: HTMLElement, state: string, text: string): void => syncClean(() => { node.hidden = false; node.dataset.state = state; node.textContent = text; node.setAttribute('role', state === 'failed' ? 'alert' : 'status') })
    const disable = (): void => { for (const node of owned('input,select,textarea,button')) if (node instanceof HTMLInputElement || node instanceof HTMLSelectElement || node instanceof HTMLTextAreaElement || node instanceof HTMLButtonElement) node.disabled = true }
    const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const failClosed = (): void => {
      contractIntact = false; domObserver.disconnect(); disable()
      const secret = owned('[data-account-tokens-secret]')[0]; if (secret) secret.textContent = ''
      const reveal = owned('[data-account-tokens-reveal]')[0]; if (reveal) reveal.hidden = true
      const status = owned('[data-account-tokens-status]')[0]; if (status) note(status, 'unavailable', t('API token management is unavailable here. Nothing was read or changed.'))
    }
    try {
      const shape: Readonly<Record<string, readonly string[]>> = { status: ['P'], rows: ['TBODY'], refresh: ['BUTTON'], empty: ['P', 'DIV'], loading: ['P', 'DIV'], create: ['FORM'], name: ['INPUT'], expiry: ['SELECT'],
        'allowed-ips': ['INPUT'], 'read-only': ['INPUT'], submit: ['BUTTON'], clear: ['BUTTON'], 'select-all': ['INPUT'], 'bulk-revoke': ['BUTTON'], reveal: ['DIV'],
        'reveal-text': ['P'], secret: ['CODE'], copy: ['BUTTON'], done: ['BUTTON'], 'copy-status': ['P'], 'mutation-status': ['P'] }
      const controls: Record<string, HTMLElement> = {}
      for (const [name, tags] of Object.entries(shape)) { const node = one(name); if (!tags.includes(node.tagName)) throw new Error('account_token_control_type'); controls[name] = node }
      const status = controls['status']!, rows = controls['rows']!, refresh = controls['refresh']!, empty = controls['empty']!, loading = controls['loading']!, form = controls['create']!, name = controls['name']!, expiry = controls['expiry']!, ips = controls['allowed-ips']!, readOnly = controls['read-only']!
      const submit = controls['submit']!, clear = controls['clear']!, selectAll = controls['select-all']!, bulk = controls['bulk-revoke']!, reveal = controls['reveal']!, revealText = controls['reveal-text']!, secretView = controls['secret']!, copy = controls['copy']!, done = controls['done']!, copyStatus = controls['copy-status']!, mutationStatus = controls['mutation-status']!
      if (!(form instanceof HTMLFormElement) || !(rows instanceof HTMLTableSectionElement) || !(name instanceof HTMLInputElement) || name.type !== 'text'
        || !(expiry instanceof HTMLSelectElement) || !(ips instanceof HTMLInputElement) || ips.type !== 'text'
        || !(readOnly instanceof HTMLInputElement) || readOnly.type !== 'checkbox' || !(selectAll instanceof HTMLInputElement) || selectAll.type !== 'checkbox'
        || ![refresh, submit, clear, bulk, copy, done].every(node => node instanceof HTMLButtonElement)) throw new Error('account_token_controls_unavailable')
      const scopeNodes = owned('[data-account-tokens-scope]')
      const scopeBoxes: HTMLInputElement[] = []
      for (const node of scopeNodes) { if (!(node instanceof HTMLInputElement) || node.type !== 'checkbox' || !/^(?:files|databases|dns|mail|backups|cron):(?:read|write)$/.test(node.value)) throw new Error('account_token_scope_control'); scopeBoxes.push(node) }
      if (scopeBoxes.length !== 12 || new Set(scopeBoxes.map(node => node.value)).size !== 12 || [...expiry.options].map(option => option.value).join() !== '30,90,180,365') throw new Error('account_token_scope_set')
      const originalScopes = scopeBoxes.map(node => node.value)
      let tokens: AccountApiTokenView[] = [], hasSnapshot = false, listBusy = false, writing = false, deniedRoot = false, deniedForm = false
      const selected = new Set<string>()
      const selectionControls = new Map<string, HTMLInputElement>()
      const mutationControls: { node: HTMLButtonElement; id: string; revoke: boolean }[] = []
      const hideSecret = (): void => syncClean(() => { secretView.textContent = ''; revealText.textContent = ''; copyStatus.textContent = ''; copyStatus.hidden = true; reveal.hidden = true })
      hideSecret()
      const current = (): boolean => {
        if (!contractIntact || !root.isConnected || root.dataset.authPersonalState !== 'ready' || root.dataset.tokensCanRead !== 'true' || typeof request !== 'function'
          || (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest !== request) { if (!root.isConnected) domObserver.disconnect(); hideSecret(); return false }
        if (domObserver.takeRecords().length > 0) domDirty = true
        if (!domDirty) {
          if (scopeBoxes.some((node, index) => node.value !== originalScopes[index])) { failClosed(); hideSecret(); return false }
          if (deniedRoot) { hideSecret(); return false }
          return true
        }
        deniedRoot = Boolean(root.closest(denied))
        deniedForm = Boolean(form.closest(denied))
        if (deniedRoot) { hideSecret(); return false }
        try {
          assertAccountApiTokenTemplates(root)
          for (const tpl of root.querySelectorAll('template')) if (!observedFragments.has(tpl.content)) { domObserver.observe(tpl.content, observeOpts); observedFragments.add(tpl.content) }
          for (const [key, original] of Object.entries(controls)) { const tags = shape[key]; if (!tags || one(key) !== original || !tags.includes(original.tagName)) throw new Error('account_token_control_replaced') }
          const now = owned('[data-account-tokens-scope]')
          if (now.length !== scopeBoxes.length || now.some((node, index) => node !== scopeBoxes[index] || !(node instanceof HTMLInputElement) || node.value !== originalScopes[index])) throw new Error('account_token_scope_changed')
          domObserver.takeRecords()
          domDirty = false
          return true
        } catch { failClosed(); hideSecret(); return false }
      }
      const canManage = (): boolean => { const allowed = current() && root.dataset.tokensCanManage === 'true' && !deniedForm; if (!allowed) hideSecret(); return allowed }
      const sync = (): void => {
        const read = current(), allowed = read && root.dataset.tokensCanManage === 'true' && !deniedForm
        if (read && !allowed) hideSecret()
        const manage = allowed && hasSnapshot && !listBusy && !writing
        syncClean(() => {
          for (const node of [refresh, submit, clear, bulk, copy, done]) if (node instanceof HTMLButtonElement) node.disabled = !manage
          if (refresh instanceof HTMLButtonElement) refresh.disabled = !read || listBusy || writing
          for (const node of [name, expiry, ips, readOnly]) node.disabled = !manage
          for (const node of scopeBoxes) node.disabled = !manage || (readOnly.checked && node.value.endsWith(':write'))
          selectAll.disabled = !manage || !tokens.some(token => token.state !== 'revoked')
          const selectable = tokens.filter(token => token.state !== 'revoked').slice(0, 50)
          selectAll.checked = selectable.length > 0 && selectable.every(token => selected.has(token.id))
          selectAll.indeterminate = selected.size > 0 && !selectAll.checked
          for (const [id, node] of selectionControls) node.disabled = !manage || tokens.find(token => token.id === id)?.state === 'revoked'
          for (const control of mutationControls) control.node.disabled = !manage || (control.revoke && tokens.find(token => token.id === control.id)?.state === 'revoked')
          if (bulk instanceof HTMLButtonElement) bulk.disabled = !manage || !selected.size
          if (copy instanceof HTMLButtonElement) copy.disabled = !manage || !secretView.textContent || Boolean(reveal.hidden)
          if (done instanceof HTMLButtonElement) done.disabled = !manage || Boolean(reveal.hidden)
        })
      }
      const ensure = (manage: boolean): void => { if (!(manage ? canManage() : current())) { hideSecret(); throw new Error('account_token_authority_unavailable') } }
      const checkedRequest = async (method: string, path: string, body?: unknown): Promise<unknown> => { ensure(method !== 'GET'); const result = await request?.(method, path, body); ensure(method !== 'GET'); return result }
      const technical = (text: string): HTMLElement => { const node = document.createElement('bdi'); node.dir = 'ltr'; node.textContent = text; return node }
      const paint = (): void => {
        ensure(false); syncClean(() => rows.replaceChildren()); selectionControls.clear(); mutationControls.length = 0
        const rendered = document.createDocumentFragment()
        for (const token of tokens) {
          const row = accountApiTokenNode(root, 'account-token-row', 'tr')
          clientTemplateSlot(row, 'name', 'bdi').textContent = token.name
          const badge = accountApiTokenNode(root, 'account-token-state-' + token.state, 'span')
          badge.dataset.state = token.state
          clientTemplateSlot(badge, 'content', 'span').textContent = token.state === 'active' ? t('Active') : token.state === 'expired' ? t('Expired') : t('Revoked')
          clientTemplateSlot(row, 'state', 'span').replaceChildren(badge)
          clientTemplateSlot(row, 'scopes', 'td').replaceChildren(...token.scopes.flatMap((scope, index) => index ? [document.createElement('br'), technical(scope)] : [technical(scope)]))
          clientTemplateSlot(row, 'addresses', 'td').replaceChildren(...(token.allowedIps.length ? token.allowedIps.flatMap((ip, index) => index ? [document.createElement('br'), technical(ip)] : [technical(ip)]) : [document.createTextNode(t('Any address'))]))
          clientTemplateSlot(row, 'created', 'td').replaceChildren(technical(token.createdAt))
          clientTemplateSlot(row, 'expires', 'td').replaceChildren(technical(token.expiresAt))
          clientTemplateSlot(row, 'used', 'td').replaceChildren(token.lastUsedAt ? technical(token.lastUsedAt) : document.createTextNode(t('Not recorded')))
          const selection = clientTemplateSlot(row, 'select', 'input')
          if (!(selection instanceof HTMLInputElement)) throw new Error('account_token_select_type')
          selection.checked = selected.has(token.id); selection.setAttribute('aria-label', t('Select token') + ': ' + token.name)
          selection.addEventListener('change', () => {
            if (!canManage()) return
            if (selection.checked && selected.size >= 50) { selection.checked = false; note(mutationStatus, 'failed', t('Select at most 50 tokens per operation.')) }
            else if (selection.checked) selected.add(token.id)
            else selected.delete(token.id)
            sync()
          })
          selectionControls.set(token.id, selection)
          const actions = accountApiTokenNode(root, 'account-token-actions', 'div')
          for (const action of ['rename', 'revoke'] as const) {
            const button = accountApiTokenNode(root, 'account-token-' + action, 'button')
            if (!(button instanceof HTMLButtonElement)) throw new Error('account_token_action_type')
            clientTemplateSlot(button, 'content', 'button').textContent = action === 'rename' ? t('Rename') : t('Revoke')
            button.disabled = !canManage() || writing || listBusy || (action === 'revoke' && token.state === 'revoked')
            button.addEventListener('click', () => { void change(action, [token]) })
            mutationControls.push({ node: button, id: token.id, revoke: action === 'revoke' })
            actions.append(button)
          }
          clientTemplateSlot(row, 'actions', 'td').replaceChildren(actions); rendered.append(row)
        }
        if (!tokens.length) { const row = accountApiTokenNode(root, 'account-token-empty', 'tr'); clientTemplateSlot(row, 'content', 'td').textContent = t('No API tokens yet'); rendered.append(row) }
        ensure(false)
        const counts = owned('[data-account-tokens-count]')
        syncClean(() => {
          rows.append(rendered)
          empty.hidden = tokens.length !== 0
          if (counts.length === 1 && counts[0]) counts[0].textContent = String(tokens.length)
        })
        sync()
      }
      const load = async (): Promise<boolean> => {
        if (listBusy || !current()) return false
        hideSecret(); listBusy = true; syncClean(() => { loading.hidden = false; root.setAttribute('aria-busy', 'true') }); sync(); note(status, 'reading', t('Reading your API tokens…'))
        try {
          const fresh = readAccountApiTokenList(await checkedRequest('GET', BASE))
          tokens = fresh; hasSnapshot = true
          for (const id of selected) if (!tokens.some(token => token.id === id && token.state !== 'revoked')) selected.delete(id)
          paint(); note(status, 'read', tokens.length ? t('Tokens read.') : t('Tokens read. You have no API tokens.')); return true
        } catch { note(status, 'failed', writing ? t('The change may be saved. Refresh and verify the token list before trying again.') : t('Your tokens could not be read or verified. Any rows shown are from the last successful read; nothing was changed.')); return false }
        finally { listBusy = false; syncClean(() => { loading.hidden = true; root.setAttribute('aria-busy', 'false') }); sync() }
      }
      const mayHaveChanged = (error: unknown, sent: boolean): boolean => {
        const changed = object(error) && object(error.details) ? error.details.stateChanged : undefined
        const status = object(error) ? error.status : undefined
        const refused = typeof status === 'number' && [400, 401, 403, 404, 409, 405].includes(status)
        return changed === true || (sent && changed !== false && !refused)
      }
      const savedError = (error: unknown, sent: boolean): string => mayHaveChanged(error, sent) ? t('The change may be saved. Refresh and verify the token list before trying again.') : t('The token change could not be completed.')
      const change = async (action: 'rename' | 'revoke', chosen: AccountApiTokenView[]): Promise<void> => {
        if (writing || listBusy || !hasSnapshot || !canManage() || typeof askDialog !== 'function' || !chosen.length) return
        if (chosen.length > 50) { note(mutationStatus, 'failed', t('Select at most 50 tokens per operation.')); return }
        hideSecret(); writing = true; sync()
        let sent = false
        try {
          let rename: string | undefined
          if (action === 'rename') {
            const token = chosen[0]; if (!token) return
            const result = await askDialog({ title: t('Rename token'), input: true, preserveWhitespace: true, label: t('Name'), value: token.name, confirm: t('Rename') })
            ensure(true); if (typeof result !== 'string') return
            if (!/^[A-Za-z0-9_-]{1,50}$/.test(result)) throw new Error('invalid_account_token_name')
            rename = result
          } else {
            const confirmed = await askDialog({ title: t('Revoke selected tokens?'), danger: true, confirm: t('Revoke'), cancel: t('Cancel'), body: t('Scripts using these tokens stop working at once. This cannot be undone.') }) === true
            ensure(true); if (!confirmed) return
          }
          const ids = chosen.map(token => token.id)
          ensure(true); sent = true
          const raw = await checkedRequest(action === 'rename' ? 'PATCH' : 'POST', action === 'rename' ? BASE + '/' + ids[0] : ids.length === 1 ? BASE + '/' + ids[0] + '/revoke' : BASE + '/revoke',
            action === 'rename' ? { name: rename } : ids.length > 1 ? { ids } : undefined)
          if (!object(raw) || Object.keys(raw).join() !== (ids.length > 1 ? 'tokens' : 'token')) throw new Error('invalid_account_token_ack')
          const acknowledgements = ids.length > 1 ? (Array.isArray(raw.tokens) ? raw.tokens.map(readAccountApiTokenView) : []) : [readAccountApiTokenView(raw.token)]
          if (acknowledgements.length !== ids.length || acknowledgements.some(token => !ids.includes(token.id) || (action === 'rename' ? token.name !== rename : token.state !== 'revoked'))
            || new Set(acknowledgements.map(token => token.id)).size !== ids.length) throw new Error('invalid_account_token_ack')
          if (!await load()) throw new Error('account_token_readback_failed')
          ensure(true)
          if (ids.some(id => !tokens.some(token => token.id === id && (action === 'rename' ? token.name === rename : token.state === 'revoked')))) throw new Error('account_token_readback_failed')
          selected.clear(); note(mutationStatus, 'read', action === 'rename' ? t('Token renamed.') : t('Tokens revoked.')); paint()
        } catch (error) { hideSecret(); if (mayHaveChanged(error, sent)) hasSnapshot = false; note(mutationStatus, 'failed', savedError(error, sent)) }
        finally { writing = false; sync(); if (hasSnapshot && current()) paint() }
      }
      refresh.addEventListener('click', () => { if (!writing) void load() })
      clear.addEventListener('click', () => { if (!canManage() || writing || listBusy) return; form.reset(); hideSecret(); mutationStatus.hidden = true; sync() })
      done.addEventListener('click', hideSecret)
      copy.addEventListener('click', () => {
        if (!canManage() || reveal.hidden || !secretView.textContent) return
        const secret = secretView.textContent
        if (!navigator.clipboard?.writeText) { note(copyStatus, 'failed', t('Copying is not available in this browser. Select the token and copy it.')); return }
        navigator.clipboard.writeText(secret).then(() => { if (canManage() && !reveal.hidden) note(copyStatus, 'read', t('Copied.')) }, () => { if (canManage() && !reveal.hidden) note(copyStatus, 'failed', t('The token could not be copied.')) })
      })
      readOnly.addEventListener('change', () => { if (readOnly.checked) for (const box of scopeBoxes) if (box.value.endsWith(':write')) box.checked = false; sync() })
      selectAll.addEventListener('change', () => {
        if (!canManage()) return
        selected.clear()
        if (selectAll.checked) {
          const eligible = tokens.filter(token => token.state !== 'revoked')
          for (const token of eligible.slice(0, 50)) selected.add(token.id)
          if (eligible.length > 50) note(mutationStatus, 'read', t('The first 50 tokens are selected.'))
        }
        paint()
      })
      bulk.addEventListener('click', () => { void change('revoke', tokens.filter(token => selected.has(token.id))) })
      form.addEventListener('submit', async event => {
        event.preventDefault()
        if (writing || listBusy || !hasSnapshot || !canManage()) return
        const tokenName = name.value.trim(), days = Number(expiry.value), scopes = scopeBoxes.filter(box => box.checked).map(box => box.value), allowedIps = ips.value.split(/[\s,]+/).filter(Boolean)
        hideSecret()
        if (!/^[A-Za-z0-9_-]{1,50}$/.test(tokenName) || !scopes.length || (readOnly.checked && scopes.some(scope => scope.endsWith(':write')))
          || ![30, 90, 180, 365].includes(days) || allowedIps.length > 16 || !allowedIps.every(ip => /^[0-9a-fA-F.:]{2,45}(?:\/[0-9]{1,3})?$/.test(ip))) { note(mutationStatus, 'failed', t('Check the token name, scopes, expiry and allowed addresses.')); return }
        writing = true; sync(); note(mutationStatus, 'reading', t('Creating the token…'))
        let sent = false
        try {
          ensure(true); sent = true
          const created = readAccountApiTokenCreated(await checkedRequest('POST', BASE, { name: tokenName, scopes, expiresInDays: days, allowedIps, readOnly: readOnly.checked }))
          if (created.token.name !== tokenName || JSON.stringify([...created.token.scopes].sort()) !== JSON.stringify([...scopes].sort())) throw new Error('invalid_account_token_ack')
          if (!await load()) throw new Error('account_token_readback_failed')
          ensure(true)
          const observed = tokens.find(token => token.id === created.token.id)
          if (!observed || JSON.stringify(observed) !== JSON.stringify(created.token)) throw new Error('account_token_readback_failed')
          secretView.textContent = created.secret; revealText.textContent = t('Copy this token now. It is shown once and cannot be recovered from the token list.'); reveal.hidden = false
          form.reset(); note(mutationStatus, 'read', t('Token created.'))
        } catch (error) { hideSecret(); if (mayHaveChanged(error, sent)) hasSnapshot = false; note(mutationStatus, 'failed', savedError(error, sent)) }
        finally { writing = false; sync() }
      })
      window.addEventListener('pagehide', hideSecret)
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') hideSecret() })
      if (!current()) { failClosed(); continue }
      sync(); void load()
    } catch { failClosed() }
  }
}

export const ACCOUNT_API_TOKENS_CLIENT_BINDING = `(()=>{${ACCOUNT_API_TOKEN_TEMPLATE_BINDING}const readAccountApiTokenView=${readAccountApiTokenView.toString()};const readAccountApiTokenList=${readAccountApiTokenList.toString()};const readAccountApiTokenCreated=${readAccountApiTokenCreated.toString()};return ${bindAccountApiTokens.toString()};})()`
