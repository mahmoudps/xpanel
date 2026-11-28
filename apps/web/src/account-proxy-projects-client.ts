/// <reference lib="dom" />
import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './client-templates.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { frameRequest as canonicalFrameRequest, withFrameRequest } from './read-only-frame.ts'

const clientTemplate = canonicalClientTemplate
const clientTemplateSlot = canonicalClientTemplateSlot
const cloneClientTemplate = canonicalCloneClientTemplate
const frameRequest = canonicalFrameRequest

const TARGET_PATTERN = /^https?:\/\/(127\.0\.0\.1|\[::1\]|[A-Za-z0-9.-]{1,253}|\[[0-9A-Fa-f:]{2,39}\])(?::([0-9]{1,5}))?$/
const PATH_PATTERN = /^\/(?:[a-z0-9][a-z0-9._-]{0,62}(?:\/[a-z0-9][a-z0-9._-]{0,62}){0,3})?$/

export function proxyTargetDraftProblem(value: unknown): 'invalid' | null {
  if (typeof value !== 'string') return 'invalid'
  const match = TARGET_PATTERN.exec(value.trim())
  if (!match) return 'invalid'
  if (match[2] !== undefined) {
    const port = Number(match[2])
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return 'invalid'
  }
  return null
}

export interface SiteProxyRuleItem {
  domainId: string | null
  domain: string
  path: string
  target: string
  websocket: boolean
  hostHeader: 'client' | 'upstream'
  refusal: string | null
}

export interface SiteProxyRulesView {
  state: 'default' | 'saved' | 'invalid'
  revision: string
  limit: number
  runtimePorts: number[]
  domains: { id: string; name: string; kind: string; siteType: string; blocked: string | null }[]
  rules: SiteProxyRuleItem[]
  reconcile?: string | null
}

export interface ProxyProjectRuleItem {
  id: string
  path: string
  target: string
  websocket: boolean
  hostHeader: 'client' | 'upstream'
}

export interface ProxyProjectItem {
  id: string
  accountId: string
  name: string
  domains: string[]
  note: string
  ssl: { enabled: boolean; certificateId: string | null }
  cache: boolean
  gzip: boolean
  rules: ProxyProjectRuleItem[]
}

export interface ProxyProjectsView {
  state: 'default' | 'saved' | 'invalid'
  revision: string
  limit: number
  runtimePorts: number[]
  projects: ProxyProjectItem[]
  project?: ProxyProjectItem
  reconcile?: string | null
}

/** Strict parser for path-scoped site reverse-proxy rule responses. */
export function parseSiteProxyRulesResponse(raw: unknown): SiteProxyRulesView {
  const object = (item: unknown): item is Record<string, any> => !!item && typeof item === 'object' && !Array.isArray(item)
  const bad = (): never => { throw new Error('invalid_site_proxy_rules') }
  const hash = (item: unknown): string => typeof item === 'string' && /^[0-9a-f]{64}$/.test(item) ? item : bad()
  const safeText = (item: unknown, max: number): string => typeof item === 'string' && item.length <= max && !/[\u0000-\u001f\u007f<>]/.test(item) ? item : bad()
  if (!object(raw) || !['default', 'saved', 'invalid'].includes(raw.state) || !Array.isArray(raw.domains) || !Array.isArray(raw.rules)) return bad()
  const revision = hash(raw.revision)
  const limit = Number.isSafeInteger(raw.limit) ? raw.limit as number : bad()
  const runtimePorts = Array.isArray(raw.runtimePorts) && raw.runtimePorts.every((p: unknown) => Number.isSafeInteger(p)) ? raw.runtimePorts as number[] : []
  const domains = raw.domains.map((entry: unknown) => {
    if (!object(entry) || typeof entry.id !== 'string') return bad()
    return { id: entry.id, name: safeText(entry.name, 253), kind: safeText(entry.kind, 32), siteType: safeText(entry.siteType, 32), blocked: entry.blocked === null ? null : safeText(entry.blocked, 64) }
  })
  const rules = raw.rules.map((entry: unknown) => {
    if (!object(entry) || typeof entry.websocket !== 'boolean' || !['client', 'upstream'].includes(entry.hostHeader)) return bad()
    return {
      domainId: entry.domainId === null || typeof entry.domainId === 'string' ? entry.domainId : bad(),
      domain: safeText(entry.domain, 253),
      path: safeText(entry.path, 255),
      target: safeText(entry.target, 512),
      websocket: entry.websocket,
      hostHeader: entry.hostHeader as 'client' | 'upstream',
      refusal: entry.refusal === null || entry.refusal === undefined ? null : safeText(entry.refusal, 64),
    }
  })
  return { state: raw.state, revision, limit, runtimePorts, domains, rules, reconcile: typeof raw.reconcile === 'string' ? raw.reconcile : null }
}

