/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const formatDisplayDateTime = sharedFormatDisplayDateTime
export type PanelTokenStateView = 'active' | 'expired' | 'revoked'
export type PanelTokenView = {
  id: string; name: string; scopes: string[]; allowedIps: string[]; createdAt: string; expiresAt: string
  lastUsedAt: string | null; lastUsedIp: string | null; revokedAt: string | null; state: PanelTokenStateView
}

export function readPanelTokenView(value: unknown): PanelTokenView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const time = (item: unknown): item is string => typeof item === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item) && Number.isFinite(Date.parse(item))
  const network = (item: unknown): item is string => typeof item === 'string' && /^[0-9a-f.:]{2,45}(?:\/[0-9]{1,3})?$/.test(item)
  if (!object(value) || Object.keys(value).sort().join() !== 'allowedIps,createdAt,expiresAt,id,lastUsedAt,lastUsedIp,name,revokedAt,scopes,state'
    || typeof value.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.id)
    || typeof value.name !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value.name)
    || !Array.isArray(value.scopes) || value.scopes.length < 1 || value.scopes.length > 128 || new Set(value.scopes).size !== value.scopes.length
    || !value.scopes.every(scope => typeof scope === 'string' && /^(?:\*|[a-z][a-z-]{0,31}:(?:read|write))$/.test(scope))
    || !Array.isArray(value.allowedIps) || value.allowedIps.length > 16 || !value.allowedIps.every(network)
    || !time(value.createdAt) || !time(value.expiresAt) || value.lastUsedAt !== null && !time(value.lastUsedAt) || value.lastUsedIp !== null && !network(value.lastUsedIp)
    || value.revokedAt !== null && !time(value.revokedAt) || !['active', 'expired', 'revoked'].includes(value.state as string) || (value.revokedAt !== null) !== (value.state === 'revoked')) throw new Error('invalid_api_token')
  return {
    id: value.id, name: value.name, scopes: [...value.scopes as string[]], allowedIps: [...value.allowedIps as string[]], createdAt: value.createdAt, expiresAt: value.expiresAt,
    lastUsedAt: value.lastUsedAt as string | null, lastUsedIp: value.lastUsedIp as string | null, revokedAt: value.revokedAt as string | null, state: value.state as PanelTokenStateView,
  }
}

export function readPanelTokenListView(value: unknown): { tokens: PanelTokenView[]; usageRecorded: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_api_token_list')
  const body = value as Record<string, unknown>
  if (!Array.isArray(body.tokens) || body.tokens.length > 200 || typeof body.usageRecorded !== 'boolean') throw new Error('invalid_api_token_list')
  const tokens = body.tokens.map(readPanelTokenView)
  if (new Set(tokens.map(token => token.id)).size !== tokens.length) throw new Error('invalid_api_token_list')
  return { tokens, usageRecorded: body.usageRecorded }
}

export function readPanelTokenCreatedView(value: unknown): { token: PanelTokenView; secret: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_api_token_created')
  const body = value as Record<string, unknown>
  if (typeof body.secret !== 'string' || !/^xp_[A-Za-z0-9_-]{43}$/.test(body.secret)) throw new Error('invalid_api_token_created')
  const token = readPanelTokenView(body.token)
  if (token.state !== 'active') throw new Error('invalid_api_token_created')
  return { token, secret: body.secret }
}

