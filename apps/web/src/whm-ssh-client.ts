import type { MessageValues } from './i18n.ts'
/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'
import { assertWhmClientTemplates as canonicalAssertWhmClientTemplates, clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate, WHM_CLIENT_TEMPLATE_BINDING } from './whm-client-templates.ts'
const displayDateTime = formatDisplayDateTime
const assertWhmClientTemplates = canonicalAssertWhmClientTemplates, clientTemplate = canonicalClientTemplate, clientTemplateSlot = canonicalClientTemplateSlot, cloneClientTemplate = canonicalCloneClientTemplate

function bindWhmSsh(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  const safe = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && value.isWellFormed() && !/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/.test(value)
  type Key = { fingerprint: string; keyType: string; comment: string; managed: boolean; protected: boolean; addedAt: string | null; lastUsedAt: null }
  type Keys = { state: string; revision: string | null; items: Key[]; opaqueEntries: number }
  const keysFrom = (value: unknown): Keys => {
    if (!object(value) || !['read', 'partial', 'review-required', 'unavailable'].includes(String(value.state)) || !Array.isArray(value.items) || value.items.length > 500 || !Number.isSafeInteger(value.opaqueEntries) || Number(value.opaqueEntries) < 0) throw new Error('invalid_ssh_keys')
    if (value.state === 'unavailable' ? value.revision !== null : typeof value.revision !== 'string' || !/^[0-9a-f]{64}$/.test(value.revision)) throw new Error('invalid_ssh_revision')
    if (value.state === 'unavailable' && (value.items.length !== 0 || value.opaqueEntries !== 0)) throw new Error('invalid_ssh_keys')
    const items = value.items.map(raw => {
      if (!object(raw) || typeof raw.fingerprint !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(raw.fingerprint) || !safe(raw.keyType, 64) || !safe(raw.comment, 256) || typeof raw.managed !== 'boolean' || typeof raw.protected !== 'boolean' || raw.addedAt !== null && (typeof raw.addedAt !== 'string' || !Number.isFinite(Date.parse(raw.addedAt))) || raw.lastUsedAt !== null) throw new Error('invalid_ssh_key')
      return { fingerprint: raw.fingerprint, keyType: raw.keyType, comment: raw.comment, managed: raw.managed, protected: raw.protected, addedAt: raw.addedAt as string | null, lastUsedAt: null }
    })
    return { state: String(value.state), revision: value.revision as string | null, items, opaqueEntries: Number(value.opaqueEntries) }
  }
  const fingerprintFor = async (value: string): Promise<string> => {
    if (!safe(value, 8192)) throw new Error('invalid_public_key')
    const tokens = value.trim().split(/\s+/)
    if (!/^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)$/.test(tokens[0] ?? '') || !/^[A-Za-z0-9+/]{32,}={0,2}$/.test(tokens[1] ?? '')) throw new Error('invalid_public_key')
    const bytes = Uint8Array.from(atob(tokens[1]!), character => character.charCodeAt(0))
    const digest = new Uint8Array(await window.crypto.subtle.digest('SHA-256', bytes))
    return 'SHA256:' + btoa(String.fromCharCode(...digest)).replace(/=+$/, '')
  }
  const sameKeys = (left: Keys, right: Keys): boolean => left.revision === right.revision && JSON.stringify(left.items) === JSON.stringify(right.items) && left.opaqueEntries === right.opaqueEntries
  document.querySelectorAll<HTMLElement>('[data-whm-detail-route="/whm/security/ssh"]').forEach(root => {
    const panel = root.querySelector<HTMLElement>('[data-whm-ssh-keys]')
    if (!panel || panel.dataset.sshBound === 'true') return
    panel.dataset.sshBound = 'true'
    const rows = panel.querySelector<HTMLElement>('[data-whm-ssh-key-rows]')!, publicKey = panel.querySelector<HTMLTextAreaElement>('[data-whm-ssh-public-key]')!, status = panel.querySelector<HTMLElement>('[data-whm-ssh-status]')!, refresh = panel.querySelector<HTMLButtonElement>('[data-whm-ssh-refresh]')!, add = panel.querySelector<HTMLButtonElement>('[data-whm-ssh-add]')!
    if (!rows || !publicKey || !status || !refresh || !add) return
    const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const range = root.querySelector<HTMLSelectElement>('[data-whm-ssh-window]')
    const policy = root.querySelector<HTMLElement>('[data-whm-ssh-effective]')!, failures = root.querySelector<HTMLElement>('[data-whm-ssh-failure-rows]')!
    const denied = '[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[data-capability-state="unavailable"],[aria-disabled="true"],fieldset:disabled'
    let templateContractIntact = true
    const admitted = (): boolean => templateContractIntact && typeof transport === 'function' && root.isConnected && root.dataset.whmDetailRoute === '/whm/security/ssh' && !root.closest(denied) && !panel.closest(denied)
    const manageable = (): boolean => admitted() && panel.dataset.whmSshManage === 'true' && typeof askDialog === 'function'
    let keys: Keys | null = null, busy = false, review = false, confirming = false
    let selectedWindow: '24h' | '7d' = '24h', addAvailable = false, removeAvailable = false
    const note = (state: string, text: string): void => { status.dataset.state = state; status.textContent = text; status.setAttribute('role', ['failed', 'stale', 'uncertain'].includes(state) ? 'alert' : 'status') }
    const unavailable = (): false => {
      publicKey.disabled = true; publicKey.readOnly = true; add.disabled = true; refresh.disabled = true
      if (range) range.disabled = true
      panel.querySelectorAll<HTMLButtonElement>('[data-whm-ssh-remove]').forEach(button => { button.disabled = true })
      note('unavailable', t('Unavailable')); return false
    }
    const verifyTemplates = (): boolean => {
      if (!admitted()) return unavailable()
      try {
        for (const [selector, tag, expected] of [
          ['[data-whm-ssh-keys]', 'DIV', panel], ['[data-whm-ssh-key-rows]', 'TBODY', rows],
          ['[data-whm-ssh-public-key]', 'TEXTAREA', publicKey], ['[data-whm-ssh-status]', 'P', status],
          ['[data-whm-ssh-refresh]', 'BUTTON', refresh], ['[data-whm-ssh-add]', 'BUTTON', add],
          ['[data-whm-ssh-effective]', 'DL', policy], ['[data-whm-ssh-failure-rows]', 'TBODY', failures],
          ['[data-whm-ssh-window]', 'SELECT', range],
        ] as const) {
          const nodes = [...root.querySelectorAll<HTMLElement>(selector)].filter(node => node.closest('[data-whm-detail-route]') === root)
          if (nodes.length !== 1 || nodes[0] !== expected || expected?.tagName !== tag) throw new Error('invalid_ssh_workspace')
        }
        if (refresh.type !== 'button' || add.type !== 'button') throw new Error('invalid_ssh_workspace')
        assertWhmClientTemplates(root, [
          ['whm-ssh-remove', 'button', { label: 'span' }],
          ['whm-ssh-fact-technical', 'div', { label: 'dt', value: 'bdi' }],
          ['whm-ssh-fact-text', 'div', { label: 'dt', value: 'span' }],
        ])
        const removeTemplate = clientTemplate(root, 'whm-ssh-remove')
        const remove = cloneClientTemplate(removeTemplate, 'button', ['label']) as HTMLButtonElement, removeLabel = clientTemplateSlot(remove, 'label', 'span')
        if (removeTemplate.closest('[data-whm-detail-route]') !== root || remove.getAttribute('type') !== 'button' || !remove.disabled
          || !remove.hasAttribute('data-whm-ssh-remove') || remove.getAttribute('data-whm-ssh-remove') !== ''
          || remove.dataset.protected !== 'true' || remove.children.length !== 1 || remove.firstElementChild !== removeLabel || removeLabel.children.length) throw new Error('invalid_ssh_remove')
        const prototypes: HTMLElement[] = [remove]
        for (const [name, tag] of [['whm-ssh-fact-technical', 'bdi'], ['whm-ssh-fact-text', 'span']] as const) {
          const template = clientTemplate(root, name), group = cloneClientTemplate(template, 'div', ['label', 'value'])
          const label = clientTemplateSlot(group, 'label', 'dt'), value = clientTemplateSlot(group, 'value', tag), definition = value.parentElement
          if (template.closest('[data-whm-detail-route]') !== root || group.children.length !== 2 || group.firstElementChild !== label || label.children.length
            || definition?.tagName !== 'DD' || group.lastElementChild !== definition || definition.children.length !== 1 || value.children.length
            || (tag === 'bdi' ? value.getAttribute('dir') !== 'ltr' : value.hasAttribute('dir'))) throw new Error('invalid_ssh_fact')
          prototypes.push(group)
        }
        for (const prototype of prototypes) for (const node of [prototype, ...prototype.querySelectorAll<HTMLElement>('*')])
          if ([...node.attributes].some(attr => /^on/i.test(attr.name) || ['id', 'api-url', 'data-api-url', 'data-action', 'data-xp-action', 'href', 'form', 'formaction', 'contenteditable'].includes(attr.name))) throw new Error('invalid_ssh_template')
        return true
      } catch { templateContractIntact = false; return unavailable() }
    }
    const lock = (): void => {
      const blocked = busy || confirming || review || !manageable() || !keys || !['read', 'partial'].includes(keys.state)
      publicKey.disabled = !admitted() || !keys; publicKey.readOnly = blocked || !addAvailable || !!keys?.opaqueEntries
      add.disabled = blocked || !addAvailable || !!keys?.opaqueEntries || !publicKey.value.trim()
      refresh.disabled = busy || confirming || !admitted()
      if (range) range.disabled = busy || confirming || !admitted()
      panel.querySelectorAll<HTMLButtonElement>('[data-whm-ssh-remove]').forEach(button => { button.disabled = blocked || !removeAvailable || button.dataset.protected === 'true' || !!button.closest(denied) })
      panel.setAttribute('aria-busy', String(busy || confirming))
    }
    const request = async (method: string, path: string, body?: unknown): Promise<unknown> => {
      if (!transport || !verifyTemplates()) throw new Error('ssh_workspace_unavailable')
      const response = await (body === undefined ? transport(method, path) : transport(method, path, body))
      if (!verifyTemplates()) throw new Error('ssh_workspace_unavailable')
      return response
    }
    const confirm = async (title: string, body: string, danger = false): Promise<boolean> => {
      if (!verifyTemplates()) return false
      if (!askDialog || confirming) { note('failed', t('Confirmation is unavailable; no key change was sent.')); return false }
      confirming = true; lock()
      try { const accepted = await askDialog({ title, body, danger, confirm: t('Confirm') }); return verifyTemplates() && accepted === true } catch { return false } finally { confirming = false; lock() }
    }
    const textCell = (row: HTMLTableRowElement, text: string, technical = false): void => { const cell = document.createElement('td'), content = document.createElement(technical ? 'bdi' : 'span'); if (technical) content.dir = 'ltr'; content.textContent = text; cell.append(content); row.append(cell) }
    const placeholder = (body: HTMLElement, text: string, columns: number): void => { body.textContent = ''; const row = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = columns; cell.textContent = text; row.append(cell); body.append(row) }
    const paintKeys = (): void => {
      rows.textContent = ''
      const opaque = panel.querySelector<HTMLElement>('[data-whm-ssh-opaque]')
      if (opaque) { opaque.hidden = !keys?.opaqueEntries; opaque.textContent = keys?.opaqueEntries ? String(keys.opaqueEntries) + ' · ' + t('Unrecognized existing entries are preserved and protected.') : '' }
      if (!keys || keys.state === 'unavailable') { placeholder(rows, t('Authorized-key observations are unavailable.'), 6); return }
      for (const key of keys.items) {
        const row = document.createElement('tr'); textCell(row, key.fingerprint, true); textCell(row, key.keyType, true); textCell(row, key.comment || t('Not shown')); textCell(row, key.addedAt === null ? t('Not observed') : displayDateTime(key.addedAt), key.addedAt !== null); textCell(row, t('Not observed'))
        const cell = document.createElement('td'), remove = cloneClientTemplate(clientTemplate(root, 'whm-ssh-remove'), 'button', ['label']) as HTMLButtonElement
        remove.dataset.whmSshRemove = key.fingerprint; remove.dataset.protected = String(key.protected || !key.managed)
        clientTemplateSlot(remove, 'label', 'span').textContent = key.protected || !key.managed ? t('Protected key') : t('Remove managed key')
        remove.addEventListener('click', () => { if (!remove.disabled && remove.isConnected && remove.closest('[data-whm-detail-route]') === root && verifyTemplates()) void mutate('DELETE', key.fingerprint) }); cell.append(remove); row.append(cell); rows.append(row)
      }
      if (!keys.items.length) placeholder(rows, keys.opaqueEntries ? t('Unrecognized existing entries are preserved and protected.') : t('The authorized-key read returned no keys.'), 6)
      lock()
    }
    const paintDetails = (ssh: Record<string, unknown>): void => {
      if (policy) {
        if (!object(ssh.policy) || !['read', 'unavailable'].includes(String(ssh.policy.state)) || !object(ssh.policy.values) || !object(ssh.service)) throw new Error('invalid_ssh_policy')
        const fields: [string, string, boolean][] = []
        if (ssh.policy.state === 'read') for (const [key, value] of Object.entries(ssh.policy.values)) { if (!safe(key, 64) || !safe(value, 1024)) throw new Error('invalid_ssh_policy'); fields.push([key, value, true]) }
        if (ssh.service.state === 'read') for (const key of ['unit', 'active', 'substate', 'enabled']) { const value = ssh.service[key]; if (!safe(value, 128)) throw new Error('invalid_ssh_service'); fields.push([key, value, true]) }
        policy.textContent = ''
        if (!fields.length) fields.push([t('Host observations'), t('Unavailable'), false])
        if (safe(ssh.observedAt, 40) && Number.isFinite(Date.parse(ssh.observedAt))) fields.push([t('Read started (UTC)'), displayDateTime(ssh.observedAt), true])
        for (const [label, value, technical] of fields) {
          const group = cloneClientTemplate(clientTemplate(root, technical ? 'whm-ssh-fact-technical' : 'whm-ssh-fact-text'), 'div', ['label', 'value'])
          clientTemplateSlot(group, 'label', 'dt').textContent = label; clientTemplateSlot(group, 'value', technical ? 'bdi' : 'span').textContent = value; policy.append(group)
        }
      }
      if (failures) {
        const value = ssh.failedLogins
        if (!object(value) || !['read', 'unavailable'].includes(String(value.state)) || !Array.isArray(value.items) || value.items.length > 500 || !['24h', '7d'].includes(String(value.window)) || value.limit !== 500 || typeof value.truncated !== 'boolean') throw new Error('invalid_ssh_failures')
        const items = value.items.map(raw => { if (!object(raw) || !safe(raw.at, 40) || !Number.isFinite(Date.parse(raw.at)) || !safe(raw.address, 64) || !safe(raw.username, 64) || !safe(raw.method, 64)) throw new Error('invalid_ssh_failure'); return raw })
        failures.textContent = ''
        if (value.state === 'unavailable') placeholder(failures, t('Trusted SSH journal observations are unavailable.'), 6)
        else if (!items.length) placeholder(failures, t('No matching trusted sshd failure events were returned within this bounded read.'), 6)
        else for (const item of items) { const row = document.createElement('tr'); for (const key of ['at', 'address', 'username', 'method']) textCell(row, key === 'at' ? displayDateTime(String(item[key])) : String(item[key]), true); textCell(row, '1', true); textCell(row, t('Observed; ban state not read')); failures.append(row) }
        const notice = root.querySelector<HTMLElement>('[data-whm-ssh-failures-note]')
        if (notice) notice.textContent = value.truncated ? t('Only the latest 500 journal entries were read. Older failures may be outside this result; ban state was not read.') : value.window === '7d' ? t('A bounded 7-day sshd journal read supplies these events. Ban state was not read.') : t('A bounded 24-hour sshd journal read supplies these events. Ban state was not read.')
      }
    }
    const read = async (window: '24h' | '7d' = selectedWindow): Promise<{ ssh: Record<string, unknown>; keys: Keys; actions: { add: boolean; remove: boolean } }> => {
      const response = await request('GET', '/api/security/ssh' + (window === '7d' ? '?window=7d' : ''))
      if (!object(response) || !object(response.ssh) || !object(response.keyActions) || typeof response.keyActions.add !== 'boolean' || typeof response.keyActions.remove !== 'boolean' || !object(response.ssh.failedLogins) || response.ssh.failedLogins.window !== window) throw new Error('invalid_ssh_response')
      return { ssh: response.ssh, keys: keysFrom(response.ssh.keys), actions: { add: response.keyActions.add, remove: response.keyActions.remove } }
    }
    const refreshRead = async (targetWindow: '24h' | '7d' = selectedWindow): Promise<void> => {
      if (busy || confirming || !verifyTemplates()) return
      if ((review || publicKey.value.trim()) && !await confirm(t('Read saved SSH observations?'), t('Review the current keys before continuing. The public-key draft is retained and no previous mutation is retried.'))) return
      if (busy || confirming || !verifyTemplates()) return
      busy = true; lock(); note('reading', t('Reading SSH observations…'))
      try {
        const observed = await read(targetWindow); if (!verifyTemplates()) return
        paintDetails(observed.ssh); keys = observed.keys; selectedWindow = targetWindow
        if (range) range.value = selectedWindow
        addAvailable = observed.actions.add; removeAvailable = observed.actions.remove; review = keys.state === 'review-required'; paintKeys()
        note(review ? 'uncertain' : keys.state === 'unavailable' ? 'unavailable' : 'read', review ? t('A host key write requires operator review. Key changes remain locked.') : keys.state === 'unavailable' ? t('Authorized keys could not be observed. Other host observations are shown when available.') : !addAvailable && !removeAvailable ? t('SSH observations read. Key changes are unavailable on this host; connection-specific policy and authentication are unverified.') : t('SSH observations read. Connection-specific policy and key authentication are not verified here.'))
      }
      catch { if (verifyTemplates()) note('failed', t('SSH observations could not be read. Existing values and the draft are retained.')) }
      finally { busy = false; lock() }
    }
    async function mutate(method: 'POST' | 'DELETE', target?: string): Promise<void> {
      if (!keys || busy || confirming || review || !verifyTemplates() || !manageable() || !['read', 'partial'].includes(keys.state) || !(method === 'POST' ? addAvailable && keys.opaqueEntries === 0 : removeAvailable)) return
      const baseline = keys, source = publicKey.value.trim()
      let selectedFingerprint: string
      busy = true; lock()
      try { selectedFingerprint = method === 'POST' ? await fingerprintFor(source) : target!; if (!verifyTemplates()) return; if (method === 'DELETE' && !baseline.items.some(key => key.fingerprint === target && key.managed && !key.protected)) return }
      catch { note('failed', t('Enter a single valid public key. No change was sent.')); return }
      finally { busy = false; lock() }
      if (!await confirm(method === 'POST' ? t('Add root public key') : t('Remove managed root key'), selectedFingerprint + '\n' + t('This changes the root authorized-key file. Authentication with a new key must be checked separately.'), method === 'DELETE')) return
      if (busy || !verifyTemplates() || !manageable()) return
      busy = true; lock(); let sent = false
      try {
        const current = await read()
        if (!verifyTemplates()) return
        addAvailable = current.actions.add; removeAvailable = current.actions.remove
        if (!(method === 'POST' ? addAvailable : removeAvailable)) throw { details: { stateChanged: false } }
        if (!['read', 'partial'].includes(current.keys.state) || !sameKeys(current.keys, baseline)) { review = true; note('stale', t('The authorized keys changed. Read and review them before retrying; the draft is retained.')); return }
        sent = true
        const response = await request(method, '/api/security/ssh/keys', method === 'POST' ? { publicKey: source, expectedRevision: baseline.revision } : { fingerprint: selectedFingerprint, expectedRevision: baseline.revision })
        if (!verifyTemplates()) throw new Error('ssh_workspace_unavailable')
        const responseDetails = object(response) && object(response.details) ? response.details : {}
        if (!object(response) || response.applied !== true || [response, responseDetails].some(value => value.unknownOutcome === true || value.verificationRequired === true || value.needsAttention === true)) throw new Error('invalid_ssh_ack')
        const acknowledged = keysFrom(response.keys), others = baseline.items.filter(key => key.fingerprint !== selectedFingerprint)
        if (!['read', 'partial'].includes(acknowledged.state) || acknowledged.revision === baseline.revision || JSON.stringify(acknowledged.items.filter(key => key.fingerprint !== selectedFingerprint)) !== JSON.stringify(others) || acknowledged.opaqueEntries !== baseline.opaqueEntries) throw new Error('wrong_ssh_key_ack')
        if (method === 'POST' ? !acknowledged.items.some(key => key.fingerprint === selectedFingerprint && key.managed) : acknowledged.items.some(key => key.fingerprint === selectedFingerprint)) throw new Error('wrong_ssh_key_target')
        const observed = await read()
        if (!verifyTemplates()) throw new Error('ssh_workspace_unavailable')
        if (!['read', 'partial'].includes(observed.keys.state) || !sameKeys(observed.keys, acknowledged)) throw new Error('ssh_key_readback_mismatch')
        keys = observed.keys; addAvailable = observed.actions.add; removeAvailable = observed.actions.remove; paintDetails(observed.ssh); paintKeys(); review = false
        if (method === 'POST') publicKey.value = ''
        note('saved', t('The authorized-key change was applied and read back. Key authentication and connection-specific policy are not verified here.'))
      } catch (error) {
        const contractValid = verifyTemplates()
        const details = object(error) && object(error.details) ? error.details : {}
        const refused = object(error) && (error.stateChanged === false || details.stateChanged === false) && details.unknownOutcome !== true && details.verificationRequired !== true
        review = sent && !refused || object(error) && error.status === 409
        if (!contractValid && !sent) return
        note(review ? 'uncertain' : 'failed', review ? t('The key-change outcome requires review. No retry was sent; read the current keys before continuing.') : t('The key change was refused or the current state could not be read. The draft is retained.'))
      } finally { busy = false; lock() }
    }
    if (!transport || !admitted()) { lock(); note('unavailable', t('SSH observations are unavailable here. No key change was sent.')); return }
    if (!verifyTemplates()) return
    publicKey.addEventListener('input', () => { if (verifyTemplates()) lock() }); refresh.addEventListener('click', () => { void refreshRead() }); add.addEventListener('click', () => { void mutate('POST') })
    range?.addEventListener('change', () => { const target = range.value === '7d' ? '7d' : '24h'; range.value = selectedWindow; void refreshRead(target) })
    window.addEventListener('beforeunload', event => { if (review || publicKey.value.trim()) { event.preventDefault(); event.returnValue = '' } })
    void refreshRead()
  })
}

export const WHM_SSH_CLIENT_BINDING = `(()=>{const displayDateTime=${DISPLAY_DATETIME_BINDING};${WHM_CLIENT_TEMPLATE_BINDING}return ${bindWhmSsh.toString()};})()`