/** Strict parser for standalone proxy projects responses. */
export function parseProxyProjectsResponse(raw: unknown): ProxyProjectsView {
  const object = (item: unknown): item is Record<string, any> => !!item && typeof item === 'object' && !Array.isArray(item)
  const bad = (): never => { throw new Error('invalid_proxy_projects') }
  const hash = (item: unknown): string => typeof item === 'string' && /^[0-9a-f]{64}$/.test(item) ? item : bad()
  const safeText = (item: unknown, max: number): string => typeof item === 'string' && item.length <= max && !/[\u0000-\u001f\u007f<>]/.test(item) ? item : bad()
  if (!object(raw) || !['default', 'saved', 'invalid'].includes(raw.state) || !Array.isArray(raw.projects)) return bad()
  const revision = hash(raw.revision)
  const limit = Number.isSafeInteger(raw.limit) ? raw.limit as number : bad()
  const runtimePorts = Array.isArray(raw.runtimePorts) && raw.runtimePorts.every((p: unknown) => Number.isSafeInteger(p)) ? raw.runtimePorts as number[] : []
  const parseProject = (entry: unknown): ProxyProjectItem => {
    if (!object(entry) || typeof entry.id !== 'string' || typeof entry.accountId !== 'string' || !Array.isArray(entry.domains)
      || !object(entry.ssl) || typeof entry.ssl.enabled !== 'boolean' || typeof entry.cache !== 'boolean' || typeof entry.gzip !== 'boolean' || !Array.isArray(entry.rules)) return bad()
    const rules = entry.rules.map((rule: unknown) => {
      if (!object(rule) || typeof rule.id !== 'string' || typeof rule.websocket !== 'boolean' || !['client', 'upstream'].includes(rule.hostHeader)) return bad()
      return { id: rule.id, path: safeText(rule.path, 255), target: safeText(rule.target, 512), websocket: rule.websocket, hostHeader: rule.hostHeader as 'client' | 'upstream' }
    })
    return {
      id: entry.id,
      accountId: entry.accountId,
      name: safeText(entry.name, 64),
      domains: entry.domains.map((d: unknown) => safeText(d, 253)),
      note: safeText(entry.note ?? '', 256),
      ssl: { enabled: entry.ssl.enabled, certificateId: typeof entry.ssl.certificateId === 'string' ? entry.ssl.certificateId : null },
      cache: entry.cache,
      gzip: entry.gzip,
      rules,
    }
  }
  const projects = raw.projects.map(parseProject)
  return {
    state: raw.state,
    revision,
    limit,
    runtimePorts,
    projects,
    ...(raw.project !== undefined ? { project: parseProject(raw.project) } : {}),
    reconcile: typeof raw.reconcile === 'string' ? raw.reconcile : null,
  }
}