function bindWhmPanelTokens(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-whm-panel-tokens-workspace]').forEach(root => {
    if (root.dataset.tokensBound === 'true') return
    root.dataset.tokensBound = 'true'
    const one = <T extends Element>(selector: string): T | null => root.querySelector<T>(selector)
    const status = one<HTMLElement>('[data-whm-tokens-status]'), rows = one<HTMLElement>('[data-whm-tokens-rows]'), loading = one<HTMLElement>('[data-whm-tokens-loading]'), empty = one<HTMLElement>('[data-whm-tokens-empty]')
    const refresh = one<HTMLButtonElement>('[data-whm-tokens-refresh]'), revokeStatus = one<HTMLElement>('[data-whm-tokens-revoke-status]')
    const reveal = one<HTMLElement>('[data-whm-tokens-reveal]'), revealText = one<HTMLElement>('[data-whm-tokens-reveal-text]'), secretView = one<HTMLElement>('[data-whm-tokens-secret]')
    const copy = one<HTMLButtonElement>('[data-whm-tokens-copy]'), done = one<HTMLButtonElement>('[data-whm-tokens-done]'), copyStatus = one<HTMLElement>('[data-whm-tokens-copy-status]')
    const form = one<HTMLFormElement>('[data-whm-tokens-create]'), name = one<HTMLInputElement>('[data-whm-tokens-name]'), expiry = one<HTMLSelectElement>('[data-whm-tokens-expiry]'), ips = one<HTMLInputElement>('[data-whm-tokens-ips]')
    const all = one<HTMLInputElement>('[data-whm-tokens-all]'), submit = one<HTMLButtonElement>('[data-whm-tokens-create-submit]'), clear = one<HTMLButtonElement>('[data-whm-tokens-clear]'), createStatus = one<HTMLElement>('[data-whm-tokens-create-status]')
    const scopeBoxes = Array.from(root.querySelectorAll<HTMLInputElement>('[data-whm-tokens-scope]'))
    const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    if (!status || !rows || !refresh || !revokeStatus || !reveal || !revealText || !secretView || !copy || !done || !copyStatus || !form || !name || !expiry || !ips || !all || !submit || !clear || !createStatus || !scopeBoxes.length) return
    const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => root.isConnected && root.dataset.tokensCanManage === 'true' && !root.closest(denied) && form.tagName === 'FORM' && typeof request === 'function'
    const controls = [refresh, name, expiry, ips, all, submit, clear, ...scopeBoxes]
    let tokens: PanelTokenView[] = [], usageRecorded = false, listBusy = false, creating = false, revoking = ''
    const note = (target: HTMLElement, state: string, message: string): void => { target.hidden = false; target.dataset.state = state; target.textContent = message; target.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const ltr = (value: string): HTMLElement => { const node = document.createElement('bdi'); node.dir = 'ltr'; node.textContent = value; return node }
    const cell = (row: HTMLTableRowElement, content: Node | string): void => { const td = document.createElement('td'); td.append(content); row.append(td) }
    const list = (values: string[]): HTMLElement => { const ul = document.createElement('ul'); ul.className = 'xp-whm-tokens__list'; for (const value of values) { const li = document.createElement('li'); li.append(ltr(value)); ul.append(li) } return ul }
    const stateLabel = (state: PanelTokenStateView): string => ({ active: t('Active'), expired: t(msgctxt('whm-panel-tokens-client', 'Expired')), revoked: t('Revoked') })[state]
    const badge = (state: PanelTokenStateView): HTMLElement => { const node = document.createElement('span'); node.className = 'xp-badge xp-badge--' + (state === 'active' ? 'ok' : state === 'revoked' ? 'critical' : 'suspended'); node.dataset.status = state; node.textContent = stateLabel(state); return node }
    const failText = (error: unknown, fallback: string): string => {
      const failed = error as { status?: number; details?: { verificationRequired?: boolean; stateChanged?: boolean } }
      return failed?.details?.verificationRequired || failed?.details?.stateChanged ? t('The result could not be verified. Refresh the token list before acting again.')
        : failed?.status === 403 ? t('Root authorization from an interactive sign-in is required.')
          : failed?.status === 503 ? t('The token store is unavailable. Nothing was read or changed.') : fallback
    }
    const paintRows = (): void => {
      rows.textContent = ''
      for (const token of tokens) {
        const row = document.createElement('tr')
        row.dataset.tokenState = token.state
        cell(row, ltr(token.name)); cell(row, list(token.scopes)); cell(row, token.allowedIps.length ? list(token.allowedIps) : t('Any address'))
        cell(row, ltr(formatDisplayDateTime(token.createdAt))); cell(row, ltr(formatDisplayDateTime(token.expiresAt)))
        cell(row, token.lastUsedAt ? ltr(formatDisplayDateTime(token.lastUsedAt)) : usageRecorded ? t('Never') : t(msgctxt('whm-panel-tokens-client', 'Not recorded')))
        cell(row, badge(token.state))
        if (token.state === 'active') {
          const button = document.createElement('button')
          button.type = 'button'; button.className = 'xp-btn xp-btn--danger'; button.textContent = t(msgctxt('whm-panel-tokens-client', 'Revoke')); button.dataset.whmTokensRevoke = token.id
          button.setAttribute('aria-label', t('Revoke token {name}', { name: token.name }))
          button.disabled = !!revoking || !admitted() || typeof askDialog !== 'function'
          button.addEventListener('click', () => { void revoke(token) })
          cell(row, button)
        } else cell(row, t('No action'))
        rows.append(row)
      }
      if (!tokens.length) { const row = document.createElement('tr'), td = document.createElement('td'); td.colSpan = 8; td.textContent = t('No tokens were returned.'); row.append(td); rows.append(row) }
      if (empty) empty.hidden = tokens.length > 0
    }
    const loadList = async (): Promise<void> => {
      if (!admitted() || !request || listBusy) return
      listBusy = true; refresh.disabled = true; root.setAttribute('aria-busy', 'true'); if (loading && !tokens.length) loading.hidden = false
      note(status, 'reading', t('Reading your API tokens…'))
      try {
        const listed = readPanelTokenListView(await request('GET', '/api/server/panel/api-tokens'))
        tokens = listed.tokens; usageRecorded = listed.usageRecorded; paintRows()
        const active = tokens.filter(token => token.state === 'active').length
        note(status, 'read', tokens.length ? t('Tokens read. Active tokens: {count}.', { count: active }) : t('Tokens read. You have no API tokens.'))
      } catch (error) {
        note(status, 'failed', failText(error, t('Your tokens could not be read or verified. Any rows shown are from the last successful read; nothing was changed.')))
      } finally { listBusy = false; refresh.disabled = !admitted(); root.setAttribute('aria-busy', 'false'); if (loading) loading.hidden = true }
    }
    const hideSecret = (): void => { secretView.textContent = ''; revealText.textContent = ''; copyStatus.hidden = true; reveal.hidden = true }
    const syncAll = (): void => { for (const box of scopeBoxes) { if (all.checked) box.checked = false; box.disabled = all.checked || creating } }
    const revoke = async (token: PanelTokenView): Promise<void> => {
      if (revoking || !admitted() || !request || typeof askDialog !== 'function') return
      revoking = token.id; paintRows()
      let confirmed = false
      try {
        confirmed = await askDialog({ title: t('Revoke this token?'), danger: true, confirm: t(msgctxt('whm-panel-tokens-client', 'Revoke token')), cancel: t('Keep token'),
          body: t('Scripts using {name} stop working at once. This cannot be undone.', { name: token.name }) }) === true
      } catch { confirmed = false }
      if (!confirmed) { revoking = ''; paintRows(); return }
      note(revokeStatus, 'reading', t('Revoking the token…'))
      try {
        const updated = readPanelTokenView((await request('POST', '/api/server/panel/api-tokens/' + token.id + '/revoke') as { token?: unknown })?.token)
        if (updated.id !== token.id || updated.state !== 'revoked') throw Object.assign(new Error('unverified'), { details: { verificationRequired: true } })
        note(revokeStatus, 'read', t('Token revoked: {name}.', { name: token.name }))
      } catch (error) {
        const code = (error as { status?: number })?.status
        note(revokeStatus, 'failed', code === 409 ? t('The token is no longer active, so nothing was changed.') : code === 404 ? t('The token was not found. Refresh the list.') : failText(error, t('The token was not revoked.')))
      }
      revoking = ''; await loadList()
    }
    if (!admitted()) {
      for (const control of controls) control.disabled = true
      note(status, 'unavailable', t('API token management is unavailable here. Nothing was read or changed.'))
      return
    }
    all.addEventListener('change', syncAll)
    clear.addEventListener('click', () => { form.reset(); name.removeAttribute('aria-invalid'); ips.removeAttribute('aria-invalid'); syncAll(); createStatus.hidden = true })
    refresh.addEventListener('click', () => { void loadList() })
    done.addEventListener('click', hideSecret)
    copy.addEventListener('click', () => {
      const secret = secretView.textContent ?? ''
      const clipboard = navigator.clipboard
      if (!secret) return
      if (!clipboard?.writeText) { note(copyStatus, 'failed', t('Copying is not available in this browser. Select the token and copy it.')); return }
      clipboard.writeText(secret).then(() => note(copyStatus, 'read', t('Copied.')), () => note(copyStatus, 'failed', t('The token could not be copied. Select it and copy it.')))
    })
    form.addEventListener('submit', async event => {
      event.preventDefault()
      if (creating || !admitted() || !request) return
      const tokenName = name.value.trim()
      const addresses = ips.value.split(/[\s,]+/).filter(Boolean)
      const scopes = all.checked ? ['*'] : scopeBoxes.filter(box => box.checked).map(box => box.value)
      const days = Number(expiry.value)
      name.removeAttribute('aria-invalid'); ips.removeAttribute('aria-invalid')
      if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(tokenName)) { name.setAttribute('aria-invalid', 'true'); note(createStatus, 'failed', t('Enter a name of lowercase letters, digits and inner dashes, up to 64 characters.')); name.focus(); return }
      if (!scopes.length) { note(createStatus, 'failed', t('Choose at least one scope. A token can do only what its scopes allow.')); return }
      if (addresses.length > 16 || !addresses.every(address => /^[0-9A-Fa-f.:]{2,45}(?:\/[0-9]{1,3})?$/.test(address))) { ips.setAttribute('aria-invalid', 'true'); note(createStatus, 'failed', t('Enter up to 16 IPv4 or IPv6 addresses or CIDR ranges, separated by commas.')); ips.focus(); return }
      if (!Number.isSafeInteger(days) || days < 1 || days > 365) { note(createStatus, 'failed', t('Choose when the token expires.')); return }
      creating = true; submit.disabled = true; syncAll()
      try {
        if (scopes[0] === '*') {
          let confirmed = false
          try { confirmed = typeof askDialog === 'function' && await askDialog({ title: t('Create a full-access token?'), danger: true, confirm: t('Create full-access token'), cancel: t('Choose scopes'),
            body: t('This token can do anything root can do through the API, including operations added later. Anyone holding it has that power until it expires or is revoked.') }) === true } catch { confirmed = false }
          if (!confirmed) { createStatus.hidden = true; return }
        }
        note(createStatus, 'reading', t('Creating the token…'))
        const created = readPanelTokenCreatedView(await request('POST', '/api/server/panel/api-tokens', { name: tokenName, scopes, expiresInDays: days, ...(addresses.length ? { allowedIps: addresses } : {}) }))
        if (created.token.name !== tokenName) throw Object.assign(new Error('unverified'), { details: { verificationRequired: true } })
        secretView.textContent = created.secret
        revealText.textContent = t('Copy the token for {name} now. It is shown once; after you leave this page only its hash remains.', { name: created.token.name })
        copyStatus.hidden = true; reveal.hidden = false
        form.reset()
        note(createStatus, 'read', t('Token created: {name}.', { name: created.token.name }))
      } catch (error) {
        const code = (error as { status?: number })?.status
        note(createStatus, 'failed', code === 409 ? t('You already have 50 active tokens. Revoke one before creating another.')
          : code === 400 ? t('The server refused these values. Check the name, scopes, expiry and addresses.') : failText(error, t('The token was not created.')))
      } finally { creating = false; submit.disabled = !admitted(); syncAll() }
      await loadList()
    })
    window.addEventListener('pagehide', hideSecret)
    void loadList()
  })
}

export const WHM_PANEL_TOKENS_CLIENT_BINDING = `(()=>{const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const readPanelTokenView=${readPanelTokenView.toString()};const readPanelTokenListView=${readPanelTokenListView.toString()};const readPanelTokenCreatedView=${readPanelTokenCreatedView.toString()};return ${bindWhmPanelTokens.toString()};})()`
