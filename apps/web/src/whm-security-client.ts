import type { MessageValues } from './i18n.ts'
import { assertWhmClientTemplates as canonicalAssertWhmClientTemplates, clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate, WHM_CLIENT_TEMPLATE_BINDING } from './whm-client-templates.ts'
import './i18n.ts'
/// <reference lib="dom" />
const assertWhmClientTemplates = canonicalAssertWhmClientTemplates, clientTemplate = canonicalClientTemplate, clientTemplateSlot = canonicalClientTemplateSlot, cloneClientTemplate = canonicalCloneClientTemplate

function bindWhmSecurity(): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const names: Record<string, string> = { 'ssh-service': t('SSH service'), 'ssh-public-key': t('Default public-key authentication'), 'ssh-password': t('Default password authentication disabled'), 'ssh-root-login': t('Default root password sign-in restricted'), 'ssh-attempts': t('Default authentication attempt limit') }
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  const safe = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && value.isWellFormed() && !/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/.test(value)
  document.querySelectorAll<HTMLElement>('[data-whm-security-evidence]').forEach(root => {
    if (root.dataset.securityBound === 'true') return
    root.dataset.securityBound = 'true'
    const rows = root.querySelector<HTMLElement>('[data-whm-security-check-rows]')!, config = root.querySelector<HTMLElement>('[data-whm-security-configuration]')!, status = root.querySelector<HTMLElement>('[data-whm-security-status]')!, refresh = root.querySelector<HTMLButtonElement>('[data-whm-security-refresh]')!
    if (!rows || !config || !status || !refresh) return
    const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    let templateContractIntact = true
    const admitted = (): boolean => templateContractIntact && typeof send === 'function' && root.isConnected && !root.closest('[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[data-capability-state="unavailable"],[aria-disabled="true"],fieldset:disabled')
    const note = (state: string, value: string): void => { status.dataset.state = state; status.textContent = value; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const verifyTemplates = (): boolean => {
      if (!admitted()) { refresh.disabled = true; note('unavailable', t('Unavailable')); return false }
      try {
        for (const [selector, tag, expected] of [['[data-whm-security-check-rows]', 'TBODY', rows], ['[data-whm-security-configuration]', 'DL', config], ['[data-whm-security-status]', 'P', status], ['[data-whm-security-refresh]', 'BUTTON', refresh]] as const) {
          const nodes = [...root.querySelectorAll<HTMLElement>(selector)].filter(node => node.closest('[data-whm-security-evidence]') === root)
          if (nodes.length !== 1 || nodes[0] !== expected || expected.tagName !== tag) throw new Error('invalid_security_workspace')
        }
        if (refresh.type !== 'button') throw new Error('invalid_security_workspace')
        assertWhmClientTemplates(root, [['whm-security-fact-technical', 'div', { label: 'dt', value: 'bdi' }], ['whm-security-fact-text', 'div', { label: 'dt', value: 'span' }]])
        for (const [name, tag] of [['whm-security-fact-technical', 'bdi'], ['whm-security-fact-text', 'span']] as const) {
          const template = clientTemplate(root, name), group = cloneClientTemplate(template, 'div', ['label', 'value'])
          const label = clientTemplateSlot(group, 'label', 'dt'), value = clientTemplateSlot(group, 'value', tag), definition = value.parentElement
          if (template.closest('[data-whm-security-evidence]') !== root || group.children.length !== 2 || group.firstElementChild !== label || label.children.length || definition?.tagName !== 'DD' || group.lastElementChild !== definition || definition.children.length !== 1 || value.children.length || (tag === 'bdi' ? value.getAttribute('dir') !== 'ltr' : value.hasAttribute('dir'))) throw new Error('invalid_security_fact')
          for (const node of [group, ...group.querySelectorAll<HTMLElement>('*')]) if ([...node.attributes].some(attr => /^on/i.test(attr.name) || ['id', 'api-url', 'data-api-url', 'data-action', 'data-xp-action', 'href', 'formaction', 'contenteditable'].includes(attr.name))) throw new Error('invalid_security_fact')
        }
        return true
      } catch {
        templateContractIntact = false; refresh.disabled = true; note('unavailable', t('Unavailable')); return false
      }
    }
    let busy = false
    const cell = (row: HTMLTableRowElement, value: string, technical = false): void => { const td = document.createElement('td'), content = document.createElement(technical ? 'bdi' : 'span'); if (technical) content.dir = 'ltr'; content.textContent = value; td.append(content); row.append(td) }
    const read = async (): Promise<void> => {
      if (!send || busy || !verifyTemplates()) return
      busy = true; refresh.disabled = true; root.setAttribute('aria-busy', 'true'); note('reading', t('Reading security observations…'))
      try {
        const value = await send('GET', '/api/security/workspace')
        if (!verifyTemplates()) return
        if (!object(value) || value.overall !== 'not-qualified' || !Array.isArray(value.checks) || value.checks.length !== Object.keys(names).length || !object(value.configuration)) throw new Error('invalid_security_observation')
        const seen = new Set<string>()
        const checks = value.checks.map(raw => {
          if (!object(raw) || typeof raw.id !== 'string' || !Object.hasOwn(names, raw.id) || seen.has(raw.id) || !['observed-ok', 'attention', 'unavailable'].includes(String(raw.state)) || raw.source !== 'host-observation' || raw.value !== null && !safe(raw.value, 1024)) throw new Error('invalid_security_check')
          seen.add(raw.id); return raw
        })
        const saved = value.configuration
        if (saved.source !== 'saved-configuration' || !['read', 'unavailable'].includes(String(saved.state)) || saved.state === 'read' && (!Number.isSafeInteger(saved.panelPort) || !Number.isSafeInteger(saved.sshPort) || !safe(saved.engine, 32))) throw new Error('invalid_security_configuration')
        const nextRows = document.createDocumentFragment(), nextConfig = document.createDocumentFragment()
        for (const check of checks) {
          const row = document.createElement('tr'); row.dataset.checkState = String(check.state)
          cell(row, names[String(check.id)]!); cell(row, check.state === 'observed-ok' ? t(msgctxt('whm-security-client', 'Observed')) : check.state === 'attention' ? t(msgctxt('whm-security-client', 'Review')) : t('Unavailable')); cell(row, check.value === null ? t('Not observed') : String(check.value), check.value !== null); nextRows.append(row)
        }
        const fact = (label: string, value: string, technical = true): void => {
          const group = cloneClientTemplate(clientTemplate(root, technical ? 'whm-security-fact-technical' : 'whm-security-fact-text'), 'div', ['label', 'value'])
          clientTemplateSlot(group, 'label', 'dt').textContent = label; clientTemplateSlot(group, 'value', technical ? 'bdi' : 'span').textContent = value; nextConfig.append(group)
        }
        if (saved.state === 'read') { fact(t('Saved panel port'), String(saved.panelPort)); fact(t('Saved SSH port'), String(saved.sshPort)); fact(t('Saved web engine'), String(saved.engine)) }
        else fact(t('Saved configuration'), t('Unavailable'), false)
        rows.replaceChildren(nextRows); config.replaceChildren(nextConfig)
        note('read', t('Individual observations read. Unknown checks remain unavailable; no overall security qualification is claimed.'))
      } catch { if (verifyTemplates()) note('failed', t('Security observations could not be read. Existing values are retained and no change was sent.')) }
      finally { busy = false; root.setAttribute('aria-busy', 'false'); refresh.disabled = !admitted() }
    }
    if (!send || !admitted()) { refresh.disabled = true; note('unavailable', t('Security observations are unavailable here. No check was run.')); return }
    if (!verifyTemplates()) return
    refresh.addEventListener('click', () => { void read() }); refresh.disabled = false; void read()
  })
}

export const WHM_SECURITY_CLIENT_BINDING = `(()=>{${WHM_CLIENT_TEMPLATE_BINDING}return ${bindWhmSecurity.toString()};})()`