function bindAccountProxyProjects(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const errorMessages: Record<string, string> = {
    invalid: t('Enter an http:// or https:// target host and optional port without a path or query.'),
    loopback: t('Loopback targets are blocked unless pointing to an owned runtime port.'),
    private_address: t('Private network IP addresses are not available.'),
    forbidden_range: t('Link-local, multicast, and metadata addresses are blocked.'),
    panel_port: t('Panel, SSH, and web backend ports cannot be used as proxy targets.'),
    own_address: t('Server and account public addresses cannot be proxied back to themselves.'),
    resolver_unavailable: t('Named hosts require a server DNS resolver; use an IP address.'),
    unresolved: t('Target host name could not be resolved.'),
    resolves_internal: t('Target host name resolves to an internal or restricted address.'),
    duplicate: t('This path already has a proxy rule.'),
    too_many: t('The maximum number of rules has been reached.'),
    last_proxy_rule: t('A proxy project must keep at least one proxy rule.'),
    nginx_config_test_failed: t('Nginx configuration test failed; the previous configuration was kept.'),
  }
  const errorDetail = (err: unknown): { code: string | null; reason: string | null; status: number } => {
    const obj = err && typeof err === 'object' ? err as Record<string, any> : {}
    const details = obj.details && typeof obj.details === 'object' ? obj.details : obj.detail && typeof obj.detail === 'object' ? obj.detail : {}
    const firstField = Array.isArray(details.fields) ? details.fields[0] : null
    return {
      code: firstField && typeof firstField.code === 'string' ? firstField.code : null,
      reason: typeof details.reason === 'string' ? details.reason : null,
      status: Number(obj.status) || 0,
    }
  }
  const formatError = (err: unknown, fallback: string): string => {
    const info = errorDetail(err)
    if (info.reason === 'LAST_PROXY_RULE' || info.code === 'last_proxy_rule') return errorMessages.last_proxy_rule!
    if (info.reason === 'nginx_config_test_failed') return errorMessages.nginx_config_test_failed!
    if (info.code && Object.hasOwn(errorMessages, info.code)) return errorMessages[info.code]!
    if (info.status === 409) return t('The saved configuration changed elsewhere. Read again before trying again.')
    return fallback
  }

  document.querySelectorAll<HTMLElement>('[data-site-proxy-rules]').forEach(root => {
    if (root.dataset.sprBound === 'true') return
    root.dataset.sprBound = 'true'
    const transport = frameRequest(root)
    const domain = root.querySelector<HTMLSelectElement>('[data-spr-domain]')
    const pathInput = root.querySelector<HTMLInputElement>('[data-spr-path]')
    const targetInput = root.querySelector<HTMLInputElement>('[data-spr-target]')
    const hostSelect = root.querySelector<HTMLSelectElement>('[data-spr-host]')
    const wsCheck = root.querySelector<HTMLInputElement>('[data-spr-websocket]')
    const addBtn = root.querySelector<HTMLButtonElement>('[data-spr-add]')
    const refreshBtn = root.querySelector<HTMLButtonElement>('[data-spr-refresh]')
    const status = root.querySelector<HTMLElement>('[data-spr-status]')
    const errorEl = root.querySelector<HTMLElement>('[data-spr-error]')
    const rows = root.querySelector<HTMLElement>('[data-spr-rows]')
    if (!domain || !pathInput || !targetInput || !hostSelect || !wsCheck || !addBtn || !refreshBtn || !status || !errorEl || !rows) return

    let rowTemplate: HTMLTemplateElement, emptyTemplate: HTMLTemplateElement
    try {
      rowTemplate = clientTemplate(root, 'site-proxy-rule-row')
      emptyTemplate = clientTemplate(root, 'site-proxy-rule-empty')
      cloneClientTemplate(rowTemplate, 'tr', ['domain', 'path', 'target', 'host', 'websocket', 'remove'])
      cloneClientTemplate(emptyTemplate, 'tr', ['message'])
    } catch { return }

    let view: SiteProxyRulesView | null = null
    let busy = false
    const eligible = (): boolean => root.isConnected && typeof transport === 'function' && root.dataset.sprManage === 'true'
      && !root.closest('[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled')
    const note = (state: string, msg: string): void => {
      status.dataset.state = state
      status.textContent = msg
      status.setAttribute('role', state === 'failed' || state === 'fields' ? 'alert' : 'status')
    }
    const setFieldError = (msg: string): void => { errorEl.textContent = msg; errorEl.hidden = !msg }
    const lock = (): void => {
      const active = eligible() && !busy && view !== null && view.state !== 'invalid'
      domain.disabled = !active || view!.domains.filter(d => !d.blocked).length === 0
      pathInput.disabled = targetInput.disabled = hostSelect.disabled = wsCheck.disabled = addBtn.disabled = !active
      refreshBtn.disabled = !eligible() || busy
      rows.querySelectorAll<HTMLButtonElement>('button').forEach(btn => { btn.disabled = !active })
      root.setAttribute('aria-busy', String(busy))
    }
    const paint = (next: SiteProxyRulesView): void => {
      view = next
      const keep = domain.value
      domain.textContent = ''
      const firstOpt = document.createElement('option'); firstOpt.value = ''; firstOpt.textContent = t('Select a domain'); domain.append(firstOpt)
      for (const item of next.domains.filter(d => !d.blocked)) {
        const opt = document.createElement('option'); opt.value = item.id; opt.textContent = item.name; domain.append(opt)
      }
      if (next.domains.some(d => !d.blocked && d.id === keep)) domain.value = keep
      else if (next.domains.some(d => !d.blocked)) domain.value = next.domains.find(d => !d.blocked)!.id

      rows.textContent = ''
      for (const rule of next.rules) {
        const tr = cloneClientTemplate(rowTemplate, 'tr', ['domain', 'path', 'target', 'host', 'websocket', 'remove'])
        clientTemplateSlot(tr, 'domain').textContent = rule.domain
        clientTemplateSlot(tr, 'path').textContent = rule.path
        clientTemplateSlot(tr, 'target').textContent = rule.target
        clientTemplateSlot(tr, 'host').textContent = rule.hostHeader === 'upstream' ? t('Target host') : t('Visitor host')
        clientTemplateSlot(tr, 'websocket').textContent = rule.websocket ? t('Yes') : t('No')
        const removeBtn = clientTemplateSlot(tr, 'remove', 'button') as HTMLButtonElement
        removeBtn.addEventListener('click', () => { if (!removeBtn.disabled) void removeRule(rule) })
        rows.append(tr)
      }
      if (!next.rules.length) {
        const tr = cloneClientTemplate(emptyTemplate, 'tr', ['message'])
        clientTemplateSlot(tr, 'message', 'td').textContent = t('No path-scoped proxy rules saved.')
        rows.append(tr)
      }
      lock()
    }
    const load = async (): Promise<void> => {
      if (!eligible() || busy) return
      busy = true; setFieldError(''); lock(); note('reading', t('Reading path-scoped proxy rules…'))
      try {
        paint(parseSiteProxyRulesResponse(await transport!('GET', '/api/account/domains/proxy-rules')))
        note('read', t('Path-scoped proxy rules read.'))
      } catch {
        note('failed', t('Path-scoped proxy rules could not be read.'))
      } finally { busy = false; lock() }
    }
    const addRule = async (): Promise<void> => {
      if (!eligible() || busy || !view || !domain.value) return
      const rawPath = pathInput.value.trim()
      const normPath = rawPath.length > 1 && rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath
      if (!PATH_PATTERN.test(normPath)) { setFieldError(t('Enter a valid path starting with / (for example /api).')); return }
      const targetVal = targetInput.value.trim()
      if (proxyTargetDraftProblem(targetVal)) { setFieldError(errorMessages.invalid!); return }
      setFieldError('')
      if (typeof askDialog === 'function') {
        const approved = await askDialog({ title: t('Save path-scoped proxy rule?'), body: normPath + ' -> ' + targetVal, confirm: t('Save rule') }).catch(() => false)
        if (approved !== true) return
      }
      busy = true; lock(); note('saving', t('Verifying and saving proxy rule…'))
      try {
        const saved = parseSiteProxyRulesResponse(await transport!('POST', '/api/account/domains/proxy-rules', {
          expectedRevision: view.revision,
          domainId: domain.value,
          path: normPath,
          target: targetVal,
          hostHeader: hostSelect.value === 'upstream' ? 'upstream' : 'client',
          websocket: wsCheck.checked,
        }))
        pathInput.value = ''; targetInput.value = ''
        paint(saved)
        note('saved', t('Proxy rule saved and verified.'))
      } catch (err) {
        const msg = formatError(err, t('Proxy rule was refused. Nothing was changed.'))
        setFieldError(msg); note('fields', msg)
      } finally { busy = false; lock() }
    }
    const removeRule = async (rule: SiteProxyRuleItem): Promise<void> => {
      if (!eligible() || busy || !view) return
      if (typeof askDialog === 'function') {
        const approved = await askDialog({ title: t('Remove path-scoped proxy rule?'), body: rule.domain + rule.path, danger: true, confirm: t('Remove') }).catch(() => false)
        if (approved !== true) return
      }
      busy = true; setFieldError(''); lock(); note('saving', t('Removing proxy rule…'))
      try {
        const next = parseSiteProxyRulesResponse(await transport!('DELETE', '/api/account/domains/proxy-rules', {
          expectedRevision: view.revision,
          domain: rule.domain,
          path: rule.path,
        }))
        paint(next)
        note('saved', t('Proxy rule removed.'))
      } catch (err) {
        const msg = formatError(err, t('Proxy rule removal failed.'))
        setFieldError(msg); note('failed', msg)
      } finally { busy = false; lock() }
    }

    if (!eligible()) {
      root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button,input,select').forEach(el => { el.disabled = true })
      note('unavailable', t('Path-scoped proxy rules are unavailable here.'))
      return
    }
    addBtn.addEventListener('click', () => { void addRule() })
    refreshBtn.addEventListener('click', () => { void load() })
    lock(); void load()
  })

  document.querySelectorAll<HTMLElement>('[data-proxy-projects]').forEach(root => {
    if (root.dataset.ppBound === 'true') return
    root.dataset.ppBound = 'true'
    const transport = frameRequest(root)
    const rows = root.querySelector<HTMLElement>('[data-pp-rows]')
    const ruleRows = root.querySelector<HTMLElement>('[data-pp-rule-rows]')
    const nameInput = root.querySelector<HTMLInputElement>('[data-pp-name]')
    const domainsInput = root.querySelector<HTMLInputElement>('[data-pp-domains]')
    const pathInput = root.querySelector<HTMLInputElement>('[data-pp-path]')
    const targetInput = root.querySelector<HTMLInputElement>('[data-pp-target]')
    const hostSelect = root.querySelector<HTMLSelectElement>('[data-pp-host]')
    const noteInput = root.querySelector<HTMLInputElement>('[data-pp-note]')
    const wsCheck = root.querySelector<HTMLInputElement>('[data-pp-websocket]')
    const cacheCheck = root.querySelector<HTMLInputElement>('[data-pp-cache]')
    const gzipCheck = root.querySelector<HTMLInputElement>('[data-pp-gzip]')
    const sslCheck = root.querySelector<HTMLInputElement>('[data-pp-ssl]')
    const saveBtn = root.querySelector<HTMLButtonElement>('[data-pp-save]')
    const addRuleBtn = root.querySelector<HTMLButtonElement>('[data-pp-add-rule]')
    const cancelBtn = root.querySelector<HTMLButtonElement>('[data-pp-cancel]')
    const refreshBtn = root.querySelector<HTMLButtonElement>('[data-pp-refresh]')
    const status = root.querySelector<HTMLElement>('[data-pp-status]')
    const errorEl = root.querySelector<HTMLElement>('[data-pp-error]')
    if (!rows || !ruleRows || !nameInput || !domainsInput || !pathInput || !targetInput || !hostSelect || !noteInput
      || !wsCheck || !cacheCheck || !gzipCheck || !sslCheck || !saveBtn || !addRuleBtn || !cancelBtn || !refreshBtn || !status || !errorEl) return

    let projectRowTpl: HTMLTemplateElement, projectEmptyTpl: HTMLTemplateElement, ruleRowTpl: HTMLTemplateElement, ruleEmptyTpl: HTMLTemplateElement
    try {
      projectRowTpl = clientTemplate(root, 'proxy-project-row')
      projectEmptyTpl = clientTemplate(root, 'proxy-project-empty')
      ruleRowTpl = clientTemplate(root, 'proxy-project-rule-row')
      ruleEmptyTpl = clientTemplate(root, 'proxy-project-rule-empty')
      cloneClientTemplate(projectRowTpl, 'tr', ['name', 'domains', 'rules', 'options', 'note', 'select', 'remove'])
      cloneClientTemplate(projectEmptyTpl, 'tr', ['message'])
      cloneClientTemplate(ruleRowTpl, 'tr', ['path', 'target', 'host', 'websocket', 'remove'])
      cloneClientTemplate(ruleEmptyTpl, 'tr', ['message'])
    } catch { return }

    let view: ProxyProjectsView | null = null
    let selectedId: string | null = null
    let busy = false
    const eligible = (): boolean => root.isConnected && typeof transport === 'function' && root.dataset.ppManage === 'true'
      && !root.closest('[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled')
    const selectedProject = (): ProxyProjectItem | undefined => view?.projects.find(item => item.id === selectedId)
    const note = (state: string, msg: string): void => {
      status.dataset.state = state
      status.textContent = msg
      status.setAttribute('role', state === 'failed' || state === 'fields' ? 'alert' : 'status')
    }
    const setFieldError = (msg: string): void => { errorEl.textContent = msg; errorEl.hidden = !msg }
    const fillSelected = (): void => {
      const current = selectedProject()
      if (current) {
        nameInput.value = current.name
        domainsInput.value = current.domains.join(', ')
        noteInput.value = current.note
        cacheCheck.checked = current.cache
        gzipCheck.checked = current.gzip
        sslCheck.checked = current.ssl.enabled
        saveBtn.textContent = t('Update project')
      } else {
        nameInput.value = ''; domainsInput.value = ''; noteInput.value = ''
        cacheCheck.checked = true; gzipCheck.checked = true; sslCheck.checked = false
        saveBtn.textContent = t('Create proxy project')
      }
      ruleRows.textContent = ''
      if (current) {
        for (const rule of current.rules) {
          const tr = cloneClientTemplate(ruleRowTpl, 'tr', ['path', 'target', 'host', 'websocket', 'remove'])
          clientTemplateSlot(tr, 'path').textContent = rule.path
          clientTemplateSlot(tr, 'target').textContent = rule.target
          clientTemplateSlot(tr, 'host').textContent = rule.hostHeader === 'upstream' ? t('Target host') : t('Visitor host')
          clientTemplateSlot(tr, 'websocket').textContent = rule.websocket ? t('Yes') : t('No')
          const rem = clientTemplateSlot(tr, 'remove', 'button') as HTMLButtonElement
          rem.addEventListener('click', () => { if (!rem.disabled) void removeProjectRule(current, rule) })
          ruleRows.append(tr)
        }
      } else {
        const tr = cloneClientTemplate(ruleEmptyTpl, 'tr', ['message'])
        clientTemplateSlot(tr, 'message', 'td').textContent = t('Select a proxy project to manage its rules.')
        ruleRows.append(tr)
      }
    }
    const lock = (): void => {
      const active = eligible() && !busy && view !== null && view.state !== 'invalid'
      const hasSelected = !!selectedProject()
      for (const el of [nameInput, domainsInput, pathInput, targetInput, hostSelect, noteInput, wsCheck, cacheCheck, gzipCheck, sslCheck, saveBtn]) {
        el.disabled = !active
      }
      addRuleBtn.disabled = !active || !hasSelected
      cancelBtn.disabled = !active || !hasSelected
      refreshBtn.disabled = !eligible() || busy
      rows.querySelectorAll<HTMLButtonElement>('button').forEach(btn => { btn.disabled = !active })
      ruleRows.querySelectorAll<HTMLButtonElement>('button').forEach(btn => { btn.disabled = !active })
      root.setAttribute('aria-busy', String(busy))
    }
    const paint = (next: ProxyProjectsView): void => {
      view = next
      if (selectedId && !next.projects.some(p => p.id === selectedId)) selectedId = null
      rows.textContent = ''
      for (const project of next.projects) {
        const tr = cloneClientTemplate(projectRowTpl, 'tr', ['name', 'domains', 'rules', 'options', 'note', 'select', 'remove'])
        clientTemplateSlot(tr, 'name').textContent = project.name
        clientTemplateSlot(tr, 'domains').textContent = project.domains.join(', ')
        clientTemplateSlot(tr, 'rules').textContent = String(project.rules.length)
        clientTemplateSlot(tr, 'options').textContent = [project.cache ? t('Cache') : '', project.gzip ? 'Gzip' : '', project.ssl.enabled ? 'SSL' : ''].filter(Boolean).join(', ') || t('Basic')
        clientTemplateSlot(tr, 'note').textContent = project.note || '-'
        const selBtn = clientTemplateSlot(tr, 'select', 'button') as HTMLButtonElement
        selBtn.addEventListener('click', () => { selectedId = project.id; setFieldError(''); fillSelected(); lock() })
        const delBtn = clientTemplateSlot(tr, 'remove', 'button') as HTMLButtonElement
        delBtn.addEventListener('click', () => { void deleteProject(project) })
        rows.append(tr)
      }
      if (!next.projects.length) {
        const tr = cloneClientTemplate(projectEmptyTpl, 'tr', ['message'])
        clientTemplateSlot(tr, 'message', 'td').textContent = t('No standalone proxy projects created.')
        rows.append(tr)
      }
      fillSelected(); lock()
    }
    const load = async (): Promise<void> => {
      if (!eligible() || busy) return
      busy = true; setFieldError(''); lock(); note('reading', t('Reading proxy projects…'))
      try {
        paint(parseProxyProjectsResponse(await transport!('GET', '/api/account/proxy-projects')))
        note('read', t('Proxy projects read.'))
      } catch {
        note('failed', t('Proxy projects could not be read.'))
      } finally { busy = false; lock() }
    }
    const saveProject = async (): Promise<void> => {
      if (!eligible() || busy || !view) return
      const name = nameInput.value.trim()
      const domains = domainsInput.value.split(/[\s,]+/).map(item => item.trim().toLowerCase()).filter(Boolean)
      if (!name || !domains.length) { setFieldError(t('Project name and at least one domain are required.')); return }
      const current = selectedProject()
      if (!current) {
        const rawPath = pathInput.value.trim() || '/'
        const normPath = rawPath.length > 1 && rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath
        const targetVal = targetInput.value.trim()
        if (!PATH_PATTERN.test(normPath)) { setFieldError(t('Enter a valid path starting with /.')); return }
        if (proxyTargetDraftProblem(targetVal)) { setFieldError(errorMessages.invalid!); return }
        setFieldError('')
        if (typeof askDialog === 'function') {
          const ok = await askDialog({ title: t('Create proxy project?'), body: name + ' (' + domains.join(', ') + ') -> ' + targetVal, confirm: t('Create project') }).catch(() => false)
          if (ok !== true) return
        }
        busy = true; lock(); note('saving', t('Creating and verifying proxy project…'))
        try {
          const saved = parseProxyProjectsResponse(await transport!('POST', '/api/account/proxy-projects', {
            expectedRevision: view.revision,
            name,
            domains,
            path: normPath,
            target: targetVal,
            hostHeader: hostSelect.value === 'upstream' ? 'upstream' : 'client',
            websocket: wsCheck.checked,
            cache: cacheCheck.checked,
            gzip: gzipCheck.checked,
            ssl: sslCheck.checked,
            note: noteInput.value.trim(),
          }))
          if (saved.project) selectedId = saved.project.id
          paint(saved)
          note('saved', t('Proxy project created and verified.'))
        } catch (err) {
          const msg = formatError(err, t('Proxy project creation failed.'))
          setFieldError(msg); note('fields', msg)
        } finally { busy = false; lock() }
        return
      }
      setFieldError('')
      busy = true; lock(); note('saving', t('Updating proxy project…'))
      try {
        const saved = parseProxyProjectsResponse(await transport!('PUT', '/api/account/proxy-projects/' + encodeURIComponent(current.id), {
          expectedRevision: view.revision,
          name,
          domains,
          cache: cacheCheck.checked,
          gzip: gzipCheck.checked,
          ssl: sslCheck.checked,
          note: noteInput.value.trim(),
        }))
        paint(saved)
        note('saved', t('Proxy project updated.'))
      } catch (err) {
        const msg = formatError(err, t('Proxy project update failed.'))
        setFieldError(msg); note('fields', msg)
      } finally { busy = false; lock() }
    }
    const addProjectRule = async (): Promise<void> => {
      const current = selectedProject()
      if (!eligible() || busy || !view || !current) return
      const rawPath = pathInput.value.trim()
      const normPath = rawPath.length > 1 && rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath
      const targetVal = targetInput.value.trim()
      if (!PATH_PATTERN.test(normPath)) { setFieldError(t('Enter a valid path starting with /.')); return }
      if (proxyTargetDraftProblem(targetVal)) { setFieldError(errorMessages.invalid!); return }
      setFieldError('')
      busy = true; lock(); note('saving', t('Adding rule to proxy project…'))
      try {
        const saved = parseProxyProjectsResponse(await transport!('POST', '/api/account/proxy-projects/' + encodeURIComponent(current.id) + '/rules', {
          expectedRevision: view.revision,
          path: normPath,
          target: targetVal,
          hostHeader: hostSelect.value === 'upstream' ? 'upstream' : 'client',
          websocket: wsCheck.checked,
        }))
        pathInput.value = '/'; targetInput.value = ''
        paint(saved)
        note('saved', t('Rule added to proxy project.'))
      } catch (err) {
        const msg = formatError(err, t('Adding rule to proxy project failed.'))
        setFieldError(msg); note('fields', msg)
      } finally { busy = false; lock() }
    }
    const removeProjectRule = async (project: ProxyProjectItem, rule: ProxyProjectRuleItem): Promise<void> => {
      if (!eligible() || busy || !view) return
      if (typeof askDialog === 'function') {
        const ok = await askDialog({ title: t('Remove rule from project?'), body: project.name + ' · ' + rule.path, danger: true, confirm: t('Remove') }).catch(() => false)
        if (ok !== true) return
      }
      busy = true; setFieldError(''); lock(); note('saving', t('Removing rule from proxy project…'))
      try {
        const saved = parseProxyProjectsResponse(await transport!('DELETE', '/api/account/proxy-projects/' + encodeURIComponent(project.id) + '/rules', {
          expectedRevision: view.revision,
          path: rule.path,
        }))
        paint(saved)
        note('saved', t('Rule removed from proxy project.'))
      } catch (err) {
        const msg = formatError(err, t('Rule removal failed.'))
        setFieldError(msg); note('failed', msg)
      } finally { busy = false; lock() }
    }
    const deleteProject = async (project: ProxyProjectItem): Promise<void> => {
      if (!eligible() || busy || !view) return
      if (typeof askDialog === 'function') {
        const ok = await askDialog({ title: t('Delete proxy project?'), body: project.name, danger: true, confirm: t('Delete') }).catch(() => false)
        if (ok !== true) return
      }
      busy = true; setFieldError(''); lock(); note('saving', t('Deleting proxy project…'))
      try {
        const saved = parseProxyProjectsResponse(await transport!('DELETE', '/api/account/proxy-projects/' + encodeURIComponent(project.id), {
          expectedRevision: view.revision,
        }))
        if (selectedId === project.id) selectedId = null
        paint(saved)
        note('saved', t('Proxy project deleted.'))
      } catch (err) {
        const msg = formatError(err, t('Proxy project deletion failed.'))
        setFieldError(msg); note('failed', msg)
      } finally { busy = false; lock() }
    }

    if (!eligible()) {
      root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button,input,select').forEach(el => { el.disabled = true })
      note('unavailable', t('Proxy projects are unavailable here.'))
      return
    }
    saveBtn.addEventListener('click', () => { void saveProject() })
    addRuleBtn.addEventListener('click', () => { void addProjectRule() })
    cancelBtn.addEventListener('click', () => { selectedId = null; setFieldError(''); fillSelected(); lock() })
    refreshBtn.addEventListener('click', () => { void load() })
    lock(); void load()
  })
}

export const ACCOUNT_PROXY_PROJECTS_CLIENT_BINDING = withFrameRequest(`(()=>{const clientTemplate=${clientTemplate.toString()};const clientTemplateSlot=${clientTemplateSlot.toString()};const cloneClientTemplate=${cloneClientTemplate.toString()};const TARGET_PATTERN=${TARGET_PATTERN.toString()};const PATH_PATTERN=${PATH_PATTERN.toString()};const proxyTargetDraftProblem=${proxyTargetDraftProblem.toString()};const parseSiteProxyRulesResponse=${parseSiteProxyRulesResponse.toString()};const parseProxyProjectsResponse=${parseProxyProjectsResponse.toString()};return ${bindAccountProxyProjects.toString()};})()`)
